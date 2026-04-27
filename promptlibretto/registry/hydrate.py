"""Hydration: walk ``assembly_order``, resolve tokens, return a string.

Mirrors the JS resolver in ``studio/static/appv2.js``. Edge cases that
matter:

* tight ``\\n`` glue between consecutive same-section tokens, ``\\n\\n``
  between different sections;
* per-array runtime modes — ``all`` / ``index:N`` / ``random:K`` / ``none``;
* ``pre_context`` heading prepended to ``items`` / ``examples`` arrays;
* adjacent list tokens with the same (or chained) ``pre_context`` merge
  into one bulleted list under one heading;
* ``prompt_endings`` never participates in the merge;
* ``sentiment.scale`` synthetic token — slider value + emotion noun;
* active runtime injections filter the rendered tokens to their union of
  ``include_sections`` and append their text at the end.
"""
from __future__ import annotations

import random as _random
import re
from dataclasses import dataclass, field
from typing import Any, Optional, Union

from .model import Registry

# Per-section primary text field (for bare token like "personas").
PRIMARY_FIELD: dict[str, str] = {
    "base_context": "text",
    "personas": "context",
    "sentiment": "context",
    "static_injections": "text",
    "runtime_injections": "text",
    "output_prompt_directions": "text",
    "prompt_endings": "text",
}

# Singular aliases used in assembly_order tokens.
ALIAS: dict[str, str] = {
    "persona": "personas",
    "sentiments": "sentiment",
    "injections": "static_injections",
    "ending": "prompt_endings",
    "endings": "prompt_endings",
}

# Fields that, when rendered as a list, get prefixed by the item's
# ``pre_context`` heading.
PRE_CONTEXT_FIELDS: frozenset[str] = frozenset({"items", "examples"})

# Sections that always start their own block — never absorbed by the
# pre_context-merge rule.
NO_MERGE_SECTIONS: frozenset[str] = frozenset({"prompt_endings"})

# id → emotion noun for the sentiment.scale token. Items can override via
# their own ``scale_emotion`` field.
SENTIMENT_EMOTIONS: dict[str, str] = {"positive": "excited", "negative": "annoyed"}

_BRACKET_RE = re.compile(r"^([a-z_]+)\[([^\]]+)\]$", re.IGNORECASE)
_COLLAPSE_BLANKS = re.compile(r"\n{3,}")


# ── State ──────────────────────────────────────────────────────────


@dataclass
class HydrateState:
    """Per-call state — selections, runtime modes, slider, template-vars."""

    selections: dict[str, Union[str, list[str], None]] = field(default_factory=dict)
    array_modes: dict[str, dict[str, str]] = field(default_factory=dict)
    section_random: dict[str, bool] = field(default_factory=dict)
    sliders: dict[str, float] = field(default_factory=dict)
    slider_random: dict[str, bool] = field(default_factory=dict)
    template_vars: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Optional[dict[str, Any]] = None) -> "HydrateState":
        data = data or {}
        return cls(
            selections=dict(data.get("selections") or {}),
            array_modes={
                k: dict(v) for k, v in (data.get("array_modes") or {}).items()
            },
            section_random=dict(data.get("section_random") or {}),
            sliders=dict(data.get("sliders") or {}),
            slider_random=dict(data.get("slider_random") or {}),
            template_vars=dict(data.get("template_vars") or {}),
        )


# ── Helpers ────────────────────────────────────────────────────────


def _resolve_section_key(reg: Registry, name: str) -> Optional[str]:
    if name in reg.sections:
        return name
    if name in ALIAS and ALIAS[name] in reg.sections:
        return ALIAS[name]
    return None


def _get_pre_context(item: dict[str, Any]) -> Optional[str]:
    if not item:
        return None
    # Tolerate the trailing-colon typo `pre_context:` alongside the canonical key.
    return item.get("pre_context") or item.get("pre_context:") or None


def _apply_template_vars(
    text: Any, section_key: str, reg: Registry, state: HydrateState
) -> str:
    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)
    sec = reg.sections.get(section_key)
    if not sec or not sec.template_vars:
        return text
    out = text
    for v in sec.template_vars:
        val = state.template_vars.get(f"{section_key}::{v}", "")
        bare = v.lstrip("{").rstrip("}")
        # Only replace the canonical `{name}` form — substituting on the
        # bare name would clobber substrings inside other words.
        out = out.replace(f"{{{bare}}}", val)
    return out


