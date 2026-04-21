from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import AsyncIterator, Optional, Sequence

from ..assets.registry import PromptAssetRegistry, PromptInjection
from ..builders.builder import BuildContext, GenerationRequest, PromptPackage
from ..config import GenerationConfig
from ..context.store import ContextStore
from ..output.history import RunHistory, RunRecord
from ..output.memory import RecentOutputMemory
from ..output.processor import OutputProcessor, ProcessingContext
from ..providers.base import (
    ProviderAdapter,
    ProviderMessage,
    ProviderRequest,
    ProviderResponse,
    supports_streaming,
)
from ..random_source import DefaultRandom, RandomSource
from ..routing.router import PromptRouter
from .middleware import apply_after, apply_before
from .trace import GenerationAttempt, GenerationTrace


@dataclass
class GenerationResult:
    text: str
    accepted: bool
    route: str
    trace: Optional[GenerationTrace] = None
    usage: Optional[dict] = None
    timing: Optional[dict] = None


@dataclass
class GenerationChunk:
    """Single event from `PromptEngine.generate_stream`.

    Intermediate events carry a `delta` text. The terminal event has
    `done=True` and a fully-populated `result` so callers can pick up
    `accepted`, `route`, and optionally the trace without doing a second
    non-streaming round.
    """

    delta: str = ""
    done: bool = False
    result: Optional[GenerationResult] = None


