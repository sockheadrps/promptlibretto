from __future__ import annotations

import time
from typing import Optional

from .overlay import ContextOverlay, ContextSnapshot


class ContextStore:
    """Holds a base context string and a set of named overlays. Effective
    context is base + live overlays sorted by priority (desc); expired
    overlays are dropped on read.

    Slot substitution (`{name}`) is the caller's job — happens at the
    builder/format_map boundary, not here.
    """

    def __init__(self, base: str = ""):
        self._base = base
        self._overlays: dict[str, ContextOverlay] = {}

    def set_base(self, value: str) -> None:
        self._base = value

    def set_overlay(self, name: str, overlay: ContextOverlay) -> None:
        self._overlays[name] = overlay

    def clear_overlay(self, name: str) -> None:
        self._overlays.pop(name, None)

    def clear_overlays(self) -> None:
        self._overlays.clear()

    def overlays(self) -> dict[str, ContextOverlay]:
        return dict(self._overlays)

    def get_active(self, now: Optional[float] = None) -> str:
        return self.get_state(now).active

    def prune(self, now: Optional[float] = None) -> list[str]:
        """Drop expired overlays from the store. Returns the names removed.

        Call this when you want to reclaim memory or surface expirations;
        `get_state` no longer prunes as a side effect.
        """
        ts = time.time() if now is None else now
        expired = [n for n, o in self._overlays.items() if o.is_expired(ts)]
        for n in expired:
            del self._overlays[n]
        return expired

    def get_state(self, now: Optional[float] = None) -> ContextSnapshot:
        """Pure read: build a snapshot of the live (non-expired) overlays.
        Does not mutate the store; call `prune()` separately to evict.
        """
        ts = time.time() if now is None else now
        live = {n: o for n, o in self._overlays.items() if not o.is_expired(ts)}

        ordered = sorted(live.items(), key=lambda kv: kv[1].priority, reverse=True)
        sections = [self._base] if self._base else []
        for name, overlay in ordered:
            mode = str((overlay.metadata or {}).get("runtime") or "").lower()
            if mode in ("optional", "required"):
                # Runtime overlays are slot markers — render as `{name}` so
                # downstream format_map can fill them in.
                sections.append("{" + name + "}")
                continue
            text = overlay.text.strip()
            if text:
                sections.append(text)
        active = "\n\n".join(sections).strip()
        return ContextSnapshot(
            base=self._base,
            active=active,
            overlays=dict(live),
        )
