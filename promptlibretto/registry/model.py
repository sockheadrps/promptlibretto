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
        )