class PromptEngine:
    """The single entry point for the library.

    All generation goes through `generate_once`. Schedulers loop on this; debug
    steppers call it once. They share the same code path, which is the design
    document's core requirement.
    """

    def __init__(
        self,
        config: GenerationConfig,
        context_store: ContextStore,
        asset_registry: PromptAssetRegistry,
        router: PromptRouter,
        provider: ProviderAdapter,
        output_processor: Optional[OutputProcessor] = None,
        recent_memory: Optional[RecentOutputMemory] = None,
        run_history: Optional[RunHistory] = None,
        random: Optional[RandomSource] = None,
        middlewares: Optional[Sequence[object]] = None,
    ):
        self.config = config
        self.context_store = context_store
        self.asset_registry = asset_registry
        self.router = router
        self.provider = provider
        self.output_processor = output_processor or OutputProcessor()
        self.recent_memory = recent_memory
        self.run_history = run_history
        self.random = random or DefaultRandom()
        self.middlewares: list[object] = list(middlewares or [])

    def update_config(self, config: GenerationConfig) -> None:
        self.config = config

    def add_middleware(self, middleware: object) -> None:
        self.middlewares.append(middleware)

    async def generate_once(self, request: GenerationRequest) -> GenerationResult:
        if self.middlewares:
            request = await apply_before(self.middlewares, request)
        result = await self._generate_core(request)
        if self.middlewares:
            result = await apply_after(self.middlewares, request, result)
        return result

    async def _generate_core(self, request: GenerationRequest) -> GenerationResult:
        snapshot = self.context_store.get_state()
        injections = self._materialize_injections(request.injections)

        route = self.router.select(snapshot, request)
        package, snapshot, merged_config, config_layers, trim_info = self._build_with_budget(
            route, request, snapshot, injections
        )
        policy = self.output_processor.policy_for(package.output_policy)

        attempts: list[GenerationAttempt] = []
        provider_response: Optional[ProviderResponse] = None
        final_text = ""
        accepted = False
        reject_reason: Optional[str] = None

        retries = max(0, merged_config.retries)
        for attempt_idx in range(retries + 1):
            provider_response = await self._call_provider(package, merged_config)
            raw = provider_response.text
            ctx = ProcessingContext(
                route=route.name,
                user_prompt=package.user,
                recent=self.recent_memory,
                metadata=dict(package.metadata),
            )
            cleaned = self.output_processor.clean(raw, ctx, policy)
            result = self.output_processor.validate(cleaned, ctx, policy)
            attempts.append(
                GenerationAttempt(
                    raw=raw,
                    cleaned=cleaned,
                    accepted=result.ok,
                    reject_reason=result.reason,
                )
            )
            if result.ok:
                accepted = True
                final_text = cleaned
                if self.recent_memory is not None:
                    self.recent_memory.add(cleaned)
                break
            reject_reason = result.reason
            final_text = cleaned

        trace: Optional[GenerationTrace] = None
        if request.debug:
            trace = GenerationTrace(
                route=route.name,
                active_context=snapshot.active,
                user_prompt=package.user,
                system_prompt=package.system,
                injections=[i.name for i in injections],
                config=merged_config.to_dict(),
                output_raw=attempts[-1].raw if attempts else "",
                output_final=final_text,
                attempts=attempts,
                usage=asdict(provider_response.usage) if provider_response else None,
                timing=asdict(provider_response.timing) if provider_response else None,
                metadata={
                    "fields": snapshot.fields,
                    "overlays": {
                        n: {
                            "text": o.text,
                            "priority": o.priority,
                            "expires_at": o.expires_at,
                        }
                        for n, o in snapshot.overlays.items()
                    },
                    "package_metadata": dict(package.metadata),
                    "config_layers": config_layers,
                    "reject_reason": reject_reason if not accepted else None,
                    "budget": trim_info,
                },
            )

        if self.run_history is not None:
            self.run_history.add(
                RunRecord(
                    request=self._history_request(request),
                    text=final_text,
                    accepted=accepted,
                    route=route.name,
                    metadata={"resolved_config": merged_config.to_dict()},
                )
            )

        return GenerationResult(
            text=final_text,
            accepted=accepted,
            route=route.name,
            trace=trace,
            usage=asdict(provider_response.usage) if provider_response else None,
            timing=asdict(provider_response.timing) if provider_response else None,
        )

    async def generate_stream(
        self, request: GenerationRequest
    ) -> AsyncIterator[GenerationChunk]:
        """Stream a single generation, yielding text deltas and a final result.

        Streaming paths always make exactly one provider call — retries are
        skipped because replaying a stream mid-output is more surprising
        than useful. Callers that need retry semantics should fall back to
        `generate_once` when a chunk's terminal `result.accepted` is False.

        The provider must implement `stream`; if it doesn't, this raises.
        """
        if not supports_streaming(self.provider):
            raise RuntimeError(
                f"provider {type(self.provider).__name__} does not support streaming"
            )

        if self.middlewares:
            request = await apply_before(self.middlewares, request)

        snapshot = self.context_store.get_state()
        injections = self._materialize_injections(request.injections)
        route = self.router.select(snapshot, request)
        package, snapshot, merged_config, config_layers, trim_info = self._build_with_budget(
            route, request, snapshot, injections
        )
        policy = self.output_processor.policy_for(package.output_policy)

        provider_request = self._build_provider_request(package, merged_config)
        final_response: Optional[ProviderResponse] = None
        buffer = ""
        async for chunk in self.provider.stream(provider_request):
            if chunk.done:
                final_response = chunk.response
                break
            if chunk.text:
                buffer += chunk.text
                yield GenerationChunk(delta=chunk.text)

        raw = final_response.text if final_response else buffer
        ctx = ProcessingContext(
            route=route.name,
            user_prompt=package.user,
            recent=self.recent_memory,
            metadata=dict(package.metadata),
        )
        cleaned = self.output_processor.clean(raw, ctx, policy)
        validation = self.output_processor.validate(cleaned, ctx, policy)

        if validation.ok and self.recent_memory is not None:
            self.recent_memory.add(cleaned)

        trace: Optional[GenerationTrace] = None
        if request.debug:
            trace = GenerationTrace(
                route=route.name,
                active_context=snapshot.active,
                user_prompt=package.user,
                system_prompt=package.system,
                injections=[i.name for i in injections],
                config=merged_config.to_dict(),
                output_raw=raw,
                output_final=cleaned,
                attempts=[GenerationAttempt(
                    raw=raw, cleaned=cleaned,
                    accepted=validation.ok, reject_reason=validation.reason,
                )],
                usage=asdict(final_response.usage) if final_response else None,
                timing=asdict(final_response.timing) if final_response else None,
                metadata={
                    "fields": snapshot.fields,
                    "overlays": {
                        n: {"text": o.text, "priority": o.priority, "expires_at": o.expires_at}
                        for n, o in snapshot.overlays.items()
                    },
                    "package_metadata": dict(package.metadata),
                    "config_layers": config_layers,
                    "reject_reason": None if validation.ok else validation.reason,
                    "streamed": True,
                    "budget": trim_info,
                },
            )

        result = GenerationResult(
            text=cleaned,
            accepted=validation.ok,
            route=route.name,
            trace=trace,
            usage=asdict(final_response.usage) if final_response else None,
            timing=asdict(final_response.timing) if final_response else None,
        )

        if self.run_history is not None:
            self.run_history.add(
                RunRecord(
                    request=self._history_request(request),
                    text=cleaned,
                    accepted=validation.ok,
                    route=route.name,
                    metadata={
                        "resolved_config": merged_config.to_dict(),
                        "streamed": True,
                    },
                )
            )

        if self.middlewares:
            result = await apply_after(self.middlewares, request, result)

        yield GenerationChunk(done=True, result=result)

    # --- internals -----------------------------------------------------
    def _build_with_budget(
        self,
        route,
        request: GenerationRequest,
        snapshot,
        injections: list[PromptInjection],
    ):
        """Build the prompt package, trimming overlays if a char budget is set.

        Lowest-priority overlays are dropped first. Ties break by name so the
        result is deterministic. The returned `trim_info` dict is `None` when
        no budget is configured; otherwise it reports the final size, budget,
        and names dropped (empty list if none were needed).
        """
        def build(snap):
            ctx = BuildContext(
                snapshot=snap,
                request=request,
                assets=self.asset_registry,
                random=self.random,
                injections=injections,
            )
            pkg = route.builder.build(ctx)
            cfg = (
                self.config
                .merged_with(pkg.generation_overrides)
                .merged_with(request.config_overrides)
            )
            layers = {
                "base_config": self.config.to_dict(),
                "package_overrides": dict(pkg.generation_overrides or {}),
                "request_overrides": dict(request.config_overrides or {}),
                "resolved_config": cfg.to_dict(),
            }
            return pkg, cfg, layers

        package, merged_config, config_layers = build(snapshot)
        budget = merged_config.max_prompt_chars
        if budget is None or budget <= 0:
            return package, snapshot, merged_config, config_layers, None

        def size(pkg):
            return len(pkg.system or "") + len(pkg.user or "")

        dropped: list[str] = []
        current_snapshot = snapshot
        # Drop lowest-priority overlays one at a time until under budget.
        while size(package) > budget and current_snapshot.overlays:
            victim = min(
                current_snapshot.overlays.items(),
                key=lambda kv: (kv[1].priority, kv[0]),
            )[0]
            remaining = {n: o for n, o in current_snapshot.overlays.items() if n != victim}
            current_snapshot = current_snapshot.with_overlays(remaining)
            dropped.append(victim)
            package, merged_config, config_layers = build(current_snapshot)

        trim_info = {
            "budget_chars": budget,
            "final_chars": size(package),
            "dropped": dropped,
            "over_budget": size(package) > budget,
        }
        return package, current_snapshot, merged_config, config_layers, trim_info

    @staticmethod
    def _history_request(request: GenerationRequest) -> dict:
        return {
            "mode": request.mode,
            "inputs": dict(request.inputs or {}),
            "injections": list(request.injections or []),
            "config_overrides": dict(request.config_overrides or {}),
        }

    def _materialize_injections(self, names: Sequence[str]) -> list[PromptInjection]:
        out: list[PromptInjection] = []
        for name in names or []:
            inj = self.asset_registry.materialize_injection(name)
            if inj is not None:
                out.append(inj)
        return out

    def _build_provider_request(
        self,
        package: PromptPackage,
        config: GenerationConfig,
        *,
        stream: bool = False,
    ) -> ProviderRequest:
        messages: list[ProviderMessage] = []
        if package.system:
            messages.append(ProviderMessage(role="system", content=package.system))
        messages.append(ProviderMessage(role="user", content=package.user))
        return ProviderRequest(
            model=config.model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            top_p=config.top_p,
            top_k=config.top_k,
            repeat_penalty=config.repeat_penalty,
            stream=stream,
            timeout_ms=config.timeout_ms,
        )

    async def _call_provider(
        self,
        package: PromptPackage,
        config: GenerationConfig,
    ) -> ProviderResponse:
        request = self._build_provider_request(package, config, stream=False)
        return await self.provider.generate(request)
