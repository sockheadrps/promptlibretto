from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Optional

from ..registry.hydrate import HydrateState


@dataclass
class MemoryAction:
    type: str                       # "inject" | "persona" | "sentiment" | "template_var"
    section: Optional[str] = None  # inject: which section (runtime_injections / static_injections)
    item: Optional[str] = None     # inject: item id to activate
    value: Optional[str] = None    # persona / sentiment: selection value
    key: Optional[str] = None      # template_var: variable key
    # template_var reuses value for the variable's value

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MemoryAction":
        return cls(
            type=d["type"],
            section=d.get("section"),
            item=d.get("item"),
            value=d.get("value"),
            key=d.get("key"),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.type}
        if self.section is not None:
            out["section"] = self.section
        if self.item is not None:
            out["item"] = self.item
        if self.value is not None:
            out["value"] = self.value
        if self.key is not None:
            out["key"] = self.key
        return out


@dataclass
class MemoryRule:
    tag: str
    actions: list[MemoryAction] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MemoryRule":
        return cls(
            tag=d["tag"],
            actions=[MemoryAction.from_dict(a) for a in (d.get("actions") or [])],
        )

    def to_dict(self) -> dict[str, Any]:
        return {"tag": self.tag, "actions": [a.to_dict() for a in self.actions]}


class Router:
    """Maps extracted memory tags to HydrateState mutations.

    Rules are evaluated in order; last rule wins on conflicts for the same
    field. Injection activations are additive (all matching injections are
    included).
    """

    def __init__(self, rules: list[MemoryRule]) -> None:
        self._rules = rules
        self._known_tags: list[str] = [r.tag for r in rules]

    @property
    def known_tags(self) -> list[str]:
        return list(self._known_tags)

    def mutate(self, base_state: HydrateState, tags: list[str]) -> HydrateState:
        if not tags:
            return base_state

        tag_set = set(tags)
        active_rules = [r for r in self._rules if r.tag in tag_set]
        if not active_rules:
            return base_state

        # Deep-copy state so we don't mutate the caller's object
        selections   = dict(base_state.selections or {})
        array_modes  = _deep_copy_dict(base_state.array_modes or {})
        sec_random   = dict(base_state.section_random or {})
        sliders      = dict(base_state.sliders or {})
        slider_random = dict(base_state.slider_random or {})
        tvars        = dict(base_state.template_vars or {})

        applied: list[str] = []

        for rule in active_rules:
            for action in rule.actions:
                if action.type == "inject" and action.section and action.item:
                    existing = selections.get(action.section)
                    if isinstance(existing, list):
                        if action.item not in existing:
                            existing.append(action.item)
                    elif isinstance(existing, str):
                        if existing != action.item:
                            selections[action.section] = [existing, action.item]
                    else:
                        selections[action.section] = action.item
                    applied.append(f"{rule.tag} → inject:{action.section}.{action.item}")

                elif action.type == "persona" and action.value:
                    selections["personas"] = action.value
                    applied.append(f"{rule.tag} → persona:{action.value}")

                elif action.type == "sentiment" and action.value:
                    selections["sentiment"] = action.value
                    applied.append(f"{rule.tag} → sentiment:{action.value}")

                elif action.type == "template_var" and action.key and action.value:
                    tvars[action.key] = action.value
                    applied.append(f"{rule.tag} → tvar:{action.key}={action.value}")

        new_state = HydrateState(
            selections=selections,
            array_modes=array_modes,
            section_random=sec_random,
            sliders=sliders,
            slider_random=slider_random,
            template_vars=tvars,
        )
        new_state._applied_rules = applied  # type: ignore[attr-defined]
        return new_state

    @classmethod
    def from_registry_rules(cls, rules_raw: list[dict[str, Any]]) -> "Router":
        return cls([MemoryRule.from_dict(r) for r in (rules_raw or [])])


def _deep_copy_dict(d: dict) -> dict:
    return copy.deepcopy(d)
