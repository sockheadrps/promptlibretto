from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional


@dataclass
class ContextOverlay:
    text: str
    priority: int = 0
    expires_at: Optional[float] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def is_expired(self, now: float) -> bool:
        return self.expires_at is not None and self.expires_at <= now


def make_turn_overlay(
    verbatim: str,
    compacted: Optional[str] = None,
    *,
    priority: int = 25,
    extra_metadata: Optional[Mapping[str, Any]] = None,
) -> ContextOverlay:
    """Build an overlay representing a user iteration turn.

    The active text is the compacted form when present (denser context for
    future turns), otherwise the verbatim text. The verbatim original is
    always preserved in metadata so callers can revert or re-compact later.
    """
    text = compacted if compacted else verbatim
    meta: dict[str, Any] = {"verbatim": verbatim, "kind": "turn"}
    if compacted:
        meta["compacted"] = compacted
    if extra_metadata:
        meta.update(dict(extra_metadata))
    return ContextOverlay(text=text, priority=priority, metadata=meta)


@dataclass
class ContextSnapshot:
    base: str
    active: str
    overlays: dict[str, ContextOverlay] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)

    def with_overlays(self, overlays: Mapping[str, ContextOverlay]) -> "ContextSnapshot":
        """Return a new snapshot with `active` rebuilt from `base` + `overlays`.

        Priority order (desc) is preserved. Used by the engine's prompt-size
        budget trim to produce a snapshot with the lowest-priority overlays
        dropped without touching the underlying ContextStore.
        """
        ordered = sorted(overlays.items(), key=lambda kv: kv[1].priority, reverse=True)
        sections = [self.base] if self.base else []
        for _, overlay in ordered:
            text = overlay.text.strip()
            if text:
                sections.append(text)
        active = "\n\n".join(sections).strip()
        return ContextSnapshot(
            base=self.base,
            active=active,
            overlays=dict(overlays),
            fields=dict(self.fields),
        )
