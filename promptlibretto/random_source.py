from __future__ import annotations

import random
from typing import Protocol, Sequence, TypeVar

T = TypeVar("T")


class RandomSource(Protocol):
    def float(self) -> float: ...
    def choice(self, items: Sequence[T]) -> T: ...
    def sample(self, items: Sequence[T], count: int) -> list[T]: ...


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


class DefaultRandom(_BaseRandom):
    def __init__(self):
        super().__init__(random.Random())


class SeededRandom(_BaseRandom):
    def __init__(self, seed: int):
        super().__init__(random.Random(seed))
