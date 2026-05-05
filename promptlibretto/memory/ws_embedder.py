from __future__ import annotations

import asyncio
import uuid
from typing import Any, Awaitable, Callable


class WsEmbedder:
    """Embedder that delegates embed calls to a WebSocket-connected browser.

    The browser calls its local embed model (e.g. Ollama nomic-embed-text)
    and streams vectors back, so the server never needs to reach the embed
    endpoint directly.

    Two instances can share the same `send_fn` (one WebSocket connection,
    two participants). Each has its own `_pending` dict keyed by UUID so
    requests never collide. `resolve` / `reject` are no-ops for IDs that
    don't belong to this instance.
    """

    def __init__(
        self,
        send_fn: Callable[[dict[str, Any]], Awaitable[None]],
        side: str = "",
    ) -> None:
        self._send = send_fn
        self._side = side
        self._pending: dict[str, asyncio.Future[list[float]]] = {}

    async def embed(self, text: str) -> list[float]:
        req_id = str(uuid.uuid4())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[list[float]] = loop.create_future()
        self._pending[req_id] = fut
        await self._send({
            "type": "embed_request",
            "id":   req_id,
            "text": text,
            "side": self._side,
        })
        try:
            return await asyncio.wait_for(asyncio.shield(fut), timeout=30.0)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"embed_request {req_id[:8]} timed out — "
                "browser did not respond within 30 s. "
                "Is the embed URL reachable from your browser?"
            )
        finally:
            self._pending.pop(req_id, None)

    def resolve(self, req_id: str, vectors: list[float]) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_result(vectors)

    def reject(self, req_id: str, error: str) -> None:
        fut = self._pending.get(req_id)
        if fut and not fut.done():
            fut.set_exception(RuntimeError(f"browser embed error: {error}"))

    async def aclose(self) -> None:
        pass
