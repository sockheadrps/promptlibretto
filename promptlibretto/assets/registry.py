from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from ..random_source import RandomSource, DefaultRandom


@dataclass
class InjectionTemplate:
    """Static fragment that can be merged into a prompt by name."""

    instructions: str
    examples: Sequence[str] = field(default_factory=tuple)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class PromptInjection:
    """The materialised result of selecting an injection at request time."""

    name: str
    instructions: str
    examples: Sequence[str] = field(default_factory=tuple)
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)


class PromptAssetRegistry:
    """Named text fragments builders compose from: frames, rules, personas,
    endings, example/nudge pools, and materializable injectors."""

    def __init__(self, random: Optional[RandomSource] = None):
        self._random: RandomSource = random or DefaultRandom()
        self.frames: dict[str, str] = {}
        self.rules: dict[str, str] = {}
        self.personas: dict[str, str] = {}
        self.endings: dict[str, str] = {}
        self.examples: dict[str, list[str]] = {}
        self.nudges: dict[str, list[str]] = {}
        self.injectors: dict[str, InjectionTemplate] = {}

    # --- registration helpers -----------------------------------------
    def add_frame(self, name: str, text: str) -> None:
        self.frames[name] = text

    def add_rule(self, name: str, text: str) -> None:
        self.rules[name] = text

    def add_persona(self, name: str, text: str) -> None:
        self.personas[name] = text

    def add_ending(self, name: str, text: str) -> None:
        self.endings[name] = text

    def add_examples(self, name: str, items: Sequence[str]) -> None:
        self.examples[name] = list(items)

    def add_nudges(self, name: str, items: Sequence[str]) -> None:
        self.nudges[name] = list(items)

    def add_injector(self, name: str, template: InjectionTemplate) -> None:
        self.injectors[name] = template

    # --- lookup ---------------------------------------------------------
    def frame(self, name: str, default: str = "") -> str:
        return self.frames.get(name, default)

    def rule(self, name: str, default: str = "") -> str:
        return self.rules.get(name, default)

    def persona(self, name: str, default: str = "") -> str:
        return self.personas.get(name, default)

    def ending(self, name: str, default: str = "") -> str:
        return self.endings.get(name, default)

    # --- random picks ---------------------------------------------------
    def pick_examples(self, pool: str, count: int) -> list[str]:
        items = self.examples.get(pool) or []
        if not items:
            return []
        return self._random.sample(items, min(count, len(items)))

    def pick_nudge(self, pool: str) -> Optional[str]:
        items = self.nudges.get(pool) or []
        return self._random.choice(items) if items else None

    # --- injections -----------------------------------------------------
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
            "frames": list(self.frames),
            "rules": list(self.rules),
            "personas": list(self.personas),
            "endings": list(self.endings),
            "examples": list(self.examples),
            "nudges": list(self.nudges),
            "injectors": list(self.injectors),
        }
