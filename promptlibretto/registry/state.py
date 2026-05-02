"""Runtime selection state — separate from the Registry blueprint."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Union


@dataclass
class SectionState:
    """Runtime state for one section: what's selected, slider, array sampling, vars."""

    selected: Union[str, list[str], None] = None
    slider: Optional[float] = None
    slider_random: bool = False
    section_random: bool = False
    array_modes: dict[str, str] = field(default_factory=dict)
    template_vars: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.selected is not None:
            out["selected"] = (
                self.selected if isinstance(self.selected, str) else list(self.selected)
            )
        if self.slider is not None:
            out["slider"] = self.slider
        if self.slider_random:
            out["slider_random"] = True
        if self.section_random:
            out["section_random"] = True
        if self.array_modes:
            out["array_modes"] = dict(self.array_modes)
        if self.template_vars:
            out["template_vars"] = dict(self.template_vars)
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SectionState":
        return cls(
            selected=data.get("selected"),
            slider=data.get("slider"),
            slider_random=bool(data.get("slider_random", False)),
            section_random=bool(data.get("section_random", False)),
            array_modes=dict(data.get("array_modes") or {}),
            template_vars=dict(data.get("template_vars") or {}),
        )


@dataclass
class RegistryState:
    """Full runtime state for a registry — one SectionState per section."""

    sections: dict[str, SectionState] = field(default_factory=dict)

    def get(self, section_id: str) -> SectionState:
        """Return the SectionState for *section_id*, or a blank default."""
        return self.sections.get(section_id) or SectionState()

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, v in self.sections.items():
            d = v.to_dict()
            if d:
                out[k] = d
        return out

    @classmethod
    def from_dict(cls, data: Optional[dict[str, Any]] = None) -> "RegistryState":
        if not data:
            return cls()
        return cls(
            sections={
                k: SectionState.from_dict(v)
                for k, v in data.items()
                if isinstance(v, dict)
            }
        )
