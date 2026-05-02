"""Registry model dataclasses — schema v22.

JSON-safe, declarative. Maps 1:1 to the JSON the studio frontend
imports/exports. No rendering logic here — see :mod:`hydrate`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Union

SCHEMA_VERSION = 22

# Section keys recognised by the engine (in canonical order).
SECTION_KEYS: tuple[str, ...] = (
    "base_context",
    "personas",
    "sentiment",
    "static_injections",
    "runtime_injections",
    "output_prompt_directions",
    "examples",
    "prompt_endings",
)


# ── Typed item builders ────────────────────────────────────────────
# Items inside Section are stored as plain dicts (the schema is open —
# custom sections can use any shape), but the canonical sections all have
# well-known item shapes. The dataclasses below provide IDE autocomplete +
# type-checking when constructing items in Python; they each define a
# `to_dict()` that emits the exact JSON the engine consumes.
#
# `Section.items` accepts either dataclass instances OR plain dicts; the
# Section normalizes to dicts at construction time.


@dataclass
class Fragment:
    """Conditional text inside a `base_context` item.

    `if_var` names a template variable in the same section; the fragment is
    rendered only when that var has a non-empty value at hydrate time.
    """
    if_var: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {"if_var": self.if_var, "text": self.text}


@dataclass
class ContextItem:
    """Item for the `base_context` section."""
    name: str
    text: str = ""
    fragments: list[Union["Fragment", dict[str, Any]]] = field(default_factory=list)
    runtime_variables: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "text": self.text}
        if self.fragments:
            out["fragments"] = [
                f.to_dict() if hasattr(f, "to_dict") else dict(f) for f in self.fragments
            ]
        if self.runtime_variables:
            out["runtime_variables"] = list(self.runtime_variables)
        return out


@dataclass
class Persona:
    """Item for the `personas` section."""
    id: str
    context: str = ""
    base_directives: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "context": self.context,
            "base_directives": list(self.base_directives),
        }


@dataclass
class SentimentItem:
    """Item for the `sentiment` section. `scale_emotion` is the noun phrase
    interpolated into the section's `scale_template`."""
    id: str
    context: str = ""
    scale_emotion: str = ""
    nudges: list[str] = field(default_factory=list)
    examples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "context": self.context,
            "scale_emotion": self.scale_emotion,
            "nudges": list(self.nudges),
            "examples": list(self.examples),
        }


@dataclass
class ExampleGroup:
    """Item for the `examples` section. `items` is a list of example strings;
    `pre_context` is an optional intro line printed once above the group."""
    name: str
    items: list[str] = field(default_factory=list)
    pre_context: str = ""

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "items": list(self.items)}
        if self.pre_context:
            out["pre_context"] = self.pre_context
        return out


@dataclass
class StaticInjection:
    """Item for the `static_injections` section. Always-on context that gets
    appended when the section is selected."""
    name: str
    text: str
    memory_tag: str = ""

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "text": self.text}
        if self.memory_tag:
            out["memory_tag"] = self.memory_tag
        return out


@dataclass
class RuntimeInjection:
    """Item for the `runtime_injections` section. When active, filters the
    rendered prompt down to only the listed `include_sections` and appends
    its own text."""
    id: str
    text: str
    include_sections: list[str] = field(default_factory=list)
    runtime_variables: list[str] = field(default_factory=list)
    name: str = ""
    required: bool = False
    memory_tag: str = ""

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "text": self.text}
        if self.name:
            out["name"] = self.name
        if self.include_sections:
            out["include_sections"] = list(self.include_sections)
        if self.runtime_variables:
            out["runtime_variables"] = list(self.runtime_variables)
        if self.required:
            out["required"] = True
        if self.memory_tag:
            out["memory_tag"] = self.memory_tag
        return out


@dataclass
class OutputDirection:
    """Item for the `output_prompt_directions` section."""
    name: str
    text: str

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "text": self.text}


@dataclass
class PromptEnding:
    """Item for the `prompt_endings` section. `items` is the list of ending
    strings; one is picked per generation (combine with `array_modes` for
    rotation)."""
    name: str = "endings"
    items: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "items": list(self.items)}


def _normalize_item(it: Any) -> dict[str, Any]:
    """Coerce an item to a plain dict. Accepts any dataclass with `to_dict()`
    (the typed item builders above) or a raw mapping."""
    if hasattr(it, "to_dict") and callable(it.to_dict):
        return dict(it.to_dict())
    return dict(it)


