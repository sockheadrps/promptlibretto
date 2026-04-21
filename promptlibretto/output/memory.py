from __future__ import annotations

import re
from collections import deque
from typing import Deque

_WORD = re.compile(r"\w+")


def _tokenize(text: str) -> set[str]:
    return {m.group(0).lower() for m in _WORD.finditer(text or "")}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


class RecentOutputMemory:
    """Bounded log of recent outputs used to discourage repetition."""

    def __init__(self, capacity: int = 16):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._items: Deque[str] = deque(maxlen=capacity)
        self._token_sets: Deque[set[str]] = deque(maxlen=capacity)

    def add(self, text: str) -> None:
        normalized = (text or "").strip()
        if not normalized:
            return
        self._items.append(normalized)
        self._token_sets.append(_tokenize(normalized))

    def is_too_similar(self, text: str, threshold: float = 0.9) -> bool:
        candidate = (text or "").strip()
        if not candidate:
            return False
        if candidate in self._items:
            return True
        candidate_tokens = _tokenize(candidate)
        for tokens in self._token_sets:
            if _jaccard(candidate_tokens, tokens) >= threshold:
                return True
        return False

    def items(self) -> list[str]:
        return list(self._items)

    def clear(self) -> None:
        self._items.clear()
        self._token_sets.clear()
