"""Example middleware wired into the test-bench engine.

`LatencyLogger` times each `generate_once` / `generate_stream` call and
writes a one-line record to a bounded ring buffer. The server exposes
`/api/latency` so the GUI can display recent generation latencies without
any extra instrumentation in the engine or provider.
"""
from __future__ import annotations

import time
from collections import deque
from typing import Any, Optional


class LatencyLogger:
    def __init__(self, capacity: int = 50):
        self._records: deque[dict[str, Any]] = deque(maxlen=capacity)
        self._started: Optional[float] = None

    async def before(self, request: Any) -> None:
        self._started = time.perf_counter()

    async def after(self, request: Any, result: Any) -> None:
        if self._started is None:
            return
        elapsed_ms = (time.perf_counter() - self._started) * 1000.0
        self._started = None
        self._records.append({
            "at": time.time(),
            "route": getattr(result, "route", None),
            "accepted": getattr(result, "accepted", None),
            "elapsed_ms": round(elapsed_ms, 1),
            "mode": getattr(request, "mode", None),
        })

    def records(self) -> list[dict[str, Any]]:
        return list(self._records)
