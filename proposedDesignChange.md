# Proposed Design Change: Normalized Prompt Model

## Summary

Promptlibretto should use a cleaner registry model that standardizes identity and tool-facing metadata while preserving the semantic fields that make each prompt component understandable.

The proposed direction:

- Use `id` as the canonical identifier for every item and section.
- Add `label` and `display` metadata for editors, docs, builders, and other tools.
- Move `template_vars` and defaults to the item level, not the section level.
- Keep fragments as conditional prompt blocks. `condition` is a variable name; the fragment renders when that variable is non-empty.
- Replace `scale_emotion` with a reusable `Scale` dataclass.
- Replace `ExampleGroup` with `Group`, a reusable collection of prompt snippets.
- Absorb `nudges` and `base_directives` into `Group`.
- Rename `SentimentItem` to `Sentiment`.
- Keep dynamic behavior opt-in by item type.
- Move runtime selection state into a separate `RegistryState` model (see `proposedRegistryState.md`).

Backward compatibility is not a goal for this design. This is a v2 schema break (`SCHEMA_VERSION = 2`) with a migration tool, not an in-place bump.

---

## Core Model

```python
@dataclass
class Display:
    description: str = ""
    icon: str = ""
    color: str = ""
    order: int = 0
    hidden: bool = False


@dataclass
class BaseItem:
    id: str
    label: str = ""
    display: Display = field(default_factory=Display)
    metadata: dict = field(default_factory=dict)


@dataclass
class Section:
    id: str
    label: str = ""
    display: Display = field(default_factory=Display)
    items: list[BaseItem] = field(default_factory=list)
    required: bool = True
```

`id` is stable and machine-friendly. `label` is the human-facing name. `display` is presentation metadata for tools and must not affect hydration.

All items use `id` as the canonical key. Hydration, selection, memory rules, and route lookups all resolve by `id`. Tools display `label or id`. The current split between `name` (ContextItem, StaticInjection) and `id` (Persona, SentimentItem, RuntimeInjection) is eliminated.

`Section` no longer carries `selected`, `slider`, `slider_random`, `section_random`, or `array_modes`. Those fields move to `SectionState` in `RegistryState`. See `proposedRegistryState.md`.

---

## Dynamic Content

Dynamic behavior is opt-in via composition. Items that need template variables or fragments declare `DynamicMixin`. Items that do not are left simple.

```python
@dataclass
class Fragment:
    id: str
    text: str
    condition: str = ""   # variable name; renders when value is non-empty
    label: str = ""
    display: Display = field(default_factory=Display)


@dataclass(kw_only=True)
class DynamicMixin:
    template_vars: list[str] = field(default_factory=list)
    template_defaults: dict[str, str] = field(default_factory=dict)
    fragments: list[Fragment] = field(default_factory=list)
```

`condition` replaces `if_var`. The semantics are unchanged: the fragment renders when the named variable has a non-empty runtime value. This is not an expression language. If conditional logic beyond variable presence is needed, that belongs in a route or injection, not a fragment.

`template_defaults` moves per-item default values onto the item that declares the placeholders. The current pattern — declaring `template_vars` on `Section` and `template_var_defaults` also on `Section` — forces the engine to pair them by convention. Keeping defaults next to the item that owns the vars removes that indirection.

The hydrator should template only declared dynamic fields on declared dynamic item types. It must not recursively template every string in every object.

**Python note:** Mixin classes use `@dataclass(kw_only=True)` so their defaulted fields do not conflict with `id: str` (no default) from `BaseItem` in the generated `__init__`. Requires Python 3.10+, which is the minimum supported version.

---

## Scale

```python
@dataclass
class Scale:
    label: str = "Intensity"
    scale_descriptor: str = ""
    min_value: float = 1
    max_value: float = 10
    default_value: float = 5
    randomize: bool = False
    template: str = "{label}: {value}/{max_value} - {scale_descriptor}."


@dataclass(kw_only=True)
class ScalableMixin:
    scale: Scale = field(default_factory=Scale)
```

`scale_descriptor` replaces `scale_emotion`. The name `scale_emotion` is too narrow — the field can represent urgency, formality, confidence, detail level, or any scaled quality. `Scale` is reusable outside `Sentiment` via `ScalableMixin`.

