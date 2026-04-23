from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

if TYPE_CHECKING:
    from ..builders.composite import CompositeBuilder
    from ..builders.builder import GenerationRequest
    from ..context.overlay import ContextSnapshot

RouteApplies = Callable[["ContextSnapshot", "GenerationRequest"], bool]

CUSTOM_ROUTE_KIND = "custom"


@dataclass
class PromptRoute:
    """A named prompt strategy with an applicability predicate."""

    name: str
    builder: "CompositeBuilder"
    priority: int = 0
    applies: Optional[RouteApplies] = None
    description: str = ""
    spec: Optional["RouteSpec"] = None

    def matches(self, snapshot: "ContextSnapshot", request: "GenerationRequest") -> bool:
        if self.applies is None:
            return True
        return bool(self.applies(snapshot, request))

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "PromptRoute":
        spec = RouteSpec.from_dict(data)
        return spec.build()

@dataclass
class RouteSpec:
    """Serializable spec for a custom route. Builds a CompositeBuilder
    with literal system text and a user template that interpolates `{input}`
    and any extra context keys via str.format_map (missing keys → ""). Custom
    routes have no `applies` predicate and are select-by-name only."""

    name: str
    description: str = ""
    system: str = ""
    user_template: str = "{input}"
    priority: int = 0
    generation_overrides: Mapping[str, Any] = field(default_factory=dict)
    output_policy: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "RouteSpec":
        if not isinstance(data, Mapping):
            raise TypeError(f"route spec must be a mapping (got {type(data).__name__})")
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise ValueError("route spec requires a non-empty 'name'")
        return cls(
            name=name,
            description=str(data.get("description") or ""),
            system=str(data.get("system") or ""),
            user_template=str(data.get("user_template") or "{input}"),
            priority=int(data.get("priority") or 0),
            generation_overrides=dict(data.get("generation_overrides") or {}),
            output_policy=dict(data.get("output_policy") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": CUSTOM_ROUTE_KIND,
            "name": self.name,
            "description": self.description,
            "system": self.system,
            "user_template": self.user_template,
            "priority": self.priority,
            "generation_overrides": dict(self.generation_overrides),
            "output_policy": dict(self.output_policy),
        }

    def build(self) -> PromptRoute:
        from ..builders.composite import CompositeBuilder, section

        system_text = self.system
        user_tpl = self.user_template

        def _user(ctx) -> str:
            inputs = dict(getattr(ctx.request, "inputs", {}) or {})
            inputs.setdefault("input", inputs.get("input", ""))
            try:
                return user_tpl.format_map(_SafeDict(inputs))
            except Exception:
                return user_tpl

        sys_sections = (section(system_text),) if system_text.strip() else ()
        builder = CompositeBuilder(
            name=self.name,
            user_sections=(_user,),
            system_sections=sys_sections,
            generation_overrides=dict(self.generation_overrides),
            output_policy=dict(self.output_policy),
        )
        return PromptRoute(
            name=self.name,
            builder=builder,
            priority=self.priority,
            applies=lambda *_: False,  # spec routes are select-by-name only
            description=self.description,
            spec=self,
        )


class _SafeDict(dict):
    def __missing__(self, key):
        return ""
