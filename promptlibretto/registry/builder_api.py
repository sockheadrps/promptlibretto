"""
promptlibretto/registry/builder_api.py

In-memory registry draft store and mutation API.
All public functions return plain dicts suitable for JSON serialization.
Import this from mcp_registry_server.py — no MCP dependencies here.
"""
from __future__ import annotations

import copy
import uuid
from typing import Any

KNOWN_SECTIONS: tuple[str, ...] = (
    "base_context",
    "personas",
    "sentiment",
    "static_injections",
    "runtime_injections",
    "output_prompt_directions",
    "memory_recall",
    "prompt_endings",
)

REQUIRED_SECTIONS: frozenset[str] = frozenset({
    "base_context",
    "personas",
    "sentiment",
    "output_prompt_directions",
    "prompt_endings",
})

# ── draft store ──────────────────────────────────────────────────────────────
_drafts: dict[str, dict[str, Any]] = {}


def _initial_registry() -> dict[str, Any]:
    reg: dict[str, Any] = {
        "version": 2,
        "title": "",
        "description": "",
        "assembly_order": [],
        "generation": {},
        "output_policy": {},
    }
    for key in KNOWN_SECTIONS:
        reg[key] = {"required": key in REQUIRED_SECTIONS, "template_vars": [], "items": []}
    return reg


def _get(draft_id: str) -> dict[str, Any]:
    if draft_id not in _drafts:
        raise KeyError(f"Draft '{draft_id}' not found.")
    return _drafts[draft_id]


def _normalize_var(v: str) -> str:
    return v.strip().lstrip("{").rstrip("}")


def _find_item(items: list[dict], key: str) -> dict[str, Any] | None:
    for it in items:
        if it.get("id") == key or it.get("name") == key:
            return it
    return None


def _find_inline_group(reg: dict[str, Any], group_id: str) -> dict[str, Any] | None:
    for sec_key in KNOWN_SECTIONS:
        for item in reg.get(sec_key, {}).get("items", []):
            for g in item.get("groups", []):
                if isinstance(g, dict) and g.get("id") == group_id:
                    return g
    return None


# ── lifecycle ────────────────────────────────────────────────────────────────

def draft_create(title: str = "", description: str = "") -> dict[str, Any]:
    """Create a new draft. Returns {draft_id, registry}."""
    draft_id = str(uuid.uuid4())[:8]
    reg = _initial_registry()
    if title:
        reg["title"] = title
    if description:
        reg["description"] = description
    _drafts[draft_id] = reg
    return {"draft_id": draft_id, "registry": reg}


def draft_get(draft_id: str) -> dict[str, Any]:
    """Return the current draft state as {draft_id, registry}."""
    return {"draft_id": draft_id, "registry": _get(draft_id)}


def draft_reset(draft_id: str) -> dict[str, Any]:
    """Reset a draft to initial empty state, preserving title and description."""
    reg = _get(draft_id)
    fresh = _initial_registry()
    fresh["title"] = reg.get("title", "")
    fresh["description"] = reg.get("description", "")
    _drafts[draft_id] = fresh
    return {"draft_id": draft_id, "reset": True}


def draft_import(registry: dict[str, Any]) -> dict[str, Any]:
    """Import an existing registry JSON into a new draft. Returns {draft_id}."""
    draft_id = str(uuid.uuid4())[:8]
    reg = _initial_registry()
    for field in ("title", "description", "assembly_order", "generation",
                  "output_policy", "memory_config", "style_blend", "memory_rules", "default_state"):
        if field in registry:
            reg[field] = copy.deepcopy(registry[field])
    for key in KNOWN_SECTIONS:
        if key in registry:
            src = registry[key]
            reg[key] = {
                "required": key in REQUIRED_SECTIONS,
                "template_vars": list(src.get("template_vars") or []),
                "items": copy.deepcopy(src.get("items") or []),
            }
    _drafts[draft_id] = reg
    return {"draft_id": draft_id}


