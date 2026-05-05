"""Engine: hydrate, optionally call a provider, apply output policy.

Wraps :class:`promptlibretto.registry.model.Registry` with:

* ``hydrate(...)`` → final prompt string (no LLM).
* ``run(...)`` → hydrate + provider call + clean/validate against
  :class:`OutputPolicy`. Returns :class:`GenerationResult`.
* ``stream(...)`` → async iterator yielding :class:`GenerationChunk` for
  providers that implement ``StreamingProviderAdapter``.

Routes (optional) override ``assembly_order`` / ``generation`` /
``output_policy`` per call.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Mapping, Optional, Union

from ..config import GenerationConfig
from ..output.processor import OutputPolicy, OutputProcessor, ProcessingContext
from ..providers.base import (
    ProviderAdapter,
    ProviderMessage,
    ProviderRequest,
    supports_streaming,
)
from ..providers.mock import MockProvider
from .hydrate import hydrate
from .model import Registry
from .state import RegistryState



# ── Result types ─────────────────────────────────────────────────


@dataclass
class GenerationResult:
    text: str
    accepted: bool
    prompt: str
    route: Optional[str] = None
    reason: Optional[str] = None
    usage: Optional[dict] = None
    timing: Optional[dict] = None
    raw: Any = None


@dataclass
class GenerationChunk:
    delta: str = ""
    done: bool = False
    result: Optional[GenerationResult] = None


# ── Helpers ──────────────────────────────────────────────────────


def _coerce_state(
    state: Union[RegistryState, Mapping[str, Any], None],
) -> RegistryState:
    if state is None:
        return RegistryState()
    if isinstance(state, RegistryState):
        return state
    return RegistryState.from_dict(dict(state))


def _coerce_provider(provider: Any) -> ProviderAdapter:
    if provider is None or (isinstance(provider, str) and provider.lower() == "mock"):
        return MockProvider()
    if isinstance(provider, str):
        raise ValueError(
            f"unknown provider {provider!r}; pass a ProviderAdapter instance"
        )
    return provider


def _coerce_config(
    base: Mapping[str, Any], overrides: Optional[Mapping[str, Any]] = None
) -> GenerationConfig:
    cfg = GenerationConfig().merged_with(base or None)
    return cfg.merged_with(overrides or None)


def _build_policy(
    base: Mapping[str, Any], overrides: Optional[Mapping[str, Any]] = None
) -> OutputPolicy:
    p = OutputPolicy().merged_with(base or None)
    return p.merged_with(overrides or None)


def _build_request(
    cfg: GenerationConfig, prompt: str
) -> ProviderRequest:
    return ProviderRequest(
        model=cfg.model,
        messages=[ProviderMessage(role="user", content=prompt)],
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
        top_p=cfg.top_p,
        top_k=cfg.top_k,
        repeat_penalty=cfg.repeat_penalty,
        timeout_ms=cfg.timeout_ms,
    )


# ── Engine ───────────────────────────────────────────────────────


class Engine:
    """Runtime for a :class:`Registry`."""

    def __init__(
        self,
        registry: Union[Registry, Mapping[str, Any], None] = None,
        provider: Union[ProviderAdapter, str, None] = None,
        output_processor: Optional[OutputProcessor] = None,
    ) -> None:
        if registry is None:
            registry = Registry()
        elif isinstance(registry, Mapping):
            registry = Registry.from_dict(dict(registry))
        self.registry: Registry = registry
        self.provider: ProviderAdapter = _coerce_provider(provider)
        self._output = output_processor or OutputProcessor()

    # ── Hydrate (no LLM call) ─────────────────────────────────────

    def hydrate(
        self,
        state: Union[RegistryState, Mapping[str, Any], None] = None,
        *,
        route: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> str:
        return hydrate(
            self.registry, _coerce_state(state), route=route, seed=seed
        )

    # ── Run (hydrate + provider + policy) ─────────────────────────

    async def run(
        self,
        state: Union[RegistryState, Mapping[str, Any], None] = None,
        *,
        route: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> GenerationResult:
        prompt = self.hydrate(state, route=route, seed=seed)
        cfg, policy = self._cfg_policy_for(route)
        request = _build_request(cfg, prompt)
        ctx = ProcessingContext(
            route=route or "default", user_prompt=prompt
        )

        last_reason: Optional[str] = None
        last_text = ""
        usage = None
        timing = None
        raw = None
        for _ in range(max(1, cfg.retries)):
            t0 = time.perf_counter()
            response = await self.provider.generate(request)
            timing = {
                "total_ms": (time.perf_counter() - t0) * 1000,
                **(response.timing.__dict__ if response.timing else {}),
            }
            usage = response.usage.__dict__ if response.usage else None
            raw = response.raw
            cleaned = self._output.clean(response.text, ctx, policy)
            check = self._output.validate(cleaned, ctx, policy)
            if check.ok:
                return GenerationResult(
                    text=cleaned,
                    accepted=True,
                    prompt=prompt,
                    route=route,
                    usage=usage,
                    timing=timing,
                    raw=raw,
                )
            last_text = cleaned
            last_reason = check.reason
        return GenerationResult(
            text=last_text,
            accepted=False,
            prompt=prompt,
            route=route,
            reason=last_reason,
            usage=usage,
            timing=timing,
            raw=raw,
        )

    # ── Stream (provider must implement StreamingProviderAdapter) ─

    async def stream(
        self,
        state: Union[RegistryState, Mapping[str, Any], None] = None,
        *,
        route: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> AsyncIterator[GenerationChunk]:
        if not supports_streaming(self.provider):
            raise RuntimeError(
                f"provider {type(self.provider).__name__} does not support streaming"
            )
        prompt = self.hydrate(state, route=route, seed=seed)
        cfg, policy = self._cfg_policy_for(route)
        request = _build_request(cfg, prompt)
        ctx = ProcessingContext(
            route=route or "default", user_prompt=prompt
        )

        accumulated = ""
        usage = None
        timing = None
        raw = None
        async for chunk in self.provider.stream(request):  # type: ignore[attr-defined]
            if chunk.text:
                accumulated += chunk.text
                yield GenerationChunk(delta=chunk.text)
            if chunk.done:
                if chunk.response:
                    usage = chunk.response.usage.__dict__ if chunk.response.usage else None
                    timing = (
                        chunk.response.timing.__dict__ if chunk.response.timing else None
                    )
                    raw = chunk.response.raw
                cleaned = self._output.clean(accumulated, ctx, policy)
                check = self._output.validate(cleaned, ctx, policy)
                yield GenerationChunk(
                    done=True,
                    result=GenerationResult(
                        text=cleaned,
                        accepted=check.ok,
                        prompt=prompt,
                        route=route,
                        reason=None if check.ok else check.reason,
                        usage=usage,
                        timing=timing,
                        raw=raw,
                    ),
                )
                return

    # ── Internals ────────────────────────────────────────────────

    def _cfg_policy_for(
        self, route: Optional[str]
    ) -> tuple[GenerationConfig, OutputPolicy]:
        gen = dict(self.registry.generation)
        pol = dict(self.registry.output_policy)
        if route and route in self.registry.routes:
            r = self.registry.routes[route]
            gen.update(r.generation)
            pol.update(r.output_policy)
        return _coerce_config(gen), _build_policy(pol)
