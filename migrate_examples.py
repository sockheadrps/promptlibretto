"""Migrate v22/v1 registry JSON files to v2 schema in-place."""
from __future__ import annotations

import json
import re
from pathlib import Path

EXAMPLE_DIRS = [
    Path("studio/static/examples"),
    Path("studio/static/builder-examples"),
]

SKIP_FILES = {"index.json"}

# Assembly order token rewrites
_TOKEN_REWRITES: list[tuple[str, str]] = [
    # singular alias → plural section name
    (r"^persona\.", "personas."),
    # old field tokens → v2 group tokens
    (r"^personas\.base_directives$", "personas.groups"),
    (r"^sentiment\.nudges$", "sentiment.groups"),
    # old section-qualified item: examples.X → groups[X]
    (r"^examples\.(.+)$", r"groups[\1]"),
    # bare examples section token
    (r"^examples$", "groups"),
]

TOOL_STATE_KEYS = {"selected", "slider", "slider_random", "section_random", "array_modes"}


def rewrite_token(token: str) -> str:
    # Apply all rewrites iteratively until stable (handles chained rewrites).
    for _ in range(len(_TOKEN_REWRITES) + 1):
        changed = False
        for pattern, replacement in _TOKEN_REWRITES:
            rewritten = re.sub(pattern, replacement, token)
            if rewritten != token:
                token = rewritten
                changed = True
                break
        if not changed:
            break
    return token


