from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, AsyncIterator, Awaitable, Callable

from promptlibretto.providers.base import (
    ProviderRequest,
    ProviderResponse,
    ProviderStreamChunk,
    ProviderTiming,
    ProviderUsage,
)


class WsProvider:
    """Provider that delegates inference to a WebSocket-connected browser.

    The browser calls its local model (Ollama, llama.cpp, etc.) and streams
    chunks back so the server never needs to reach the model endpoint directly.

    Two instances can share the same `send_fn`. Each has its own `_pending`
    dict keyed by UUID so concurrent requests never collide.
    """

    def __init__(
        self,
        send_fn: Callable[[dict[str, Any]], Awaitable[None]],
        side: str = "",
    ) -> None:
        self._send = send_fn
        self._side = side
        self._pending: dict[str, asyncio.Queue] = {}

    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        t0 = time.monotonic()
        full: list[str] = []
        async for chunk in self.stream(request):
            if chunk.text:
                full.append(chunk.text)
        return ProviderResponse(
            text="".join(full),
            timing=ProviderTiming(total_ms=(time.monotonic() - t0) * 1000),
        )

    async def stream(self, request: ProviderRequest) -> AsyncIterator[ProviderStreamChunk]:
        req_id = str(uuid.uuid4())
        queue: asyncio.Queue = asyncio.Queue()
        self._pending[req_id] = queue
        await self._send({
            "type":           "chat_request",
            "id":             req_id,
            "side":           self._side,
            "model":          request.model,
            "messages":       [{"role": m.role, "content": m.content} for m in request.messages],
            "temperature":    request.temperature,
            "max_tokens":     request.max_tokens,
            "top_p":          request.top_p,
            "top_k":          request.top_k,
            "repeat_penalty": request.repeat_penalty,
        })
        t0 = time.monotonic()
        full: list[str] = []
        try:
            while True:
                try:
                    item = await asyncio.wait_for(asyncio.shield(queue.get()), timeout=120.0)
                except asyncio.TimeoutError:
                    raise RuntimeError(
                        f"chat_request {req_id[:8]} timed out — "
                        "browser did not respond within 120 s."
                    )
                if item is None:
                    yield ProviderStreamChunk(
                        text="",
                        done=True,
                        response=ProviderResponse(
                            text="".join(full),
                            timing=ProviderTiming(total_ms=(time.monotonic() - t0) * 1000),
                        ),
                    )
                    break
                if isinstance(item, Exception):
                    raise item
                full.append(item)
                yield ProviderStreamChunk(text=item, done=False)
        finally:
            self._pending.pop(req_id, None)

    def receive_chunk(self, req_id: str, delta: str) -> None:
        q = self._pending.get(req_id)
        if q is not None:
            q.put_nowait(delta)

    def receive_done(self, req_id: str) -> None:
        q = self._pending.get(req_id)
        if q is not None:
            q.put_nowait(None)

    def reject(self, req_id: str, error: str) -> None:
        q = self._pending.get(req_id)
        if q is not None:
            q.put_nowait(RuntimeError(f"browser chat error: {error}"))

    async def aclose(self) -> None:
        pass
