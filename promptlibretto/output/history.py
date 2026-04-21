"""Bounded log of past runs, kept for UI replay and inspection.

Distinct from `RecentOutputMemory`, which exists to detect repetition
(Jaccard similarity over output text). This stores the *full* shape of a
run — the request that produced it and what came back — so callers can
reload a prior run into their UI, audit history, or build chat-style
follow-ups on top.

Both types are bounded ring buffers; neither knows about the other.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque


@dataclass
class RunRecord:
    request: dict[str, Any]
    text: str
    accepted: bool
    route: str
    at: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "request": dict(self.request),
            "text": self.text,
            "accepted": self.accepted,
            "route": self.route,
            "at": self.at,
            "metadata": dict(self.metadata),
        }


class RunHistory:
    def __init__(self, capacity: int = 32):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._items: Deque[RunRecord] = deque(maxlen=capacity)

    def add(self, record: RunRecord) -> None:
        self._items.append(record)

    def items(self) -> list[RunRecord]:
        return list(self._items)

    def clear(self) -> None:
        self._items.clear()

    def remove_at(self, index: int) -> bool:
        """Remove the record at the given index (newest = len-1). Returns True
        if removed, False if the index was out of range.
        """
        if index < 0 or index >= len(self._items):
            return False
        as_list = list(self._items)
        del as_list[index]
        self._items.clear()
        self._items.extend(as_list)
        return True
