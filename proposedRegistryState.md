# Proposed Design: RegistryState

## Summary

`RegistryState` is the runtime counterpart to `Registry`. Where `Registry` defines the prompt blueprint — sections, items, assembly order, routes — `RegistryState` holds which items are selected, what the sliders are set to, what template variable values have been provided, and how arrays are sampled.

`RegistryState` is not a studio-only concern. It is a first-class runtime object that any caller can build in Python, serialize to JSON, load from disk, pass to `hydrate()`, or attach as a default on a `Registry` or `Route`.

---

## Model

```python
@dataclass
class SectionState:
    selected: str | list[str] | None = None
    slider: float | None = None
    slider_random: bool = False
    section_random: bool = False
    array_modes: dict[str, str] = field(default_factory=dict)
    template_vars: dict[str, str] = field(default_factory=dict)


@dataclass
class RegistryState:
    sections: dict[str, SectionState] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]: ...

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RegistryState": ...
```

`SectionState.selected` is a single item `id` or a list of item `id`s. `None` means use the section's first item or leave unselected depending on `required`.

`template_vars` is a flat dict of `{var_name: value}` scoped to that section. The engine resolves `{var_name}` placeholders only against the vars declared on the selected item — there is no global template namespace. To set a var, you know which section owns it.

`array_modes` keys use the same dot-bracket notation as assembly tokens scoped within the item: `"groups[group_id]"`, `"fragments"`, etc. Values are sampling instructions: `"random:N"` or `"index:N"`.

---

## Attaching state to Registry and Route

Both `Registry` and `Route` accept an optional `default_state`:

```python
@dataclass
class Registry:
    ...
    default_state: RegistryState | None = None


@dataclass
class Route:
    ...
    default_state: RegistryState | None = None
```

Resolution order at hydration time:

1. State passed explicitly to `hydrate()` or `engine.run()` — highest priority.
2. `Route.default_state` if a route is active and has one.
3. `Registry.default_state`.
4. Item-level `template_defaults` for any vars not set by the above.

Each level only fills in what the levels above left unset. A caller passing a partial `RegistryState` does not need to specify every section — unspecified sections fall through to the registry default.

---

## Building state in Python

```python
from promptlibretto import RegistryState, SectionState

state = RegistryState(
    sections={
        "personas": SectionState(
            selected="haunted_docent",
            array_modes={"groups[docent_directives]": "random:1"},
        ),
        "sentiment": SectionState(
            selected="elegant_alarm",
            slider=8,
            array_modes={"groups[nudge_set]": "index:0"},
        ),
        "base_context": SectionState(
            selected="tour_stop",
            template_vars={
                "gallery": "the closed Egyptian wing",
                "artifact": "a mirror that reflects yesterday's visitors",
            },
        ),
        "runtime_injections": SectionState(selected=[]),
    }
)

prompt = hydrate(registry, state)
```

No string key namespacing (`base_context::gallery`). Template vars are scoped to their section naturally by the `SectionState` they live in.

---

## JSON format

`RegistryState` serializes to a flat JSON object keyed by section `id`:

```json
{
  "personas": {
    "selected": "haunted_docent",
    "array_modes": {"groups[docent_directives]": "random:1"}
  },
  "sentiment": {
    "selected": "elegant_alarm",
    "slider": 8
  },
  "base_context": {
    "selected": "tour_stop",
    "template_vars": {
      "gallery": "the closed Egyptian wing",
      "artifact": "a mirror that reflects yesterday's visitors"
    }
  },
  "runtime_injections": {
    "selected": []
  }
}
```

Fields with zero/null/false values are omitted on serialization. `from_dict()` treats missing fields as their defaults.

---

## Saving and loading

```python
import json
from promptlibretto import RegistryState

# Save
with open("session_state.json", "w") as f:
    json.dump(state.to_dict(), f, indent=2)

# Load
with open("session_state.json") as f:
    state = RegistryState.from_dict(json.load(f))
```

State files are separate from registry files. A registry is a prompt blueprint that rarely changes; a state file is a snapshot of one session or configuration.

---

## Studio integration

The studio saves and loads `RegistryState` as a companion to the registry JSON. When exporting a registry from the studio, the current UI state is offered as a separate export (`registry_state.json`) or embedded in the registry as `default_state`.

When importing a registry that has a `default_state`, the studio pre-fills the UI from it. When the user changes selections or sliders, the studio updates its in-memory `RegistryState` and can save it independently of the registry model.

This replaces the current pattern where `selected`, `slider`, `section_random`, and `array_modes` were stored directly inside `Section` in the registry JSON. The registry model is now pure blueprint; all session-specific state is in `RegistryState`.

---

## Migration from v22

The v22 migration script extracts tool-state fields from each `Section` and writes them into a `RegistryState`:

| v22 `Section` field | v2 `SectionState` field |
|---|---|
| `selected` | `selected` |
| `slider` | `slider` |
| `slider_random` | `slider_random` |
| `section_random` | `section_random` |
| `array_modes` | `array_modes` (keys updated for group notation) |
| `template_var_defaults` (section-level) | moved to item `template_defaults`; not in state |

`template_var_defaults` is not a state field. It moves to `DynamicMixin.template_defaults` on the item that owns the vars, since defaults are a blueprint concern, not a session concern.
