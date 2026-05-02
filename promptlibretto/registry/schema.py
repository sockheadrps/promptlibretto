"""StateSchema: derive valid state settings from a Registry.

Tools and studio use this to know what controls to render (what items are
selectable, what slider range, which template vars exist) without having to
inspect the raw section items themselves.

Usage::

    from promptlibretto import load_registry
    from promptlibretto.registry.schema import derive_state_schema

    eng = load_registry("my_agent.json")
    schema = derive_state_schema(eng.registry)
    print(schema.to_dict())
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Optional

from .model import Registry, Scale


@dataclass
class SelectableItem:
    id: str
    label: str = ""


@dataclass
class SectionStateSchema:
    section_id: str
    label: str = ""
    required: bool = True
    selectable: list[SelectableItem] = field(default_factory=list)
    has_slider: bool = False
    slider_min: float = 1.0
    slider_max: float = 10.0
    slider_default: float = 5.0
    template_vars: list[str] = field(default_factory=list)
    template_defaults: dict[str, str] = field(default_factory=dict)
    array_mode_fields: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "section_id": self.section_id,
            "required": self.required,
            "selectable": [dataclasses.asdict(s) for s in self.selectable],
        }
        if self.label:
            out["label"] = self.label
        if self.has_slider:
            out["slider"] = {
                "min": self.slider_min,
                "max": self.slider_max,
                "default": self.slider_default,
            }
        if self.template_vars:
            out["template_vars"] = list(self.template_vars)
        if self.template_defaults:
            out["template_defaults"] = dict(self.template_defaults)
        if self.array_mode_fields:
            out["array_mode_fields"] = list(self.array_mode_fields)
        return out


@dataclass
class StateSchema:
    sections: dict[str, SectionStateSchema] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {k: v.to_dict() for k, v in self.sections.items()}


def derive_state_schema(registry: Registry) -> StateSchema:
    """Build a StateSchema from a Registry by inspecting its sections and items."""
    section_schemas: dict[str, SectionStateSchema] = {}

    for sec_id, sec in registry.sections.items():
        selectable: list[SelectableItem] = []
        has_slider = False
        slider_min, slider_max, slider_default = 1.0, 10.0, 5.0
        all_vars: list[str] = []
        all_defaults: dict[str, str] = {}
        array_fields: list[str] = []

        for item in sec.items:
            item_id = item.get("id") or item.get("name") or ""
            item_label = item.get("label") or ""
            if item_id:
                selectable.append(SelectableItem(id=item_id, label=item_label))

            # Scale from Sentiment (or any ScalableMixin item)
            scale_data = item.get("scale")
            if scale_data and isinstance(scale_data, dict):
                has_slider = True
                slider_min = float(scale_data.get("min_value") or 1)
                slider_max = float(scale_data.get("max_value") or 10)
                slider_default = float(scale_data.get("default_value") or 5)

            # Template vars and defaults
            for v in item.get("template_vars") or []:
                if v not in all_vars:
                    all_vars.append(v)
            all_defaults.update(item.get("template_defaults") or {})

            # Array-mode eligible fields: any list field on the item
            for k, v in item.items():
                if k in ("id", "label", "display", "metadata"):
                    continue
                if isinstance(v, list) and k not in array_fields:
                    array_fields.append(k)

        section_schemas[sec_id] = SectionStateSchema(
            section_id=sec_id,
            label=sec.label,
            required=sec.required,
            selectable=selectable,
            has_slider=has_slider,
            slider_min=slider_min,
            slider_max=slider_max,
            slider_default=slider_default,
            template_vars=all_vars,
            template_defaults=all_defaults,
            array_mode_fields=array_fields,
        )

    return StateSchema(sections=section_schemas)