def draft_validate(draft_id: str) -> dict[str, Any]:
    """Validate the draft. Returns {ok, errors, warnings}."""
    reg = _get(draft_id)
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    # required sections must have items
    for sec_key in REQUIRED_SECTIONS:
        if not reg.get(sec_key, {}).get("items"):
            errors.append({
                "path": f"{sec_key}.items",
                "message": "Required section has no items.",
            })

    # assembly order tokens must reference known sections and use correct format
    seen_section_tokens: dict[str, str] = {}
    for token in reg.get("assembly_order", []):
        parts = token.split(".")
        sec = parts[0]
        if sec not in KNOWN_SECTIONS:
            warnings.append({
                "path": "assembly_order",
                "message": f"Token '{token}' references unknown section '{sec}'.",
            })
        elif len(parts) == 3:
            errors.append({
                "path": "assembly_order",
                "message": (
                    f"Token '{token}' incorrectly includes an item ID. "
                    f"Use '{sec}.{parts[2]}' instead — the selected item is "
                    f"determined by default_state, not the token."
                ),
            })
        elif token in seen_section_tokens:
            warnings.append({
                "path": "assembly_order",
                "message": f"Duplicate token '{token}' in assembly_order.",
            })
        else:
            seen_section_tokens[token] = sec

    # default_state selected items must exist in their sections
    default_state = reg.get("default_state", {})
    for sec_key, state in default_state.items():
        selected = state.get("selected")
        if not selected:
            continue
        sec = reg.get(sec_key, {})
        item_ids = {item.get("id") or item.get("name") for item in sec.get("items", [])} - {None}
        if item_ids and selected not in item_ids:
            errors.append({
                "path": f"default_state.{sec_key}.selected",
                "message": (
                    f"Selected item '{selected}' does not exist in section '{sec_key}'. "
                    f"Available item IDs: {sorted(item_ids)}. "
                    f"Fix with registry.draft.set_default_state or registry.item.update."
                ),
            })

    # items should have non-empty content
    for sec_key in KNOWN_SECTIONS:
        sec = reg.get(sec_key, {})
        tvars = set(sec.get("template_vars", []))
        for item in sec.get("items", []):
            item_id = item.get("id") or item.get("name") or "?"
            content = item.get("text") or item.get("context") or ""
            has_groups = bool(item.get("groups"))
            has_fragments = bool(item.get("fragments"))
            if not str(content).strip() and not has_groups and not has_fragments:
                field = "context" if sec_key in ("personas", "sentiment") else "text"
                warnings.append({
                    "path": f"{sec_key}.items[{item_id}]",
                    "message": (
                        f"Item '{item_id}' in '{sec_key}' has empty content. "
                        f"Call registry.item.update with field='{field}' to add content."
                    ),
                })
            # fragment condition vars
            for frag in item.get("fragments", []):
                cond = frag.get("condition", "")
                if cond and cond not in tvars:
                    warnings.append({
                        "path": f"{sec_key}.items[{item_id}].fragments",
                        "message": f"Fragment condition '{cond}' not declared in section template_vars.",
                    })

    for item in reg.get("prompt_endings", {}).get("items", []):
        if not (item.get("name") or item.get("id")):
            errors.append({
                "path": "prompt_endings.items",
                "message": "Prompt ending item missing 'name'.",
            })

    return {"ok": len(errors) == 0, "errors": errors, "warnings": warnings}


def draft_export(draft_id: str) -> dict[str, Any]:
    """Export as Builder-compatible {registry: {...}} JSON."""
    reg = _get(draft_id)
    out: dict[str, Any] = {}

    for k, v in reg.items():
        if k in KNOWN_SECTIONS:
            sec = v
            if not sec.get("items") and k not in REQUIRED_SECTIONS:
                continue
            sec_out: dict[str, Any] = {"required": sec.get("required", False)}
            if sec.get("template_vars"):
                sec_out["template_vars"] = sec["template_vars"]
            if sec.get("items"):
                sec_out["items"] = sec["items"]
            out[k] = sec_out
        else:
            if v or k in ("version", "title", "description", "assembly_order"):
                out[k] = v

    return {"registry": out}


# ── meta ─────────────────────────────────────────────────────────────────────