The `scale_template` field currently on `Section` moves inside `Scale.template`. This keeps scale configuration together and removes the need for the engine to check the parent section for rendering instructions.

The runtime slider value is stored in `SectionState.slider` and passed to the hydrator. `Scale.default_value` is the fallback when no runtime slider is present.

---

## Groups

`ExampleGroup` becomes `Group`. `nudges` and `base_directives` are absorbed. There is no longer a `nudges` field or `base_directives` field on any item type.

```python
@dataclass
class Group(BaseItem):
    pre_context: str = ""
    items: list[str] = field(default_factory=list)
```

Groups are reusable collections of prompt snippets — examples, directives, constraints, endings, or any other list of strings. Their meaning comes from where they are referenced and how they are rendered, not from a `kind` field.

### Attaching groups to items

Items reference groups by `id`:

```python
Persona(
    id="haunted_docent",
    context="You have seen this before.",
    groups=["docent_directives", "docent_examples"],
)
```

Groups are defined in their own section (e.g. `groups`) and looked up by `id` at hydration time.

**Inline shorthand:** If a group is not shared and will only ever belong to one item, it may be defined inline on the item as a nested `Group` instance. The hydrator treats it identically to a referenced group. The id-reference form is preferred when a group is reused across multiple items.

### Rendering

Attached groups do not render automatically. They render only when the assembly order includes them:

```python
assembly_order=[
    "personas.context",
    "personas.groups",
    "sentiment.context",
    "sentiment.scale",
    "sentiment.groups",
]
```

The token `personas.groups` renders the groups declared by the selected persona, in declaration order.

**Per-item filtering:** If the route needs only a specific group from a selected item, the assembly token accepts a group id:

```
"personas.groups[docent_directives]"
```

This renders only the group with id `docent_directives` from the selected persona's group list, if present. If the selected persona does not reference that group, the token produces no output (no error).

**Multi-selection:** When multiple items are selected in a section, `personas.groups` renders each selected item's groups in item-selection order. The `[id]` filter applies to each selected item independently.

### array_modes with groups

`array_modes` keys use the `groups[group_id]` notation to target a specific group's `items` list:

```python
array_modes={"groups[docent_directives]": "random:1"}
```

This picks 1 random item from the `docent_directives` group's `items` list when that group is rendered. Each group that needs sampling must be listed explicitly — there is no wildcard. This matches the assembly token syntax and keeps behavior inspectable.

---

## Proposed Item Types

```python
@dataclass
class ContextItem(BaseItem, DynamicMixin):
    text: str = ""


@dataclass
class Persona(BaseItem, DynamicMixin):
    context: str = ""
    groups: list[str] = field(default_factory=list)


@dataclass
class Sentiment(BaseItem, DynamicMixin, ScalableMixin):
    context: str = ""
    groups: list[str] = field(default_factory=list)


@dataclass
class RuntimeInjection(BaseItem, DynamicMixin):
    text: str = ""
    include_sections: list[str] = field(default_factory=list)
    memory_tag: str = ""


@dataclass
class StaticInjection(BaseItem):
    text: str = ""
    memory_tag: str = ""


@dataclass
class OutputDirection(BaseItem, DynamicMixin):
    text: str = ""
    groups: list[str] = field(default_factory=list)


@dataclass
class PromptEnding(BaseItem):
    items: list[str] = field(default_factory=list)
```

`PromptEnding` keeps its own type rather than collapsing into `Group` because it is a terminal section with distinct rendering behavior (one item is selected and one string from `items` is chosen as the prompt closer). It is not a snippet collection attached to another item.

Dynamic item types (carry `DynamicMixin`):

- `ContextItem`
- `Persona`
- `Sentiment`
- `RuntimeInjection`
- `OutputDirection`

Static/simple item types:

- `StaticInjection`
- `PromptEnding`
- `Group`

---

## Assembly Order Token Grammar

Assembly order is a list of string tokens that defines what goes into the final prompt and in what order. Each token names a section and optionally a field or group within it.

```
token     ::= "injections"
            | section_id [ "." field_ref ]

field_ref ::= field_name
            | "groups" [ "[" group_id "]" ]
            | "scale"

section_id, field_name, group_id  ::=  identifier   (alphanumeric + underscore)
```

### Token forms and what they render

