from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator, Callable, Optional

from .base import (
    ProviderAdapter,
    ProviderRequest,
    ProviderResponse,
    ProviderStreamChunk,
    ProviderTiming,
    ProviderUsage,
)


class MockProvider(ProviderAdapter):
    """Deterministic provider useful for tests and offline development."""

    def __init__(
        self,
        responder: Optional[Callable[[ProviderRequest], str]] = None,
        latency_ms: float = 5.0,
    ):
        self._responder = responder or self._echo
        self._latency_ms = latency_ms

    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        started = time.perf_counter()
        text = self._responder(request)
        elapsed_ms = (time.perf_counter() - started) * 1000.0 + self._latency_ms
        return ProviderResponse(
            text=text,
            usage=ProviderUsage(
                prompt_tokens=sum(len(m.content.split()) for m in request.messages),
                completion_tokens=len(text.split()),
                total_tokens=None,
            ),
            timing=ProviderTiming(total_ms=elapsed_ms),
            raw={"mock": True},
        )

    async def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderStreamChunk]:
        started = time.perf_counter()
        text = self._responder(request)
        # Emit word-by-word so consumers can see progressive updates.
        parts = text.split(" ")
        buffer = ""
        for i, part in enumerate(parts):
            chunk = (part if i == 0 else " " + part)
            buffer += chunk
            yield ProviderStreamChunk(text=chunk, done=False)
            if self._latency_ms > 0:
                await asyncio.sleep(self._latency_ms / 1000.0 / max(1, len(parts)))
        elapsed_ms = (time.perf_counter() - started) * 1000.0 + self._latency_ms
        yield ProviderStreamChunk(
            text="",
            done=True,
            response=ProviderResponse(
                text=buffer,
                usage=ProviderUsage(
                    prompt_tokens=sum(len(m.content.split()) for m in request.messages),
                    completion_tokens=len(buffer.split()),
                ),
                timing=ProviderTiming(total_ms=elapsed_ms),
                raw={"mock": True, "streamed": True},
            ),
        )

    @staticmethod
    def _echo(request: ProviderRequest) -> str:
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role == "user"),
            "",
        )
        return f"[mock:{request.model}] {last_user[:280]}"