def meta_set(
    draft_id: str,
    title: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Set registry title and/or description."""
    reg = _get(draft_id)
    if title is not None:
        reg["title"] = title
    if description is not None:
        reg["description"] = description
    return {"title": reg["title"], "description": reg["description"]}


# ── section ──────────────────────────────────────────────────────────────────

def section_add_var(draft_id: str, section_key: str, var_name: str) -> dict[str, Any]:
    """Add a template variable to a section. Accepts bare names or {braced} format."""
    reg = _get(draft_id)
    if section_key not in KNOWN_SECTIONS:
        raise ValueError(f"Unknown section '{section_key}'. Known: {KNOWN_SECTIONS}")
    sec = reg[section_key]
    var = _normalize_var(var_name)
    if var not in sec["template_vars"]:
        sec["template_vars"].append(var)
    return {"section": section_key, "template_vars": sec["template_vars"]}


def section_add_item(
    draft_id: str,
    section_key: str,
    item_id: str,
    fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Add an item to a section. Fields vary by section type:

    base_context         → {text, template_vars?, template_defaults?, fragments?}
    personas             → {context, groups?}
    sentiment            → {context, groups?, scale?}
    static_injections    → {text}
    runtime_injections   → {text}
    output_prompt_dirs   → {text, groups?}
    prompt_endings       → {name?, text, items:[endings]}
    user_message         → {text}
    """
    reg = _get(draft_id)
    if section_key not in KNOWN_SECTIONS:
        raise ValueError(f"Unknown section '{section_key}'.")
    sec = reg[section_key]
    fields = fields or {}

    if "template_vars" in fields:
        fields["template_vars"] = [_normalize_var(v) for v in fields["template_vars"]]

    if _find_item(sec["items"], item_id):
        raise ValueError(f"Item '{item_id}' already exists in section '{section_key}'.")

    if section_key == "prompt_endings":
        item: dict[str, Any] = {
            "name": fields.get("name", item_id),
            "text": fields.get("text", ""),
        }
        if "items" in fields:
            item["items"] = fields["items"]
    elif section_key == "base_context":
        item = {"id": item_id, "text": fields.get("text", "")}
        for opt in ("template_vars", "template_defaults", "fragments"):
            if opt in fields:
                item[opt] = fields[opt]
    elif section_key == "personas":
        ctx = fields.get("context") or fields.get("text") or ""
        item = {"id": item_id}
        if ctx:
            item["context"] = ctx
        if "groups" in fields:
            item["groups"] = fields["groups"]
    elif section_key == "sentiment":
        ctx = fields.get("context") or fields.get("text") or ""
        item = {"id": item_id}
        if ctx:
            item["context"] = ctx
        if "groups" in fields:
            item["groups"] = fields["groups"]
        if "scale" in fields:
            item["scale"] = fields["scale"]
    elif section_key in ("static_injections", "runtime_injections", "output_prompt_directions"):
        item = {"id": item_id, "text": fields.get("text", "")}
        if "groups" in fields:
            item["groups"] = fields["groups"]
    else:
        item = {"id": item_id}
        item.update({k: v for k, v in fields.items() if k != "id"})

    sec["items"].append(item)

    content_value = item.get("text") or item.get("context") or ""
    warning = (
        f"WARNING: item '{item_id}' was added to '{section_key}' with empty content. "
        f"Call registry.item.update with the correct content field "
        f"({'context' if section_key in ('personas', 'sentiment') else 'text'}) "
        f"before exporting."
    ) if not str(content_value).strip() else None

    result: dict[str, Any] = {"section": section_key, "item": item}
    if warning:
        result["warning"] = warning
    return result


# ── item ─────────────────────────────────────────────────────────────────────

def item_update(
    draft_id: str,
    section_key: str,
    item_id: str,
    fields: dict[str, Any],
) -> dict[str, Any]:
    """Update fields on an existing item. id and name are protected."""
    reg = _get(draft_id)
    item = _find_item(reg.get(section_key, {}).get("items", []), item_id)
    if item is None:
        raise KeyError(f"Item '{item_id}' not found in section '{section_key}'.")
    if "template_vars" in fields:
        fields["template_vars"] = [_normalize_var(v) for v in fields["template_vars"]]
    # for sections that use context as the content field, remap text → context
    if section_key in ("personas", "sentiment") and "text" in fields and "context" not in fields:
        fields = dict(fields)
        fields["context"] = fields.pop("text")
    for k, v in fields.items():
        if k not in ("id", "name"):
            item[k] = v
    return {"section": section_key, "item": item}


def item_add_fragment(
    draft_id: str,
    section_key: str,
    item_id: str,
    fragment_id: str,
    text: str,
    condition: str = "",
    label: str = "",
) -> dict[str, Any]:
    """
    Add a conditional text fragment to an item.
    If condition is given, it is auto-added to the section's template_vars.
    """
    reg = _get(draft_id)
    sec = reg.get(section_key, {})
    item = _find_item(sec.get("items", []), item_id)
    if item is None:
        raise KeyError(f"Item '{item_id}' not found in section '{section_key}'.")

    frag: dict[str, Any] = {"id": fragment_id, "text": text}
    if condition:
        frag["condition"] = _normalize_var(condition)
        tvars = sec.setdefault("template_vars", [])
        if frag["condition"] not in tvars:
            tvars.append(frag["condition"])
    if label:
        frag["label"] = label

    item.setdefault("fragments", []).append(frag)
    return {"section": section_key, "item_id": item_id, "fragment": frag}


def item_add_group(
    draft_id: str,
    section_key: str,
    item_id: str,
    group_id: str,
    directives: list[str] | None = None,
    pre_context: str = "",
) -> dict[str, Any]:
    """
    Attach an inline group to a persona, sentiment, or output_direction item.
    Groups are stored inline inside the item's 'groups' list as objects,
    matching the registry format used by example registries.
    Creates the group if it doesn't exist; appends directives if it does.
    """
    reg = _get(draft_id)
    item = _find_item(reg.get(section_key, {}).get("items", []), item_id)
    if item is None:
        raise KeyError(f"Item '{item_id}' not found in section '{section_key}'.")

    groups_list: list = item.setdefault("groups", [])
    existing = next(
        (g for g in groups_list if isinstance(g, dict) and g.get("id") == group_id),
        None,
    )
    if existing is not None:
        if directives:
            existing["items"].extend(directives)
        return {"section": section_key, "item_id": item_id, "group": existing, "created": False}

    new_group: dict[str, Any] = {
        "id": group_id,
        "pre_context": pre_context,
        "items": list(directives or []),
    }
    groups_list.append(new_group)
    return {"section": section_key, "item_id": item_id, "group": new_group, "created": True}


# ── group ────────────────────────────────────────────────────────────────────

def group_add_item(draft_id: str, group_id: str, directive: str) -> dict[str, Any]:
    """Add a directive string to an inline group. Searches all section items."""
    reg = _get(draft_id)
    group = _find_inline_group(reg, group_id)
    if group is None:
        raise KeyError(f"Group '{group_id}' not found in any section item.")
    group.setdefault("items", []).append(directive)
    return {"group_id": group_id, "items": group["items"]}


# ── assembly ─────────────────────────────────────────────────────────────────

def assembly_set_order(draft_id: str, order: list[str]) -> dict[str, Any]:
    """Set the assembly_order list."""
    reg = _get(draft_id)
    normalized = []
    for token in order:
        parts = token.split(".")
        # collapse section.item_id.attribute → section.attribute
        if len(parts) == 3 and parts[0] in KNOWN_SECTIONS:
            token = f"{parts[0]}.{parts[2]}"
        normalized.append(token)
    # deduplicate while preserving order
    seen: set[str] = set()
    deduped = [t for t in normalized if not (t in seen or seen.add(t))]  # type: ignore[func-returns-value]
    reg["assembly_order"] = deduped
    return {"assembly_order": reg["assembly_order"]}


# ── generation ───────────────────────────────────────────────────────────────

_GENERATION_KEYS = {"temperature", "top_p", "top_k", "max_tokens", "repeat_penalty", "retries"}

def generation_set(draft_id: str, params: dict[str, Any]) -> dict[str, Any]:
    """Merge generation params (temperature, top_p, top_k, max_tokens, repeat_penalty, retries)."""
    reg = _get(draft_id)
    filtered = {k: v for k, v in (params or {}).items() if k in _GENERATION_KEYS}
    reg["generation"].update(filtered)
    return {"generation": reg["generation"]}


# ── output policy ────────────────────────────────────────────────────────────

def output_policy_set(draft_id: str, policy: dict[str, Any]) -> dict[str, Any]:
    """Merge output policy fields."""
    reg = _get(draft_id)
    reg["output_policy"].update(policy)
    return {"output_policy": reg["output_policy"]}

