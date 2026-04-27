"""Slot-based template rendering for promptlibretto v2.

Templates use ``{name}`` for required slots and ``{name?}`` for optional ones.
Rendering is deterministic: same inputs → same output.
"""
from __future__ import annotations

import re
from typing import Any

_SLOT_RE = re.compile(r"\{([a-zA-Z0-9_]+\??)\}")


def render_template(template: str, context: dict[str, Any]) -> str:
    """Substitute ``{name}`` and ``{name?}`` slots from *context*.

    * ``{name}``  — required; raises :class:`ValueError` if missing.
    * ``{name?}`` — optional; renders as ``""`` if missing.
    """

    def _replace(match: re.Match) -> str:
        key = match.group(1)
        optional = key.endswith("?")
        if optional:
            key = key[:-1]
        if key in context:
            return str(context[key])
        if optional:
            return ""
        raise ValueError(f"Missing required slot: {key}")

    return _SLOT_RE.sub(_replace, template)


def render_sections(
    sections: list[str],
    context: dict[str, Any],
    separator: str = "\n\n",
) -> str:
    """Render each section template, drop empties, join with *separator*."""
    rendered: list[str] = []
    for s in sections:
        text = render_template(s, context).strip()
        if text:
            rendered.append(text)
    return separator.join(rendered)


def extract_slots(template: str) -> list[tuple[str, bool]]:
    """Return ``[(name, optional), ...]`` for every slot in *template*."""
    seen: set[str] = set()
    out: list[tuple[str, bool]] = []
    for m in _SLOT_RE.finditer(template):
        raw = m.group(1)
        optional = raw.endswith("?")
        name = raw[:-1] if optional else raw
        if name not in seen:
            seen.add(name)
            out.append((name, optional))
    return out