| Token | Renders |
|---|---|
| `section_id` | Primary field of all selected items in that section. Primary field is `text` for most types; `context` for Persona and Sentiment. |
| `section_id.field_name` | Named field on each selected item. |
| `section_id.groups` | All groups attached to selected item(s), in declaration order. |
| `section_id.groups[group_id]` | Only the named group from each selected item's group list. Silent no-op if the item does not reference that group. |
| `section_id.scale` | Rendered scale string for ScalableMixin items. Uses `Scale.template` with the runtime slider value from `SectionState`. |
| `injections` | Special token. Applies all active runtime injections. Each injection filters by its `include_sections` list before appending its text. |

### Rules

- Tokens that refer to fields not present on the selected item type are silently skipped.
- Tokens that refer to sections with no selected item produce no output.
- Order is preserved exactly as declared. The hydrator does not reorder tokens.
- The same token may appear more than once in an assembly order (the field is rendered each time). This is not an error.
- `injections` may appear anywhere in the assembly order and is not section-scoped.

---

## Route

```python
@dataclass
class Route:
    id: str
    label: str = ""
    assembly_order: list[str] = field(default_factory=list)
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)
    default_state: RegistryState | None = None
```

Routes now carry `id` and `label` for consistency. `default_state` is an optional `RegistryState` that the engine applies when no external state is passed for a `run()` call on that route. See `proposedRegistryState.md`.

If `assembly_order` is empty on a route, the top-level registry `assembly_order` is used.

---

## Registry

```python
@dataclass
class Registry:
    version: int = SCHEMA_VERSION   # 2
    title: str = ""
    description: str = ""
    assembly_order: list[str] = field(default_factory=list)
    sections: dict[str, Section] = field(default_factory=dict)
    routes: dict[str, Route] = field(default_factory=dict)
    generation: dict[str, Any] = field(default_factory=dict)
    output_policy: dict[str, Any] = field(default_factory=dict)
    memory_rules: list[dict[str, Any]] = field(default_factory=list)
    memory_config: dict[str, Any] = field(default_factory=dict)
    default_state: RegistryState | None = None
```

`sections` is keyed by section `id`. `routes` is keyed by route `id`. `default_state` is the baseline `RegistryState` used when nothing is passed at runtime — it replaces the current per-section `selected`, `slider`, and related fields that were stored inside `Section`.

### memory_rules

Memory rule actions reference items by `id`:

```python
{
    "tag": "artifact_speaks",
    "actions": [
        {"type": "inject", "section": "runtime_injections", "item": "artifact_addressed_visitor"},
        {"type": "sentiment", "value": "quiet_panic"},
        {"type": "persona", "value": "haunted_docent"},
    ]
}
```

`section` and `item` values are `id` strings. `type` values (`inject`, `sentiment`, `persona`) are engine-defined action verbs, not item ids.

---

## Registry and Tooling Rules

- Registry JSON uses `id` for all item and section identity. No `name` field is used as a key.
- Selections, memory rules, routes, and hydration lookups resolve by `id`.
- Tools display `label or id`.
- `display` metadata is for tools only and must not affect prompt hydration.
- Groups resolve by `id`. Inline groups are hydrated identically to referenced groups.
- Attached groups render only through explicit assembly-order tokens.
- Runtime selection state lives in `RegistryState`, not in `Section`. See `proposedRegistryState.md`.

---

## Migration

This is a breaking schema change. A migration script should translate v22 registries to the new schema by:

- Bumping `version` to `2`.
- Converting all `name`-keyed items to `id`.
- Moving section-level `template_vars` and `template_var_defaults` onto their items.
- Converting `scale_emotion` strings to `Scale(scale_descriptor=value)`.
- Converting `base_directives` lists to inline `Group` instances on `Persona`.
- Converting `nudges` lists to inline `Group` instances on `Sentiment`.
- Converting `ExampleGroup` entries to `Group` entries.
- Extracting `selected`, `slider`, `slider_random`, `section_random`, `array_modes` from each `Section` into a `RegistryState` and attaching it as `Registry.default_state`.

Existing JSON files should not be updated in-place without running the migration script.

---

## Design Principle

Normalize structure, not semantics.

The model removes naming friction and resolves inconsistencies without flattening everything into a generic `text` object. Fields like `context`, `scale`, `memory_tag`, and `include_sections` remain explicit because they describe how the engine uses the data, not just what it contains.
