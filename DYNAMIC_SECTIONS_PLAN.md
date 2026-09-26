# Dynamic Sections Plan

Remove hardcoded canonical section names. Any section key is valid; the assembler derives behavior from assembly_order tokens and item field presence, not from recognizing the key name.

---

## Problem

Currently `SECTION_KEYS` in `model.py`, `chatbuilder.js`, `appv2.js`, and `BUILDER_API.md` all enumerate a fixed list of canonical section names (`personas`, `sentiment`, `output_prompt_directions`, etc.). Registries with custom sections (`expertise`, `communication_style`, `knowledge_layers`) load partially or not at all — as seen in the chatbuilder bug fixed today.

---

## Goal

A registry with any section names should work end-to-end: load, hydrate, export, display in Studio, and be buildable via the chatbuilder assistant.

---

## Core Idea

Assembly order tokens already tell the assembler *what to extract*:
- `expertise.context` → render `context` field of selected item in `expertise` section
- `communication_style.scale` → render `scale` of selected item
- `expertise.groups` → render attached groups

The section key name is irrelevant to hydration. What matters is whether the selected item has the referenced field.

---

## Layer-by-Layer Changes

### 1. `promptlibretto/registry/model.py`

**Now:** Typed item classes per canonical section (`Persona`, `Sentiment`, `ContextItem`, etc.). `SECTION_KEYS` allowlist.

**Change:**
- Collapse typed item classes into a single generic `Item` with optional fields: `text`, `context`, `scale`, `groups`, `items`, `pre_context`, `fragments`
- Keep `SECTION_KEYS` as a `WELL_KNOWN_SECTIONS` advisory constant (not enforced)
- `Section.from_dict()` accepts any key, parses items generically
- `Registry.from_dict()` no longer rejects unknown section keys

**Risk:** Loss of typed validation. Mitigate by validating at assembly time — if a token like `foo.scale` references a section whose selected item has no `scale`, raise a clear error.

---

### 2. `promptlibretto/registry/schema.py`

**Now:** `StateSchema` derives valid controls per section based on known item types.

**Change:**
- Derive available controls from item field presence instead of item type:
  - Has `scale` → expose slider
  - Has `groups` → expose array modes for group keys
  - Has `context` or `text` → expose as selectable
- `SectionStateSchema` becomes fully field-driven

---

### 3. `promptlibretto/output/processor.py` / hydrator

**Now:** Assembly token resolution has special cases for canonical section names (bare `section` maps to known primary field).

**Change:**
- Bare `section` token: resolve primary field by checking item fields in priority order: `text` → `context` → first non-empty string field
- All other dot-notation tokens (`section.field`) already work generically
- Remove any `if section_key == 'personas'` style branches

---

### 4. Ensemble (`prompt_constructor/ensemble/engine.py`)

**Now:** May reference canonical section keys for special rendering or validation.

**Change:**
- Audit for hardcoded section key references and replace with field-presence checks
- Ensure `Engine.hydrate()` routes through the generic assembler with no key-name special cases

---

### 5. Studio (`prompt_constructor/static/appv2.js`)

**Now:** `sectionKeys()` and rendering logic check against a known list. Controls (slider, array modes) rendered only for known section types.

**Change:**
- `sectionKeys()` → read all keys from `registry` that have an `items` array, minus meta keys
- Render slider control if any item in the section has a `scale` field
- Render group array mode controls if any item has `groups`
- Remove `SECTION_LABELS` fallback requirement — use key name as label if no friendly name defined

---

### 6. Chatbuilder (`prompt_constructor/static/chatbuilder.js`)

**Already partially fixed** (extraSectionKeys for load). Still needs:
- `SECTION_KEYS` → advisory only, not used to gate section card creation
- `_buildClientRegistry()` iterates all sections from `regState.sections` (not `SECTION_KEYS`)
- LLM tool `registry.section.add_item` accepts any `section_key` string
- `SECTION_LABELS` → fallback to key name, not required

---

### 7. `prompt_constructor/BUILDER_API.md`

**Now:** Lists valid `section_key` values as an enum.

**Change:**
- Replace enum with: "any snake_case key is valid; well-known keys (`base_context`, `personas`, etc.) have conventional field expectations"
- Document the generic item shape with optional fields
- Update examples to show a custom section (`expertise`, `knowledge_layers`, etc.)

---

## Pre-refactor standalone fixes

### A. `name`/`id` dual lookup cleanup (`hydrate.py`, `model.py`)
Four places use `it.get("id") or it.get("name")` for item lookup — backwards-compat cruft. Standardize to `id` as the single item identifier. Items that only have `name` (old format) should be migrated or rejected at load time.

### B. `memory_config` / `memory_rules` on `Registry` dataclass (`model.py`)
These fields are parsed from JSON and passed around as raw dicts but never mapped onto the `Registry` dataclass — causes `AttributeError: 'Registry' object has no attribute 'memory_config'` in two tests. Add as proper typed fields on `Registry`.

### C. `PRIMARY_FIELD` dict in hydrator
Hardcodes the `text`/`context` split. Goes away when item fields unify to `text` — do not patch independently.

### D. `_build_group_index` hardcodes `groups` section key
Only canonical `groups` section is indexed for cross-section group lookup. With dynamic sections, any section could serve as a group source. Address in refactor scope.

---

## Pre-refactor fixes already landed

- **`_resolve_scale_struct` sec_key hardcode** (`hydrate.py`): was always reading `state.get("sentiment")` and emitting `"section": "sentiment"` regardless of which section was being resolved. Fixed — now takes `sec_key` as a parameter.

- **`_render_fragments` context fallback**: `_render_fragments` only reads `item["text"]` for the base. Persona/Sentiment items use `context`, so fragments on those items silently drop the base. **Do not patch with a `text or context` fallback** — that encodes the split deeper. Fix by unifying to `text` in the item schema (Step 1 of this refactor).

---

## Migration / Compatibility

- All existing v2 registries with canonical sections continue to work unchanged
- `version` stays `2` — this is a relaxation of constraints, not a format break
- The well-known section names and their conventional item shapes remain documented as convention, not enforcement

---

## Open Questions

1. **Primary field resolution for bare tokens**: priority order `text → context` covers most cases. Should there be an explicit `primary_field` property on Section, or stay implicit?

2. **Required sections**: currently some sections are flagged `required: true`. With dynamic sections, does `required` still make sense, or does assembly_order implicitly define what's required?

3. **Studio section ordering in UI**: without a fixed SECTION_KEYS list, what determines card order in the Studio grid? Options: assembly_order order, alphabetical, insertion order.

4. **Builder LLM system prompt**: the chatbuilder's system prompt currently lists valid section keys. Needs rewrite to describe the generic pattern.