@dataclass
class Section:
    """One section of the registry. Has items + optional tool-state extras."""

    required: bool = True
    template_vars: list[str] = field(default_factory=list)
    items: list[dict[str, Any]] = field(default_factory=list)

    # Optional tool-state fields (emitted by the studio's Export Model JSON).
    selected: Optional[Union[str, list[str]]] = None
    section_random: Optional[bool] = None
    array_modes: Optional[dict[str, str]] = None
    slider: Optional[float] = None
    slider_random: Optional[bool] = None
    # Sentiment-only: format string for the `sentiment.scale` token.
    # Placeholders: `{value}` (1-10), `{emotion}` (per-item scale_emotion).
    scale_template: Optional[str] = None
    # Default values for declared template_vars. Studio pre-fills the
    # runtime-input rows from this on load so examples come ready to
    # Pre-generate without the user typing in placeholders.
    template_var_defaults: Optional[dict[str, str]] = None

    def __post_init__(self) -> None:
        # Normalize items: accept typed builders (Persona, SentimentItem, …)
        # OR plain dicts. Internally we always store dicts so hydrate.py and
        # to_dict() / from_dict() round-trip cleanly.
        self.items = [_normalize_item(it) for it in (self.items or [])]

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "required": self.required,
            "template_vars": list(self.template_vars),
            "items": [dict(it) for it in self.items],
        }
        if self.selected is not None:
            out["selected"] = (
                self.selected if isinstance(self.selected, str) else list(self.selected)
            )
        if self.section_random is not None:
            out["section_random"] = self.section_random
        if self.array_modes:
            out["array_modes"] = dict(self.array_modes)
        if self.slider is not None:
            out["slider"] = self.slider
        if self.slider_random is not None:
            out["slider_random"] = self.slider_random
        if self.scale_template:
            out["scale_template"] = self.scale_template
        if self.template_var_defaults:
            out["template_var_defaults"] = dict(self.template_var_defaults)
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Section":
        defaults = data.get("template_var_defaults")
        return cls(
            required=bool(data.get("required", True)),
            template_vars=list(data.get("template_vars") or []),
            items=[dict(it) for it in (data.get("items") or [])],
            selected=data.get("selected"),
            section_random=data.get("section_random"),
            array_modes=dict(data["array_modes"]) if data.get("array_modes") else None,
            slider=data.get("slider"),
            slider_random=data.get("slider_random"),
            scale_template=data.get("scale_template"),
            template_var_defaults=dict(defaults) if defaults else None,
        )


@dataclass
class Route:
    """Optional route — overrides assembly_order / generation / output_policy
    for a single ``Engine.run()`` call. If a registry has no routes, the
    top-level fields are the only path."""

    assembly_order: Optional[list[str]] = None
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.assembly_order is not None:
            out["assembly_order"] = list(self.assembly_order)
        if self.generation:
            out["generation"] = dict(self.generation)
        if self.output_policy:
            out["output_policy"] = dict(self.output_policy)
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Route":
        return cls(
            assembly_order=list(data["assembly_order"])
            if "assembly_order" in data
            else None,
            generation=dict(data.get("generation") or {}),
            output_policy=dict(data.get("output_policy") or {}),
        )


@dataclass
class Registry:
    """Top-level model. Accepts ``{"registry": {...}}`` or a bare dict."""

    version: int = SCHEMA_VERSION
    title: str = ""
    description: str = ""
    assembly_order: list[str] = field(default_factory=list)
    sections: dict[str, Section] = field(default_factory=dict)
    routes: dict[str, Route] = field(default_factory=dict)
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)
    memory_rules: list[dict[str, Any]] = field(default_factory=list)
    memory_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self, *, wrap: bool = True) -> dict[str, Any]:
        body: dict[str, Any] = {
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "assembly_order": list(self.assembly_order),
        }
        for k in SECTION_KEYS:
            if k in self.sections:
                body[k] = self.sections[k].to_dict()
        for k, sec in self.sections.items():
            if k not in SECTION_KEYS:
                body[k] = sec.to_dict()
        if self.routes:
            body["routes"] = {k: r.to_dict() for k, r in self.routes.items()}
        if self.generation:
            body["generation"] = dict(self.generation)
        if self.output_policy:
            body["output_policy"] = dict(self.output_policy)
        if self.memory_rules:
            body["memory_rules"] = list(self.memory_rules)
        if self.memory_config:
            body["memory_config"] = dict(self.memory_config)
        return {"registry": body} if wrap else body

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Registry":
        if "registry" in data and isinstance(data["registry"], dict):
            data = data["registry"]
        sections: dict[str, Section] = {}
        for key, value in data.items():
            if key in {
                "version",
                "title",
                "description",
                "assembly_order",
                "routes",
                "generation",
                "output_policy",
                "memory_rules",
                "memory_config",
            }:
                continue
            if isinstance(value, dict) and "items" in value:
                sections[key] = Section.from_dict(value)
        routes: dict[str, Route] = {}
        for k, v in (data.get("routes") or {}).items():
            if isinstance(v, dict):
                routes[k] = Route.from_dict(v)
        return cls(
            version=int(data.get("version") or SCHEMA_VERSION),
            title=str(data.get("title") or ""),
            description=str(data.get("description") or ""),
            assembly_order=[str(t) for t in (data.get("assembly_order") or [])],
            sections=sections,
            routes=routes,
            generation=dict(data.get("generation") or {}),
            output_policy=dict(data.get("output_policy") or {}),
            memory_rules=list(data.get("memory_rules") or []),
            memory_config=dict(data.get("memory_config") or {}),
        )