def migrate_registry(data: dict) -> dict:
    reg: dict = data.get("registry") or data
    inner_wrapped = "registry" in data

    reg["version"] = 2

    scale_template_by_section: dict[str, str] = {}
    default_state: dict[str, dict] = {}
    new_groups: list[dict] = []

    # ── Pass 1: strip tool-state from sections → default_state ────────────
    section_keys = [
        k for k in reg
        if k not in {"version", "title", "description", "assembly_order",
                     "generation", "output_policy", "memory_rules",
                     "memory_config", "default_state", "routes",
                     "examples"}  # examples renamed in Pass 4; state lifted there
        and isinstance(reg[k], dict)
    ]

    for sec_key in section_keys:
        sec = reg[sec_key]
        # scale_template lives on the section, belongs on each item
        tmpl = sec.pop("scale_template", None)
        if tmpl:
            scale_template_by_section[sec_key] = tmpl

        state_entry: dict = {}
        for field in TOOL_STATE_KEYS:
            if field in sec:
                state_entry[field] = sec.pop(field)
        if state_entry:
            default_state[sec_key] = state_entry

    # ── Pass 2: migrate sentiment items ──────────────────────────────────
    sentiment_sec = reg.get("sentiment", {})
    scale_tmpl = scale_template_by_section.get(
        "sentiment",
        "{label}: {value}/{max_value} — {scale_descriptor}.",
    )
    # Normalise v22 placeholder names in the template
    scale_tmpl = scale_tmpl.replace("{emotion}", "{scale_descriptor}")

    # Track old array_mode for nudges so we can translate it
    sentiment_state = default_state.get("sentiment", {})
    old_nudge_mode = (sentiment_state.get("array_modes") or {}).pop("nudges", None)

    new_sentiment_array_modes: dict[str, str] = {}

    for item in sentiment_sec.get("items", []):
        item_id = item.get("id") or item.get("name") or ""
        scale_emotion = item.pop("scale_emotion", None)
        nudges = item.pop("nudges", None)

        if scale_emotion and "scale" not in item:
            # Try to read a baked slider default
            default_val = float(sentiment_state.get("slider") or 5)
            item["scale"] = {
                "scale_descriptor": scale_emotion,
                "template": scale_tmpl,
                "default_value": default_val,
            }

        if nudges and item_id:
            group_id = f"{item_id}_nudges"
            new_groups.append({"id": group_id, "items": nudges})
            item.setdefault("groups", [])
            if group_id not in item["groups"]:
                item["groups"].append(group_id)
            if old_nudge_mode:
                new_sentiment_array_modes[f"groups[{group_id}]"] = old_nudge_mode

    # Carry surviving sentiment array_modes forward plus translated ones
    surviving_modes = {
        k: v for k, v in (sentiment_state.get("array_modes") or {}).items()
    }
    surviving_modes.update(new_sentiment_array_modes)
    if surviving_modes:
        sentiment_state["array_modes"] = surviving_modes
    elif "array_modes" in sentiment_state and not sentiment_state["array_modes"]:
        del sentiment_state["array_modes"]
    if sentiment_state:
        default_state["sentiment"] = sentiment_state

    # ── Pass 3: migrate persona items ────────────────────────────────────
    personas_sec = reg.get("personas", {})
    personas_state = default_state.get("personas", {})
    old_directives_mode = (personas_state.get("array_modes") or {}).pop("base_directives", None)
    new_persona_array_modes: dict[str, str] = {}

    for item in personas_sec.get("items", []):
        item_id = item.get("id") or item.get("name") or ""
        directives = item.pop("base_directives", None)

        if directives and item_id:
            group_id = f"{item_id}_directives"
            new_groups.append({"id": group_id, "items": directives})
            item.setdefault("groups", [])
            if group_id not in item["groups"]:
                item["groups"].append(group_id)
            if old_directives_mode:
                new_persona_array_modes[f"groups[{group_id}]"] = old_directives_mode

    surviving_persona_modes = {
        k: v for k, v in (personas_state.get("array_modes") or {}).items()
    }
    surviving_persona_modes.update(new_persona_array_modes)
    if surviving_persona_modes:
        personas_state["array_modes"] = surviving_persona_modes
    elif "array_modes" in personas_state and not personas_state["array_modes"]:
        del personas_state["array_modes"]
    if personas_state:
        default_state["personas"] = personas_state

    # ── Pass 4: migrate examples section → groups ────────────────────────
    examples_sec = reg.pop("examples", None)
    if examples_sec:
        # Lift any baked state from examples section
        examples_state: dict = {}
        for field in TOOL_STATE_KEYS:
            if field in examples_sec:
                examples_state[field] = examples_sec.pop(field)
        if examples_state:
            default_state["groups"] = {
                **default_state.get("groups", {}),
                **examples_state,
            }
        if "groups" not in reg:
            reg["groups"] = {"required": False, "items": []}
        reg["groups"]["items"].extend(examples_sec.get("items", []))

    # ── Pass 5: add newly created groups ─────────────────────────────────
    if new_groups:
        if "groups" not in reg:
            reg["groups"] = {"required": False, "items": []}
        reg["groups"]["items"].extend(new_groups)

    # ── Pass 6: rewrite assembly_order ───────────────────────────────────
    reg["assembly_order"] = [rewrite_token(t) for t in reg.get("assembly_order", [])]

    # ── Pass 7: write default_state ──────────────────────────────────────
    if default_state:
        reg["default_state"] = default_state

    # ── Pass 8: consume root-level builder state (if wrapped) ────────────
    if inner_wrapped:
        root_selections = data.pop("selections", {})
        root_sliders = data.pop("sectionSliders", data.pop("sliders", {}))
        root_slider_random = data.pop("sectionSliderRandom", data.pop("slider_random", {}))
        root_section_random = data.pop("sectionRandom", data.pop("section_random", {}))
        root_array_modes = data.pop("arrayModes", data.pop("array_modes", {}))
        root_tvars = data.pop("tvarValues", data.pop("template_vars", {}))

        all_root_keys = set(
            list(root_selections) + list(root_sliders) +
            list(root_array_modes) + list(root_section_random)
        )
        for k in root_tvars:
            sep = k.find("::")
            if sep > 0:
                all_root_keys.add(k[:sep])

        for key in all_root_keys:
            ss = reg["default_state"].setdefault(key, {}) if "default_state" in reg else {}
            if key not in reg.get("default_state", {}):
                reg.setdefault("default_state", {})[key] = ss
                ss = reg["default_state"][key]
            if "selected" not in ss and key in root_selections:
                ss["selected"] = root_selections[key]
            if "slider" not in ss and root_sliders.get(key) is not None:
                ss["slider"] = root_sliders[key]
            if root_slider_random.get(key):
                ss.setdefault("slider_random", True)
            if root_section_random.get(key):
                ss.setdefault("section_random", True)
            if "array_modes" not in ss and root_array_modes.get(key):
                ss["array_modes"] = root_array_modes[key]

        for k, v in root_tvars.items():
            sep = k.find("::")
            if sep > 0:
                sec_key = k[:sep]
                var_name = k[sep + 2:]
                ss = reg.get("default_state", {}).get(sec_key, {})
                ss.setdefault("template_vars", {})[var_name] = v
                reg.setdefault("default_state", {})[sec_key] = ss

        # Also clean other builder artefact keys
        for key in ["savedAt", "name"]:
            data.pop(key, None)

    # ── Pass 9: rename default_state["examples"] → default_state["groups"] ─
    ds = reg.get("default_state", {})
    if "examples" in ds:
        ex_state: dict = ds.pop("examples")
        selected_groups: list = ex_state.pop("selected", []) or []
        old_modes: dict = ex_state.pop("array_modes", {}) or {}
        # Rewrite "items" array_mode key → one entry per selected group
        new_modes: dict = {}
        items_mode = old_modes.pop("items", None)
        if items_mode and selected_groups:
            for gid in selected_groups:
                new_modes[f"groups[{gid}]"] = items_mode
        # Carry any other already-qualified modes forward
        for k, v in old_modes.items():
            new_modes[k] = v
        groups_state = dict(ex_state)  # any remaining keys (slider, etc.)
        if new_modes:
            groups_state["array_modes"] = new_modes
        if groups_state:
            merged = {**ds.get("groups", {}), **groups_state}
            ds["groups"] = merged
        if ds:
            reg["default_state"] = ds
        elif "default_state" in reg:
            del reg["default_state"]

    return data


def main():
    for dir_path in EXAMPLE_DIRS:
        for json_file in sorted(dir_path.glob("*.json")):
            if json_file.name in SKIP_FILES:
                continue
            raw = json_file.read_text(encoding="utf-8")
            data = json.loads(raw)
            result = migrate_registry(data)
            json_file.write_text(
                json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print(f"migrated: {json_file}")


if __name__ == "__main__":
    main()
