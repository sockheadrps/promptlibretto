from __future__ import annotations

import json
import time
from typing import Any, AsyncIterator, Optional

import httpx

from .base import (
    ProviderAdapter,
    ProviderRequest,
    ProviderResponse,
    ProviderStreamChunk,
    ProviderTiming,
    ProviderUsage,
)


class OllamaProvider(ProviderAdapter):
    """Adapter for an Ollama-compatible HTTP backend.

    Uses the `/api/chat` endpoint by default. Most local Ollama installs run
    on http://localhost:11434, but the URL is fully configurable so it can
    point at any compatible endpoint (for example a custom port like 8080).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        chat_path: str = "/api/chat",
        payload_shape: str = "auto",
        client: Optional[httpx.AsyncClient] = None,
    ):
        """
        `payload_shape` controls how sampling params are encoded in the request:

        - "ollama": wrap in `options: {...}` with `num_predict` for max tokens.
          Matches Ollama's `/api/chat` and `/api/generate`.
        - "openai": top-level `temperature`, `max_tokens`, `top_p`. Matches
          llama.cpp-server, vLLM, and other OpenAI-compatible backends on
          `/v1/chat/completions`.
        - "auto" (default): picks "openai" when `chat_path` contains `/v1/`,
          else "ollama". Covers the common cases without explicit config.
        """
        self._base_url = base_url.rstrip("/")
        self._chat_path = chat_path if chat_path.startswith("/") else "/" + chat_path
        if payload_shape == "auto":
            payload_shape = "openai" if "/v1/" in self._chat_path else "ollama"
        if payload_shape not in ("ollama", "openai"):
            raise ValueError(f"unknown payload_shape: {payload_shape!r}")
        self._payload_shape = payload_shape
        self._owned_client = client is None
        self._client = client or httpx.AsyncClient()

    def _build_payload(self, request: ProviderRequest, stream: bool) -> dict[str, Any]:
        messages = [{"role": m.role, "content": m.content} for m in request.messages]
        if self._payload_shape == "openai":
            payload: dict[str, Any] = {
                "model": request.model,
                "messages": messages,
                "stream": stream,
                "temperature": request.temperature,
                "max_tokens": request.max_tokens,
            }
            if stream:
                payload["stream_options"] = {"include_usage": True}
            if request.top_p is not None:
                payload["top_p"] = request.top_p
            # OpenAI-compatible servers typically don't accept top_k /
            # repeat_penalty at the top level; skip them rather than send
            # fields that could be rejected.
            return payload
        options: dict[str, Any] = {
            "temperature": request.temperature,
            "num_predict": request.max_tokens,
        }
        if request.top_p is not None:
            options["top_p"] = request.top_p
        if request.top_k is not None:
            options["top_k"] = request.top_k
        if request.repeat_penalty is not None:
            options["repeat_penalty"] = request.repeat_penalty
        return {
            "model": request.model,
            "messages": messages,
            "stream": stream,
            "options": options,
        }

    async def aclose(self) -> None:
        if self._owned_client:
            await self._client.aclose()

    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        payload = self._build_payload(request, stream=False)

        url = f"{self._base_url}{self._chat_path}"
        timeout = max(1.0, request.timeout_ms / 1000.0)

        started = time.perf_counter()
        response = await self._client.post(url, json=payload, timeout=timeout)
        elapsed_ms = (time.perf_counter() - started) * 1000.0

        response.raise_for_status()
        data = response.json()

        text = self._extract_text(data)
        usage = self._extract_usage(data)
        timing = ProviderTiming(
            total_ms=_ns_to_ms(data.get("total_duration")) or elapsed_ms,
            load_ms=_ns_to_ms(data.get("load_duration")),
            prompt_eval_ms=_ns_to_ms(data.get("prompt_eval_duration")),
            eval_ms=_ns_to_ms(data.get("eval_duration")),
        )
        return ProviderResponse(text=text, usage=usage, timing=timing, raw=data)

    async def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderStreamChunk]:
        payload = self._build_payload(request, stream=True)
        url = f"{self._base_url}{self._chat_path}"
        timeout = max(1.0, request.timeout_ms / 1000.0)

        buffer: list[str] = []
        started = time.perf_counter()
        final_data: Optional[dict] = None
        async with self._client.stream("POST", url, json=payload, timeout=timeout) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line:
                    continue
                # OpenAI-compatible servers use SSE: `data: {json}` / `data: [DONE]`.
                if line.startswith("data:"):
                    line = line[5:].strip()
                    if line == "[DONE]":
                        break
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                piece = self._extract_text(data)
                if piece:
                    buffer.append(piece)
                    yield ProviderStreamChunk(text=piece, done=False)
                if _has_usage(data):
                    final_data = data
                if data.get("done"):
                    final_data = data
                    break

        elapsed_ms = (time.perf_counter() - started) * 1000.0
        text = "".join(buffer)
        data = final_data or {}
        yield ProviderStreamChunk(
            text="",
            done=True,
            response=ProviderResponse(
                text=text,
                usage=self._extract_usage(data),
                timing=ProviderTiming(
                    total_ms=_ns_to_ms(data.get("total_duration")) or elapsed_ms,
                    load_ms=_ns_to_ms(data.get("load_duration")),
                    prompt_eval_ms=_ns_to_ms(data.get("prompt_eval_duration")),
                    eval_ms=_ns_to_ms(data.get("eval_duration")),
                ),
                raw=data,
            ),
        )

    @staticmethod
    def _extract_text(data: dict) -> str:
        # Ollama /api/chat: {"message": {"content": "..."}}
        msg = data.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
            if content:
                return content
        # OpenAI-compatible (llama.cpp, vLLM, etc.): {"choices": [{"message": {"content": "..."}}]}
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0] or {}
            cmsg = first.get("message") if isinstance(first, dict) else None
            if isinstance(cmsg, dict):
                content = cmsg.get("content")
                if content:
                    return content
            # OpenAI completions style: {"choices": [{"text": "..."}]}
            text = first.get("text") if isinstance(first, dict) else None
            if text:
                return text
            # Some servers nest as delta (streaming aggregates)
            delta = first.get("delta") if isinstance(first, dict) else None
            if isinstance(delta, dict) and delta.get("content"):
                return delta["content"]
        # Ollama /api/generate: {"response": "..."}
        if data.get("response"):
            return data["response"]
        # Last-ditch: a top-level "content" field
        if isinstance(data.get("content"), str):
            return data["content"]
        return ""

    @staticmethod
    def _extract_usage(data: dict) -> ProviderUsage:
        # OpenAI-compatible usage block
        u = data.get("usage")
        if isinstance(u, dict):
            return ProviderUsage(
                prompt_tokens=u.get("prompt_tokens"),
                completion_tokens=u.get("completion_tokens"),
                total_tokens=u.get("total_tokens")
                or _safe_sum(u.get("prompt_tokens"), u.get("completion_tokens")),
            )
        # Ollama-native usage fields
        prompt = data.get("prompt_eval_count")
        completion = data.get("eval_count")
        if prompt is not None or completion is not None:
            return ProviderUsage(
                prompt_tokens=prompt,
                completion_tokens=completion,
                total_tokens=_safe_sum(prompt, completion),
            )
        # llama.cpp also exposes tokens_predicted / tokens_evaluated in some builds
        prompt = data.get("tokens_evaluated")
        completion = data.get("tokens_predicted")
        if prompt is not None or completion is not None:
            return ProviderUsage(
                prompt_tokens=prompt,
                completion_tokens=completion,
                total_tokens=_safe_sum(prompt, completion),
            )
        return ProviderUsage()


def _ns_to_ms(value: Optional[int]) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value) / 1_000_000.0
    except (TypeError, ValueError):
        return None


def _safe_sum(a: Optional[int], b: Optional[int]) -> Optional[int]:
    if a is None and b is None:
        return None
    return (a or 0) + (b or 0)


def _has_usage(data: dict) -> bool:
    return (
        isinstance(data.get("usage"), dict)
        or data.get("prompt_eval_count") is not None
        or data.get("eval_count") is not None
        or data.get("tokens_evaluated") is not None
        or data.get("tokens_predicted") is not None
    )
