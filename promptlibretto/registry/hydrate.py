"""Hydration: walk ``assembly_order``, resolve tokens, return a string.

Token grammar (see proposedDesignChange.md for full spec):

    token     ::= "injections"
                | section_id [ "." field_ref ]

    field_ref ::= field_name
                | "groups" [ "[" group_id "]" ]
                | "scale"

Section-aware glue: ``\\n`` between consecutive tokens from the same
section, ``\\n\\n`` between different sections.
"""
from __future__ import annotations

import random as _random
import re
from typing import Any, Optional, Union

from .model import Registry
from .state import RegistryState, SectionState

# Per-section primary text field for bare "section_id" tokens.
PRIMARY_FIELD: dict[str, str] = {
    "base_context": "text",
    "personas": "context",
    "sentiment": "context",
    "static_injections": "text",
    "runtime_injections": "text",
    "output_prompt_directions": "text",
    "prompt_endings": "text",
}

# Fields whose list items get a ``pre_context`` heading when rendered.
PRE_CONTEXT_FIELDS: frozenset[str] = frozenset({"items"})

# These sections never participate in the pre_context-merge rule.
NO_MERGE_SECTIONS: frozenset[str] = frozenset({"prompt_endings"})

_BRACKET_RE = re.compile(r"^([a-z_]+)\[([^\]]+)\]$", re.IGNORECASE)
_FIELD_BRACKET_RE = re.compile(r"^([a-z_]+)\[([^\]]+)\]$", re.IGNORECASE)
_COLLAPSE_BLANKS = re.compile(r"\n{3,}")

HydrateState = RegistryState


# ── Helpers ────────────────────────────────────────────────────────────


def _resolve_section_key(reg: Registry, name: str) -> Optional[str]:
    return name if name in reg.sections else None


def _get_pre_context(item: dict[str, Any]) -> Optional[str]:
    if not item:
        return None
    return item.get("pre_context") or item.get("pre_context:") or None


def _apply_template_vars(text: Any, sec_key: str, state: RegistryState) -> str:
    """Substitute ``{var}`` placeholders using the section's resolved vars."""
    if not isinstance(text, str) or not text:
        return "" if text is None else str(text)
    vars_dict = state.get(sec_key).template_vars
    if not vars_dict:
        return text
    out = text
    for bare, val in vars_dict.items():
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
    if mode.startswith("indices:"):
        try:
            indices = [int(s) for s in mode[8:].split(",") if s.strip()]
        except ValueError:
            indices = []
        return [arr[i] for i in indices if 0 <= i < len(arr)]
    return list(arr)


def _get_array_mode(sec_key: str, field_name: str, state: RegistryState) -> Optional[str]:
    return state.get(sec_key).array_modes.get(field_name)


def _build_group_index(reg: Registry) -> dict[str, dict[str, Any]]:
    """Build an id→item lookup from the ``groups`` section."""
    index: dict[str, dict[str, Any]] = {}
    groups_sec = reg.sections.get("groups")
    if groups_sec:
        for it in groups_sec.items:
            gid = it.get("id")
            if gid:
                index[gid] = it
    return index


def _make_working_state(reg: Registry, state: RegistryState) -> RegistryState:
    """Return a copy of *state* with item ``template_defaults`` merged in.

    State values win over item defaults. This lets registries define
    sensible fallback text without requiring the caller to pass every var.
    """
    sections: dict[str, SectionState] = {}
    for sec_key, sec in reg.sections.items():
        sec_state = state.get(sec_key)
        sel_id = sec_state.selected if isinstance(sec_state.selected, str) else None
        item: Optional[dict[str, Any]] = None
        if sel_id:
            item = next((it for it in sec.items if (it.get("id") or it.get("name")) == sel_id), None)
        if item is None and sec.required and sec.items:
            item = sec.items[0]
        defaults: dict[str, str] = dict(item.get("template_defaults") or {}) if item else {}
        merged = {**defaults, **sec_state.template_vars}
        sections[sec_key] = SectionState(
            selected=sec_state.selected,
            slider=sec_state.slider,
            slider_random=sec_state.slider_random,
            section_random=sec_state.section_random,
            array_modes=dict(sec_state.array_modes),
            template_vars=merged,
        )
    return RegistryState(sections=sections)


