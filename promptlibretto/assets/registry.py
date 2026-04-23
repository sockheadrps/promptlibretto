from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from ..random_source import RandomSource, DefaultRandom


@dataclass
class InjectionTemplate:
    instructions: str
    examples: Sequence[str] = field(default_factory=tuple)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class PromptInjection:
    name: str
    instructions: str
    examples: Sequence[str] = field(default_factory=tuple)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)


class PromptAssetRegistry:
    """Flat string registry plus optional pools (for sampled examples/nudges)
    and named injectors. The 7-pool taxonomy was retired — categories are
    just names you choose.

    - `assets`: dict[str, str] — single named strings
    - `pools`:  dict[str, list[str]] — sampleable lists
    - `injectors`: dict[str, InjectionTemplate]
    """

    def __init__(self, random: Optional[RandomSource] = None):
        self._random: RandomSource = random or DefaultRandom()
        self.assets: dict[str, str] = {}
        self.pools: dict[str, list[str]] = {}
        self.injectors: dict[str, InjectionTemplate] = {}

    def add(self, name: str, text: str) -> None:
        self.assets[name] = text

    def add_pool(self, name: str, items: Sequence[str]) -> None:
        self.pools[name] = list(items)

    def add_injector(self, name: str, template: InjectionTemplate) -> None:
        self.injectors[name] = template

    def get(self, name: str, default: str = "") -> str:
        return self.assets.get(name, default)

    def pick(self, pool: str, count: int = 1) -> list[str]:
        items = self.pools.get(pool) or []
        if not items:
            return []
        return self._random.sample(items, min(count, len(items)))

    def pick_one(self, pool: str) -> Optional[str]:
        items = self.pools.get(pool) or []
        return self._random.choice(items) if items else None

    def materialize_injection(self, name: str) -> Optional[PromptInjection]:
        template = self.injectors.get(name)
        if template is None:
            return None
        return PromptInjection(
            name=name,
            instructions=template.instructions,
            examples=tuple(template.examples),
            generation_overrides=dict(template.generation_overrides),
            output_policy=dict(template.output_policy),
        )

    def list(self) -> dict[str, list[str]]:
        return {
            "assets": list(self.assets),
            "pools": list(self.pools),
            "injectors": list(self.injectors),
        }
