"""Registry model dataclasses.

JSON-safe and declarative. No rendering logic here; see :mod:`hydrate`.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Optional, Union

from .state import RegistryState

SCHEMA_VERSION = 2

# Ordered list of well-known section names — used only for stable serialization
# ordering in to_dict(). Not enforced: any snake_case key is a valid section.
WELL_KNOWN_SECTIONS: tuple[str, ...] = (
    "base_context",
    "personas",
    "sentiment",
    "static_injections",
    "runtime_injections",
    "output_prompt_directions",
    "groups",
    "prompt_endings",
)

# Backwards-compatible alias.
SECTION_KEYS = WELL_KNOWN_SECTIONS


# ── Display ───────────────────────────────────────────────────────────


@dataclass
class Display:
    """Tool-facing presentation metadata. Never affects hydration."""

    description: str = ""
    icon: str = ""
    color: str = ""
    order: int = 0
    hidden: bool = False


def _display_dict(d: Display) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if d.description:
        out["description"] = d.description
    if d.icon:
        out["icon"] = d.icon
    if d.color:
        out["color"] = d.color
    if d.order:
        out["order"] = d.order
    if d.hidden:
        out["hidden"] = d.hidden
    return out


def _display_from_dict(data: dict[str, Any]) -> Display:
    return Display(
        description=str(data.get("description") or ""),
        icon=str(data.get("icon") or ""),
        color=str(data.get("color") or ""),
        order=int(data.get("order") or 0),
        hidden=bool(data.get("hidden", False)),
    )


# ── Scale ─────────────────────────────────────────────────────────────


@dataclass
class Scale:
    """Reusable scale configuration for ScalableMixin items."""

    label: str = "Scale"
    scale_descriptor: str = ""
    min_value: float = 1.0
    max_value: float = 10.0
    default_value: float = 5.0
    randomize: bool = False
    template: str = "{label}: {value}/{max_value} — {scale_descriptor}."


# ── Fragment ──────────────────────────────────────────────────────────


@dataclass
class Fragment:
    """Conditional text block. Renders when *condition* var is non-empty."""

    id: str
    text: str
    condition: str = ""
    label: str = ""
    display: Display = field(default_factory=Display)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "text": self.text}
        if self.condition:
            out["condition"] = self.condition
        if self.label:
            out["label"] = self.label
        d = _display_dict(self.display)
        if d:
            out["display"] = d
        return out


# ── BaseItem ──────────────────────────────────────────────────────────


@dataclass
class BaseItem:
    """Base for all typed item builders."""

    id: str
    label: str = ""
    display: Display = field(default_factory=Display)
    metadata: dict[str, Any] = field(default_factory=dict)

    def _base_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id}
        if self.label:
            out["label"] = self.label
        d = _display_dict(self.display)
        if d:
            out["display"] = d
        if self.metadata:
            out["metadata"] = dict(self.metadata)
        return out

    def to_dict(self) -> dict[str, Any]:
        return self._base_dict()


# ── Mixins ────────────────────────────────────────────────────────────


@dataclass(kw_only=True)
class DynamicMixin:
    """Adds template variable + fragment support. Requires Python 3.10+."""

    template_vars: list[str] = field(default_factory=list)
    template_defaults: dict[str, str] = field(default_factory=dict)
    fragments: list[Fragment] = field(default_factory=list)

    def _dynamic_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.template_vars:
            out["template_vars"] = list(self.template_vars)
        if self.template_defaults:
            out["template_defaults"] = dict(self.template_defaults)
        if self.fragments:
            out["fragments"] = [
                f.to_dict() if hasattr(f, "to_dict") else dict(f)
                for f in self.fragments
            ]
        return out


@dataclass(kw_only=True)
class ScalableMixin:
    """Adds a Scale to an item (e.g. Sentiment)."""

    scale: Optional[Scale] = None

    def _scale_dict(self) -> dict[str, Any]:
        if self.scale is None:
            return {}
        if isinstance(self.scale, dict):
            return {"scale": dict(self.scale)}
        return {"scale": dataclasses.asdict(self.scale)}


# ── Item types ────────────────────────────────────────────────────────


@dataclass
class Item(BaseItem, DynamicMixin, ScalableMixin):
    """Generic item for any section.

    All fields are optional. Use whichever fields the section's assembly
    tokens reference (``text``, ``groups``, ``scale``, ``items``, etc.).
    """

    text: str = ""
    groups: list[Any] = field(default_factory=list)
    items: list[Any] = field(default_factory=list)
    pre_context: str = ""
    include_sections: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        out.update(self._scale_dict())
        if self.text:
            out["text"] = self.text
        if self.groups:
            out["groups"] = list(self.groups)
        if self.items:
            out["items"] = list(self.items)
        if self.pre_context:
            out["pre_context"] = self.pre_context
        if self.include_sections:
            out["include_sections"] = list(self.include_sections)
        return out


# ── Typed convenience aliases ─────────────────────────────────────────
# These remain for backwards-compatible Python authoring.
# All serialize to the same generic item shape — "context" is written
# as "text" so the hydrator never needs to special-case the field name.


@dataclass
class Group(BaseItem):
    """Reusable list of prompt snippets."""

    pre_context: str = ""
    items: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        if self.pre_context:
            out["pre_context"] = self.pre_context
        out["items"] = list(self.items)
        return out


@dataclass
class ContextItem(BaseItem, DynamicMixin):
    """Convenience builder for a plain-text context item."""

    text: str = ""

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        if self.text:
            out["text"] = self.text
        return out


@dataclass
class Persona(BaseItem, DynamicMixin):
    """Convenience builder for a persona item. Serializes ``text`` (not ``context``)."""

    text: str = ""
    groups: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        if self.text:
            out["text"] = self.text
        if self.groups:
            out["groups"] = list(self.groups)
        return out


@dataclass
class Sentiment(BaseItem, DynamicMixin, ScalableMixin):
    """Convenience builder for a sentiment item. Serializes ``text`` (not ``context``)."""

    text: str = ""
    groups: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        out.update(self._scale_dict())
        if self.text:
            out["text"] = self.text
        if self.groups:
            out["groups"] = list(self.groups)
        return out


@dataclass
class RuntimeInjection(BaseItem, DynamicMixin):
    """Convenience builder for a runtime injection item."""

    text: str = ""
    include_sections: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        if self.text:
            out["text"] = self.text
        if self.include_sections:
            out["include_sections"] = list(self.include_sections)
        return out


@dataclass
class StaticInjection(BaseItem):
    """Convenience builder for a static injection item."""

    text: str = ""

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        if self.text:
            out["text"] = self.text
        return out


@dataclass
class OutputDirection(BaseItem, DynamicMixin, ScalableMixin):
    """Convenience builder for an output direction item."""

    text: str = ""
    groups: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        out.update(self._dynamic_dict())
        out.update(self._scale_dict())
        if self.text:
            out["text"] = self.text
        if self.groups:
            out["groups"] = list(self.groups)
        return out


@dataclass
class PromptEnding(BaseItem):
    """Convenience builder for a prompt ending item."""

    text: str = ""
    items: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out = self._base_dict()
        if self.text:
            out["text"] = self.text
        if self.items:
            out["items"] = list(self.items)
        return out


# ── Normalize ─────────────────────────────────────────────────────────


def _normalize_item(it: Any) -> dict[str, Any]:
    """Coerce a typed item builder or plain dict to a plain dict."""
    if hasattr(it, "to_dict") and callable(it.to_dict):
        return dict(it.to_dict())
    return dict(it)


# ── Section ───────────────────────────────────────────────────────────


@dataclass
class Section:
    """One section of the registry — blueprint only, no runtime state."""

    id: str
    label: str = ""
    display: Display = field(default_factory=Display)
    items: list[dict[str, Any]] = field(default_factory=list)
    required: bool = True
    template_vars: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.items = [_normalize_item(it) for it in (self.items or [])]

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "required": self.required,
            "items": [dict(it) for it in self.items],
        }
        if self.template_vars:
            out["template_vars"] = list(self.template_vars)
        if self.label:
            out["label"] = self.label
        d = _display_dict(self.display)
        if d:
            out["display"] = d
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any], section_id: str = "") -> "Section":
        display_data = data.get("display")
        items = []
        for it in (data.get("items") or []):
            it = dict(it)
            # Normalize legacy "name" → "id" so the hydrator only needs id.
            if "id" not in it and "name" in it:
                it["id"] = it.pop("name")
            # Normalize "context" → "text" so the hydrator uses a single field name.
            if "context" in it and "text" not in it:
                it["text"] = it.pop("context")
            items.append(it)
        return cls(
            id=section_id or str(data.get("id") or ""),
            label=str(data.get("label") or ""),
            display=_display_from_dict(display_data) if display_data else Display(),
            items=items,
            required=bool(data.get("required", True)),
            template_vars=[str(v) for v in (data.get("template_vars") or [])],
        )


# ── Route ─────────────────────────────────────────────────────────────


@dataclass
class Route:
    """Optional route — overrides assembly_order / generation / output_policy."""

    id: str = ""
    label: str = ""
    assembly_order: Optional[list[str]] = None
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)
    default_state: Optional[RegistryState] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.label:
            out["label"] = self.label
        if self.assembly_order is not None:
            out["assembly_order"] = list(self.assembly_order)
        if self.generation:
            out["generation"] = dict(self.generation)
        if self.output_policy:
            out["output_policy"] = dict(self.output_policy)
        if self.default_state:
            out["default_state"] = self.default_state.to_dict()
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any], route_id: str = "") -> "Route":
        ds_data = data.get("default_state")
        return cls(
            id=route_id or str(data.get("id") or ""),
            label=str(data.get("label") or ""),
            assembly_order=list(data["assembly_order"]) if "assembly_order" in data else None,
            generation=dict(data.get("generation") or {}),
            output_policy=dict(data.get("output_policy") or {}),
            default_state=RegistryState.from_dict(ds_data) if ds_data else None,
        )


# ── Registry ──────────────────────────────────────────────────────────


@dataclass
class Registry:
    """Top-level model. Accepts ``{"registry": {...}}`` or a bare dict."""

    version: int = SCHEMA_VERSION
    title: str = ""
    description: str = ""
    assembly_order: list[str] = field(default_factory=list)
    assembly_prefixes: dict[str, str] = field(default_factory=dict)
    sections: dict[str, Section] = field(default_factory=dict)
    routes: dict[str, Route] = field(default_factory=dict)
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)
    memory_config: dict[str, Any] = field(default_factory=dict)
    memory_rules: list[dict[str, Any]] = field(default_factory=list)
    style_blend: dict[str, Any] = field(default_factory=dict)
    default_state: Optional[RegistryState] = None

    def to_dict(self, *, wrap: bool = True) -> dict[str, Any]:
        body: dict[str, Any] = {
            "version": self.version,
            "title": self.title,
            "description": self.description,
            "assembly_order": list(self.assembly_order),
        }
        if self.assembly_prefixes:
            body["assembly_prefixes"] = dict(self.assembly_prefixes)
        for k in WELL_KNOWN_SECTIONS:
            if k in self.sections:
                body[k] = self.sections[k].to_dict()
        for k, sec in self.sections.items():
            if k not in WELL_KNOWN_SECTIONS:
                body[k] = sec.to_dict()
        if self.routes:
            body["routes"] = {k: r.to_dict() for k, r in self.routes.items()}
        if self.generation:
            body["generation"] = dict(self.generation)
        if self.output_policy:
            body["output_policy"] = dict(self.output_policy)
        if self.memory_config:
            body["memory_config"] = dict(self.memory_config)
        if self.memory_rules:
            body["memory_rules"] = list(self.memory_rules)
        if self.style_blend:
            body["style_blend"] = dict(self.style_blend)
        if self.default_state:
            body["default_state"] = self.default_state.to_dict()
        return {"registry": body} if wrap else body

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Registry":
        if "registry" in data and isinstance(data["registry"], dict):
            data = data["registry"]

        version = int(data.get("version") or SCHEMA_VERSION)
        if version != SCHEMA_VERSION:
            raise ValueError(
                f"unsupported registry schema version {version}; expected {SCHEMA_VERSION}"
            )

        RESERVED = {
            "version", "title", "description", "assembly_order", "assembly_prefixes",
            "routes", "generation", "output_policy", "default_state",
            "memory_config", "memory_rules", "style_blend",
        }

        sections: dict[str, Section] = {}
        for key, value in data.items():
            if key in RESERVED:
                continue
            if isinstance(value, dict) and "items" in value:
                sections[key] = Section.from_dict(value, section_id=key)

        routes: dict[str, Route] = {}
        for k, v in (data.get("routes") or {}).items():
            if isinstance(v, dict):
                routes[k] = Route.from_dict(v, route_id=k)

        ds_data = data.get("default_state")
        if ds_data:
            default_state: Optional[RegistryState] = RegistryState.from_dict(ds_data)
        else:
            default_state = None

        return cls(
            version=version,
            title=str(data.get("title") or ""),
            description=str(data.get("description") or ""),
            assembly_order=[str(t) for t in (data.get("assembly_order") or [])],
            assembly_prefixes={str(k): str(v) for k, v in (data.get("assembly_prefixes") or {}).items()},
            sections=sections,
            routes=routes,
            generation=dict(data.get("generation") or {}),
            output_policy=dict(data.get("output_policy") or {}),
            memory_config=dict(data.get("memory_config") or {}),
            memory_rules=list(data.get("memory_rules") or []),
            style_blend=dict(data.get("style_blend") or {}),
            default_state=default_state,
        )
