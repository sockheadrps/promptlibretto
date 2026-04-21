from __future__ import annotations

import time
from typing import Any, Iterable, Mapping, Optional

from .overlay import ContextOverlay, ContextSnapshot
from .template import TemplateRenderer, TemplateField, TemplateRenderOptions


class ContextStore:
    """Holds long-lived base context and short-lived overlays.

    Effective context is computed on demand by:
      1. Starting with the base text.
      2. Dropping any expired overlays.
      3. Sorting remaining overlays by priority (descending).
      4. Concatenating them after the base.
    """

    def __init__(
        self,
        base: str = "",
        renderer: Optional[TemplateRenderer] = None,
        fields: Optional[Mapping[str, Any]] = None,
    ):
        self._base = base
        self._renderer = renderer or TemplateRenderer()
        self._overlays: dict[str, ContextOverlay] = {}
        self._fields: dict[str, Any] = dict(fields or {})

    # --- base -----------------------------------------------------------
    def get_base(self) -> str:
        return self._base

    def set_base(self, value: str) -> None:
        self._base = value

    # --- structured fields ---------------------------------------------
    def set_field(self, key: str, value: Any) -> None:
        self._fields[key] = value

    def get_field(self, key: str, default: Any = None) -> Any:
        return self._fields.get(key, default)

    def fields(self) -> dict[str, Any]:
        return dict(self._fields)

    # --- templating ----------------------------------------------------
    def render_template(
        self,
        template: str,
        values: Optional[Mapping[str, Any] | Iterable[TemplateField]] = None,
        options: Optional[TemplateRenderOptions] = None,
    ) -> str:
        return self._renderer.render(template, values or self._fields, options)

    def render_base(self, options: Optional[TemplateRenderOptions] = None) -> str:
        return self._renderer.render(self._base, self._fields, options)

    # --- overlays ------------------------------------------------------
    def set_overlay(self, name: str, overlay: ContextOverlay) -> None:
        self._overlays[name] = overlay

    def clear_overlay(self, name: str) -> None:
        self._overlays.pop(name, None)

    def clear_overlays(self) -> None:
        self._overlays.clear()

    def overlays(self) -> dict[str, ContextOverlay]:
        return dict(self._overlays)

    # --- effective context --------------------------------------------
    def get_active(self, now: Optional[float] = None) -> str:
        snap = self.get_state(now)
        return snap.active

    def get_state(self, now: Optional[float] = None) -> ContextSnapshot:
        ts = time.time() if now is None else now
        live = {n: o for n, o in self._overlays.items() if not o.is_expired(ts)}
        # purge expired so they do not silently linger across calls
        if len(live) != len(self._overlays):
            self._overlays = live

        rendered_base = self.render_base()
        ordered = sorted(live.items(), key=lambda kv: kv[1].priority, reverse=True)
        sections = [rendered_base] if rendered_base else []
        for _, overlay in ordered:
            text = overlay.text.strip()
            if text:
                sections.append(text)
        active = "\n\n".join(sections).strip()
        return ContextSnapshot(
            base=rendered_base,
            active=active,
            overlays=dict(live),
            fields=dict(self._fields),
        )
