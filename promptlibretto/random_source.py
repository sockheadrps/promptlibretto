from __future__ import annotations

import random
from typing import Protocol, Sequence, TypeVar, Iterable, Mapping

T = TypeVar("T")


class RandomSource(Protocol):
    def float(self) -> float: ...
    def choice(self, items: Sequence[T]) -> T: ...
    def sample(self, items: Sequence[T], count: int) -> list[T]: ...
    def weighted(self, items: Sequence[tuple[T, float]]) -> T: ...


class _BaseRandom:
    def __init__(self, rng: random.Random):
        self._rng = rng

    def float(self) -> float:
        return self._rng.random()

    def choice(self, items: Sequence[T]) -> T:
        if not items:
            raise ValueError("choice() called on empty sequence")
        return self._rng.choice(list(items))

    def sample(self, items: Sequence[T], count: int) -> list[T]:
        pool = list(items)
        if count >= len(pool):
            self._rng.shuffle(pool)
            return pool
        return self._rng.sample(pool, count)

    def weighted(self, items: Sequence[tuple[T, float]]) -> T:
        if not items:
            raise ValueError("weighted() called on empty sequence")
        values = [v for v, _ in items]
        weights = [max(0.0, float(w)) for _, w in items]
        total = sum(weights)
        if total <= 0:
            return self._rng.choice(values)
        return self._rng.choices(values, weights=weights, k=1)[0]


class DefaultRandom(_BaseRandom):
    def __init__(self):
        super().__init__(random.Random())


class SeededRandom(_BaseRandom):
    def __init__(self, seed: int):
        super().__init__(random.Random(seed))
