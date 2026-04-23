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
) -> ContextOverlay:
    """Overlay representing an iteration turn. Uses the compacted text when
    given; always keeps the verbatim original in metadata for revert/recompact.
    """
    text = compacted if compacted else verbatim
    meta: dict[str, Any] = {"verbatim": verbatim, "kind": "turn"}
    if compacted:
        meta["compacted"] = compacted
    return ContextOverlay(text=text, priority=priority, metadata=meta)


def make_runtime_overlay(
    mode: str,
    *,
    placeholder: str = "",
    priority: int = 20,
) -> ContextOverlay:
    """Overlay that renders as a `{name}` slot in the active context (filled
    in by the builder's `format_map` step).

    `mode` must be `"optional"` or `"required"` — required slots are expected
    to be supplied per-call; optional ones format to empty when absent.
    `placeholder` is stored as the overlay text but never rendered while the
    runtime metadata is set; it's there so revert/inspection tools have
    something to show.
    """
    m = mode.lower()
    if m not in ("optional", "required"):
        raise ValueError(f"runtime overlay mode must be 'optional' or 'required' (got {mode!r})")
    return ContextOverlay(
        text=placeholder,
        priority=priority,
        metadata={"runtime": m},
    )


@dataclass
class ContextSnapshot:
    base: str
    active: str
    overlays: dict[str, ContextOverlay] = field(default_factory=dict)

    def with_overlays(self, overlays: Mapping[str, ContextOverlay]) -> "ContextSnapshot":
        """Return a new snapshot with `active` rebuilt from `base` + overlays
        (priority desc). Does not mutate the source store.
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
        )