def _apply_array_mode(arr: list, mode: Optional[str], rng: _random.Random) -> list:
    if not isinstance(arr, list) or not mode or mode == "all":
        return list(arr) if isinstance(arr, list) else []
    if mode == "none":
        return []
    if mode.startswith("random:"):
        try:
            k = max(1, int(mode[7:]))
        except ValueError:
            k = 1
        copy = list(arr)
        rng.shuffle(copy)
        return copy[: min(k, len(copy))]
    if mode.startswith("index:"):
        try:
            i = int(mode[6:])
        except ValueError:
            i = 0
        if 0 <= i < len(arr):
            return [arr[i]]
        return []
    return list(arr)


def _get_array_mode(
    section_key: str, field_name: str, state: HydrateState
) -> Optional[str]:
    return state.array_modes.get(section_key, {}).get(field_name)


# ── Struct types (plain dicts; "kind" tells you which) ─────────────


def _list_struct(
    items: list,
    pre_context: Optional[str],
    sec_key: str,
    field_name: str,
    reg: Registry,
    state: HydrateState,
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    filtered = _apply_array_mode(
        items, _get_array_mode(sec_key, field_name, state), rng
    )
    if not filtered:
        return None
    return {
        "kind": "list",
        "items": [_apply_template_vars(x, sec_key, reg, state) for x in filtered],
        "pre_context": _apply_template_vars(pre_context, sec_key, reg, state)
        if pre_context
        else None,
        "section": sec_key,
    }


def _plain_struct(text: Any, sec_key: str, reg: Registry, state: HydrateState) -> dict[str, Any]:
    return {
        "kind": "plain",
        "text": _apply_template_vars(text, sec_key, reg, state),
        "section": sec_key,
    }


def _struct_to_text(s: Optional[dict[str, Any]]) -> str:
    if not s:
        return ""
    if s["kind"] == "plain":
        return s["text"]
    use_bullets = bool(s.get("pre_context")) or len(s["items"]) >= 2
    body = (
        "\n".join(f"- {x}" for x in s["items"])
        if use_bullets
        else "\n".join(s["items"])
    )
    return s["pre_context"] + "\n" + body if s.get("pre_context") else body


def _render_fragments(
    item: dict[str, Any], sec_key: str, reg: Registry, state: HydrateState
) -> str:
    """Render text + conditional fragments. Each fragment has optional
    ``if_var``; if that var has no value at runtime, the fragment is
    skipped — so unused vars never leave broken sentences."""
    pieces: list[str] = []
    base = item.get("text")
    if isinstance(base, str) and base.strip():
        pieces.append(_apply_template_vars(base, sec_key, reg, state))
    for f in item.get("fragments") or []:
        if not isinstance(f, dict):
            continue
        if_var = f.get("if_var") or f.get("var") or ""
        if if_var:
            val = state.template_vars.get(f"{sec_key}::{if_var}", "")
            if not val or not str(val).strip():
                continue
        text = _apply_template_vars(str(f.get("text") or ""), sec_key, reg, state)
        if text.strip():
            pieces.append(text)
    return " ".join(pieces).strip()


def _field_struct(
    item: dict[str, Any],
    field_name: str,
    sec_key: str,
    reg: Registry,
    state: HydrateState,
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    if not item:
        return None
    if (
        field_name == "text"
        and isinstance(item.get("fragments"), list)
        and item["fragments"]
    ):
        out = _render_fragments(item, sec_key, reg, state)
        return {"kind": "plain", "text": out, "section": sec_key} if out else None
    v = item.get(field_name)
    if v is None or v == "":
        return None
    if isinstance(v, list):
        pc = _get_pre_context(item) if field_name in PRE_CONTEXT_FIELDS else None
        return _list_struct(v, pc, sec_key, field_name, reg, state, rng)
    return _plain_struct(v, sec_key, reg, state)


def _combine_structs(
    structs: list, sec_key: str
) -> Optional[dict[str, Any]]:
    structs = [s for s in structs if s]
    if not structs:
        return None
    if all(s["kind"] == "list" for s in structs):
        items: list[str] = []
        pc: Optional[str] = None
        for s in structs:
            items.extend(s["items"])
            if pc is None and s.get("pre_context"):
                pc = s["pre_context"]
        return {"kind": "list", "items": items, "pre_context": pc, "section": sec_key}
    text = "\n\n".join(_struct_to_text(s) for s in structs)
    return (
        {"kind": "plain", "text": text, "section": sec_key} if text.strip() else None
    )


# ── Selection evaluation ──────────────────────────────────────────


def _evaluate_selection(
    reg: Registry, state: HydrateState, sec_key: str, rng: _random.Random
):
    sec = reg.sections.get(sec_key)
    if not sec or not sec.items:
        return None if (sec and sec.required) else []

    # Section-level random override.
    if state.section_random.get(sec_key):
        return rng.choice(sec.items)

    sel = state.selections.get(sec_key)
    if sec.required:
        if isinstance(sel, str):
            for it in sec.items:
                if (it.get("id") or it.get("name")) == sel:
                    return it
        return sec.items[0]
    if isinstance(sel, list):
        return [
            it for it in sec.items if (it.get("id") or it.get("name")) in sel
        ]
    return []


# ── Token resolution ──────────────────────────────────────────────


def _resolve_token_struct(
    token: str,
    reg: Registry,
    state: HydrateState,
    evaluated: dict[str, Any],
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    # sentiment.scale: synthetic token
    if token == "sentiment.scale":
        sel = evaluated.get("sentiment")
        if not sel or isinstance(sel, list):
            return None
        if state.slider_random.get("sentiment"):
            value = rng.randint(1, 10)
        else:
            value = int(state.sliders.get("sentiment", 5))
        emotion = (
            sel.get("scale_emotion")
            or SENTIMENT_EMOTIONS.get(sel.get("id"))
            or sel.get("id")
            or "feeling"
        )
        return {
            "kind": "plain",
            "text": f"on a scale of 1-10 chat is {int(value)} on {emotion}",
            "section": "sentiment",
        }

    m = _BRACKET_RE.match(token)
    if m:
        sec_name, inner_expr = m.group(1), m.group(2)
        sec_key = _resolve_section_key(reg, sec_name)
        if not sec_key:
            return None
        inner_struct = _resolve_token_struct(inner_expr, reg, state, evaluated, rng)
        inner_val = _struct_to_text(inner_struct)
        if not inner_val:
            return None
        sec = reg.sections[sec_key]
        match = next(
            (
                it
                for it in sec.items
                if (it.get("name") or it.get("id")) == inner_val
            ),
            None,
        )
        if not match:
            return None
        if isinstance(match.get("items"), list):
            return _list_struct(
                match["items"],
                _get_pre_context(match),
                sec_key,
                "items",
                reg,
                state,
                rng,
            )
        return _field_struct(
            match, PRIMARY_FIELD.get(sec_key, "text"), sec_key, reg, state, rng
        )

    parts = token.split(".")
    sec_key = _resolve_section_key(reg, parts[0])
    if not sec_key:
        return None
    sec = reg.sections[sec_key]
    sel = evaluated.get(sec_key)

    if len(parts) == 1:
        if isinstance(sel, list):
            structs = [
                _field_struct(
                    it, PRIMARY_FIELD.get(sec_key, "text"), sec_key, reg, state, rng
                )
                for it in sel
            ]
            return _combine_structs(structs, sec_key)
        if sel:
            if isinstance(sel.get("items"), list):
                return _list_struct(
                    sel["items"],
                    _get_pre_context(sel),
                    sec_key,
                    "items",
                    reg,
                    state,
                    rng,
                )
            return _field_struct(
                sel, PRIMARY_FIELD.get(sec_key, "text"), sec_key, reg, state, rng
            )
        return None

    sub = ".".join(parts[1:])
    if sel and not isinstance(sel, list) and sub in sel:
        return _field_struct(sel, sub, sec_key, reg, state, rng)
    if isinstance(sel, list):
        structs = [_field_struct(it, sub, sec_key, reg, state, rng) for it in sel]
        combined = _combine_structs(structs, sec_key)
        if combined:
            return combined
    pool = next(
        (it for it in sec.items if (it.get("name") or it.get("id")) == sub), None
    )
    if pool:
        if isinstance(pool.get("items"), list):
            return _list_struct(
                pool["items"],
                _get_pre_context(pool),
                sec_key,
                "items",
                reg,
                state,
                rng,
            )
        return _field_struct(
            pool, PRIMARY_FIELD.get(sec_key, "text"), sec_key, reg, state, rng
        )
    # Fallback: pool-shaped selected item (items[]).
    if sel and not isinstance(sel, list) and isinstance(sel.get("items"), list):
        return _list_struct(
            sel["items"], _get_pre_context(sel), sec_key, "items", reg, state, rng
        )
    if isinstance(sel, list):
        pool_structs = []
        for it in sel:
            if isinstance(it.get("items"), list):
                s = _list_struct(
                    it["items"], _get_pre_context(it), sec_key, "items", reg, state, rng
                )
                if s:
                    pool_structs.append(s)
        if pool_structs:
            return _combine_structs(pool_structs, sec_key)
    return None


def _token_section(token: str, reg: Registry) -> str:
    m = _BRACKET_RE.match(token)
    if m:
        return _resolve_section_key(reg, m.group(1)) or m.group(1)
    head = token.split(".")[0]
    return _resolve_section_key(reg, head) or head


# ── Public API ────────────────────────────────────────────────────


def hydrate(
    reg: Registry,
    state: Optional[HydrateState] = None,
    *,
    route: Optional[str] = None,
    seed: Optional[int] = None,
) -> str:
    """Build the final prompt string for *reg* + *state*.

    *route*: when set and present in ``reg.routes``, its ``assembly_order``
    overrides the registry default.
    *seed*: deterministic randomness for tests; omit for fresh rolls.
    """
    state = state or HydrateState()
    rng = _random.Random(seed)

    order = list(reg.assembly_order)
    if route and route in reg.routes and reg.routes[route].assembly_order is not None:
        order = list(reg.routes[route].assembly_order)

    evaluated = {k: _evaluate_selection(reg, state, k, rng) for k in reg.sections}

    # Active runtime injections — they filter rendered sections + append text.
    active = (
        evaluated.get("runtime_injections")
        if isinstance(evaluated.get("runtime_injections"), list)
        else []
    )
    allowed: Optional[set[str]] = None
    if active:
        allowed = {"runtime_injections"}
        for inj in active:
            for s in inj.get("include_sections") or []:
                allowed.add(s)

    # Resolve every token (filtered by allowed sections if any injection is active).
    resolved: list[dict[str, Any]] = []
    for tok in order:
        sec = _token_section(tok, reg)
        if allowed is not None and sec not in allowed:
            continue
        s = _resolve_token_struct(tok, reg, state, evaluated, rng)
        if not s:
            continue
        s["_section"] = sec
        resolved.append(s)

    # Merge adjacent list structs with shared pre_context (or chained none).
    merged: list[dict[str, Any]] = []
    for s in resolved:
        last = merged[-1] if merged else None
        can_merge = (
            last is not None
            and last["kind"] == "list"
            and s["kind"] == "list"
            and last.get("pre_context")
            and (
                s.get("pre_context") is None
                or s["pre_context"] == last["pre_context"]
            )
            and s["_section"] not in NO_MERGE_SECTIONS
            and last["_section"] not in NO_MERGE_SECTIONS
        )
        if can_merge:
            last["items"] = list(last["items"]) + list(s["items"])
        else:
            copy = dict(s)
            if copy["kind"] == "list":
                copy["items"] = list(copy["items"])
            merged.append(copy)

    # Render with section-aware glue.
    out = ""
    prev_section: Optional[str] = None
    for s in merged:
        text = _struct_to_text(s)
        if not text:
            continue
        if out:
            out += "\n" if s["_section"] == prev_section else "\n\n"
        out += text
        prev_section = s["_section"]

    final = _COLLAPSE_BLANKS.sub("\n\n", out).strip()

    # Append active runtime injection text(s).
    if active:
        inj_texts: list[str] = []
        for inj in active:
            t = _apply_template_vars(
                inj.get("text", ""), "runtime_injections", reg, state
            ).strip()
            if t:
                inj_texts.append(t)
        if inj_texts:
            final = (final + "\n\n" if final else "") + "\n\n".join(inj_texts)

    return final