# ── Struct types ───────────────────────────────────────────────────────


def _list_struct(
    items: list,
    pre_context: Optional[str],
    sec_key: str,
    field_name: str,
    state: RegistryState,
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    filtered = _apply_array_mode(items, _get_array_mode(sec_key, field_name, state), rng)
    if not filtered:
        return None
    return {
        "kind": "list",
        "items": [_apply_template_vars(x, sec_key, state) for x in filtered],
        "pre_context": _apply_template_vars(pre_context, sec_key, state) if pre_context else None,
        "section": sec_key,
    }


def _plain_struct(text: Any, sec_key: str, state: RegistryState) -> dict[str, Any]:
    return {
        "kind": "plain",
        "text": _apply_template_vars(text, sec_key, state),
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
    item: dict[str, Any], sec_key: str, state: RegistryState
) -> str:
    """Render text + conditional fragments. Fragment renders when its
    ``condition`` variable is non-empty in the section state."""
    pieces: list[str] = []
    base = item.get("text")
    if isinstance(base, str) and base.strip():
        pieces.append(_apply_template_vars(base, sec_key, state))
    for f in item.get("fragments") or []:
        if not isinstance(f, dict):
            continue
        condition = f.get("condition") or ""
        if condition:
            val = state.get(sec_key).template_vars.get(condition, "")
            if not val or not str(val).strip():
                continue
        text = _apply_template_vars(str(f.get("text") or ""), sec_key, state)
        if text.strip():
            pieces.append(text)
    return " ".join(pieces).strip()


def _resolve_item_with_items(
    item: dict[str, Any],
    sec_key: str,
    state: RegistryState,
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    """Render an item that has an ``items`` array, optionally prefixed by its ``text`` field.

    Used for ``prompt_endings`` items where a preamble (user message, system
    summary) lives in ``text`` and the response-label pool lives in ``items``.
    """
    list_s = _list_struct(item["items"], _get_pre_context(item), sec_key, "items", state, rng)
    item_text = item.get("text")
    if isinstance(item_text, str) and item_text.strip():
        text_rendered = _apply_template_vars(item_text, sec_key, state).strip()
        if text_rendered:
            if list_s:
                combined = text_rendered + "\n\n" + _struct_to_text(list_s)
                return {"kind": "plain", "text": combined, "section": sec_key}
            return {"kind": "plain", "text": text_rendered, "section": sec_key}
    return list_s


def _field_struct(
    item: dict[str, Any],
    field_name: str,
    sec_key: str,
    state: RegistryState,
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    if not item:
        return None
    if (
        field_name == "text"
        and isinstance(item.get("fragments"), list)
        and item["fragments"]
    ):
        out = _render_fragments(item, sec_key, state)
        return {"kind": "plain", "text": out, "section": sec_key} if out else None
    v = item.get(field_name)
    if v is None or v == "":
        return None
    if isinstance(v, list):
        pc = _get_pre_context(item) if field_name in PRE_CONTEXT_FIELDS else None
        return _list_struct(v, pc, sec_key, field_name, state, rng)
    return _plain_struct(v, sec_key, state)


def _combine_structs(
    structs: list, sec_key: str
) -> Optional[dict[str, Any]]:
    structs = [s for s in structs if s]
    if not structs:
        return None
    if len(structs) == 1:
        return structs[0]
    if all(s["kind"] == "list" for s in structs):
        pre_contexts = {s.get("pre_context") for s in structs}
        if len(pre_contexts) == 1:
            # All share the same pre_context (including all-None) — merge into one list.
            items: list[str] = []
            for s in structs:
                items.extend(s["items"])
            return {"kind": "list", "items": items, "pre_context": structs[0].get("pre_context"), "section": sec_key}
        # Different pre_contexts — keep each block distinct.
        text = "\n\n".join(_struct_to_text(s) for s in structs)
        return {"kind": "plain", "text": text, "section": sec_key} if text.strip() else None
    text = "\n\n".join(_struct_to_text(s) for s in structs)
    return (
        {"kind": "plain", "text": text, "section": sec_key} if text.strip() else None
    )


# ── Selection evaluation ────────────────────────────────────────────────


def _evaluate_selection(
    reg: Registry, state: RegistryState, sec_key: str, rng: _random.Random
):
    sec = reg.sections.get(sec_key)
    if not sec or not sec.items:
        return None if (sec and sec.required) else []

    sec_state = state.get(sec_key)

    if sec_state.section_random:
        return rng.choice(sec.items)

    sel = sec_state.selected
    if sec.required:
        if isinstance(sel, str):
            for it in sec.items:
                if (it.get("id") or it.get("name")) == sel:
                    return it
        return sec.items[0]
    if isinstance(sel, list):
        return [
            it for it in sec.items
            if (it.get("id") or it.get("name")) in sel
        ]
    return []


# ── Token resolution ───────────────────────────────────────────────────


def _resolve_groups_struct(
    sel: Any,
    sec_key: str,
    group_filter: Optional[str],
    state: RegistryState,
    group_index: dict[str, dict[str, Any]],
    rng: _random.Random,
) -> Optional[dict[str, Any]]:
    """Render ``section.groups`` or ``section.groups[group_id]``."""
    items_to_render = sel if isinstance(sel, list) else ([sel] if sel else [])
    group_structs: list[dict[str, Any]] = []
    for item in items_to_render:
        for gid_or_obj in (item.get("groups") or []):
            if isinstance(gid_or_obj, dict):
                # Inline group object — owns its own definition
                group_item: Optional[dict[str, Any]] = gid_or_obj
                gid = gid_or_obj.get("id") or gid_or_obj.get("name") or ""
            else:
                # String ID — look up in the top-level groups index
                gid = gid_or_obj
                group_item = group_index.get(gid)
            if group_filter and gid != group_filter:
                continue
            if not group_item:
                continue
            mode = state.get(sec_key).array_modes.get(f"groups[{gid}]")
            raw_items = group_item.get("items") or []
            filtered = _apply_array_mode(raw_items, mode, rng)
            if filtered:
                pc = group_item.get("pre_context")
                s = _list_struct(filtered, pc, sec_key, f"groups[{gid}]", state, rng)
                if s:
                    group_structs.append(s)
    return _combine_structs(group_structs, sec_key) if group_structs else None


def _resolve_scale_struct(
    sel: Any, state: RegistryState, rng: _random.Random
) -> Optional[dict[str, Any]]:
    """Render ``sentiment.scale`` (or any ``section.scale`` token)."""
    if not sel or isinstance(sel, list):
        return None
    scale_dict: dict[str, Any] = sel.get("scale") or {}
    label = scale_dict.get("label") or "Scale"
    raw_descriptor = (
        scale_dict.get("scale_descriptor")
        or sel.get("id")
        or "feeling"
    )
    if isinstance(raw_descriptor, list):
        descriptor = rng.choice(raw_descriptor) if raw_descriptor else "feeling"
    else:
        descriptor = raw_descriptor
    min_val = float(scale_dict.get("min_value") or 1)
    max_val = float(scale_dict.get("max_value") or 10)
    default_val = float(scale_dict.get("default_value") or 5)
    tmpl = (
        scale_dict.get("template")
        or "{label}: {value}/{max_value} — {scale_descriptor}."
    )
    sec_state = state.get("sentiment")
    if sec_state.slider_random or scale_dict.get("randomize"):
        value = rng.uniform(min_val, max_val)
    elif sec_state.slider is not None:
        value = sec_state.slider
    else:
        value = default_val
    text = (
        tmpl
        .replace("{value}", str(int(round(value))))
        .replace("{scale_descriptor}", descriptor)
        .replace("{label}", label)
        .replace("{max_value}", str(int(max_val)))
    )
    return {"kind": "plain", "text": text, "section": "sentiment"}


def _resolve_token_struct(
    token: str,
    reg: Registry,
    state: RegistryState,
    evaluated: dict[str, Any],
    rng: _random.Random,
    group_index: dict[str, dict[str, Any]],
    active_injections: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:

    # ── injections special token ──────────────────────────────────
    if token == "injections":
        if not active_injections:
            return None
        texts = []
        for inj in active_injections:
            t = _apply_template_vars(
                inj.get("text", ""), "runtime_injections", state
            ).strip()
            if t:
                texts.append(t)
        if not texts:
            return None
        combined = "\n\n".join(texts)
        return {"kind": "plain", "text": combined, "section": "runtime_injections"}

    # ── section[expr] bracket form ────────────────────────────────
    m = _BRACKET_RE.match(token)
    if m:
        sec_name, inner_expr = m.group(1), m.group(2)
        sec_key = _resolve_section_key(reg, sec_name)
        if not sec_key:
            return None
        sec = reg.sections[sec_key]
        match = next(
            (it for it in sec.items if (it.get("id") or it.get("name")) == inner_expr),
            None,
        )
        if not match:
            return None
        # For the groups section, honour state.groups.selected when set.
        # sel=None  → no preference, render unconditionally.
        # sel=[]    → nothing selected, suppress all.
        # sel=[ids] → render only listed ids.
        if sec_key == "groups":
            sel = state.get(sec_key).selected
            if sel is not None and (not sel or inner_expr not in (sel if isinstance(sel, list) else [sel])):
                return None
        if isinstance(match.get("items"), list):
            return _list_struct(
                match["items"], _get_pre_context(match), sec_key, "items", state, rng
            )
        return _field_struct(match, PRIMARY_FIELD.get(sec_key, "text"), sec_key, state, rng)

    # ── section or section.field ──────────────────────────────────
    parts = token.split(".")
    sec_key = _resolve_section_key(reg, parts[0])
    if not sec_key:
        return None
    sel = evaluated.get(sec_key)

    if len(parts) == 1:
        if isinstance(sel, list):
            structs = [
                _field_struct(it, PRIMARY_FIELD.get(sec_key, "text"), sec_key, state, rng)
                for it in sel
            ]
            return _combine_structs(structs, sec_key)
        if sel:
            if isinstance(sel.get("items"), list):
                return _resolve_item_with_items(sel, sec_key, state, rng)
            return _field_struct(sel, PRIMARY_FIELD.get(sec_key, "text"), sec_key, state, rng)
        return None

    sub = ".".join(parts[1:])

    # ── section.scale ─────────────────────────────────────────────
    if sub == "scale":
        s = _resolve_scale_struct(sel, state, rng)
        if s:
            s["section"] = sec_key
        return s

    # ── section.groups or section.groups[id] ──────────────────────
    fb_m = _FIELD_BRACKET_RE.match(sub)
    field_base = fb_m.group(1) if fb_m else sub
    group_filter = fb_m.group(2) if fb_m else None

    if field_base == "groups":
        return _resolve_groups_struct(sel, sec_key, group_filter, state, group_index, rng)

    # ── section.field_name ────────────────────────────────────────
    if sel and not isinstance(sel, list) and sub in sel:
        return _field_struct(sel, sub, sec_key, state, rng)
    if isinstance(sel, list):
        structs = [_field_struct(it, sub, sec_key, state, rng) for it in sel]
        combined = _combine_structs(structs, sec_key)
        if combined:
            return combined
    # fallback: look for item with that id/name in the section
    sec = reg.sections[sec_key]
    pool = next(
        (it for it in sec.items if (it.get("id") or it.get("name")) == sub), None
    )
    if pool:
        if isinstance(pool.get("items"), list):
            return _resolve_item_with_items(pool, sec_key, state, rng)
        return _field_struct(pool, PRIMARY_FIELD.get(sec_key, "text"), sec_key, state, rng)
    # fallback: pool-shaped selected item
    if sel and not isinstance(sel, list) and isinstance(sel.get("items"), list):
        return _resolve_item_with_items(sel, sec_key, state, rng)
    if isinstance(sel, list):
        pool_structs = []
        for it in sel:
            if isinstance(it.get("items"), list):
                s = _list_struct(
                    it["items"], _get_pre_context(it), sec_key, "items", state, rng
                )
                if s:
                    pool_structs.append(s)
        if pool_structs:
            return _combine_structs(pool_structs, sec_key)
    return None


def _token_section(token: str, reg: Registry) -> str:
    if token == "injections":
        return "runtime_injections"
    m = _BRACKET_RE.match(token)
    if m:
        return _resolve_section_key(reg, m.group(1)) or m.group(1)
    head = token.split(".")[0]
    return _resolve_section_key(reg, head) or head


# ── Public API ─────────────────────────────────────────────────────────


def hydrate(
    reg: Registry,
    state: Optional[Union[RegistryState, dict]] = None,
    *,
    route: Optional[str] = None,
    seed: Optional[int] = None,
) -> str:
    """Build the final prompt string for *reg* + *state*.

    *state* may be a :class:`RegistryState` instance, a plain dict
    (``RegistryState.from_dict`` is called automatically), or ``None``
    (uses ``Registry.default_state`` if present).

    *route*: when set and present in ``reg.routes``, its assembly_order
    overrides the registry default.
    *seed*: deterministic randomness for tests; omit for fresh rolls.
    """
    # Resolve state: explicit > route default > registry default > empty
    if state is None:
        rs: RegistryState = RegistryState()
    elif isinstance(state, dict):
        rs = RegistryState.from_dict(state)
    else:
        rs = state

    # Merge in route/registry default_state (caller-provided values win)
    active_route = reg.routes.get(route) if route else None
    if active_route and active_route.default_state:
        base = active_route.default_state
        merged_sections = {**base.sections, **rs.sections}
        rs = RegistryState(sections=merged_sections)
    elif reg.default_state:
        base = reg.default_state
        merged_sections = {**base.sections, **rs.sections}
        rs = RegistryState(sections=merged_sections)

    # Merge item template_defaults into working state
    rs = _make_working_state(reg, rs)

    rng = _random.Random(seed)
    order = list(reg.assembly_order)
    if active_route and active_route.assembly_order is not None:
        order = list(active_route.assembly_order)

    evaluated = {k: _evaluate_selection(reg, rs, k, rng) for k in reg.sections}
    group_index = _build_group_index(reg)

    # Active runtime injections
    active = (
        evaluated.get("runtime_injections")
        if isinstance(evaluated.get("runtime_injections"), list)
        else []
    )

    # Resolve tokens
    resolved: list[dict[str, Any]] = []
    injections_in_order = any(t == "injections" for t in order)
    for tok in order:
        sec = _token_section(tok, reg)
        s = _resolve_token_struct(tok, reg, rs, evaluated, rng, group_index, active)
        if not s:
            continue
        s["_section"] = sec
        resolved.append(s)

    # If active injections but ``injections`` not in assembly_order, append
    if active and not injections_in_order:
        inj_texts = []
        for inj in active:
            t = _apply_template_vars(
                inj.get("text", ""), "runtime_injections", rs
            ).strip()
            if t:
                inj_texts.append(t)
        if inj_texts:
            resolved.append({
                "kind": "plain",
                "text": "\n\n".join(inj_texts),
                "section": "runtime_injections",
                "_section": "runtime_injections",
            })

    # Merge adjacent list structs sharing a pre_context
    merged: list[dict[str, Any]] = []
    for s in resolved:
        last = merged[-1] if merged else None
        can_merge = (
            last is not None
            and last["kind"] == "list"
            and s["kind"] == "list"
            and last.get("pre_context")
            and (s.get("pre_context") is None or s["pre_context"] == last["pre_context"])
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

    # Render with section-aware glue
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

    return _COLLAPSE_BLANKS.sub("\n\n", out).strip()
