# Design

`promptlibretto` schema v2 separates three things:

- Registry blueprint: authored sections, items, groups, routes, generation config, and output policy.
- Runtime state: selected item IDs, scale values, array modes, section randomization, and template variable values.
- Assembly order: the explicit token list that decides what appears in the final prompt.

The goal is to keep prompt structure declarative without flattening domain meaning. A persona is still a persona, sentiment is still sentiment, groups are reusable prompt snippets, and output directions remain the response contract.

## Registry

A registry is the top-level model:

```python
Registry(
    version=2,
    title="...",
    assembly_order=[...],
    sections={...},
    routes={...},
    generation={...},
    output_policy={...},
    memory_rules=[...],
    memory_config={...},
    default_state=RegistryState(...),
)
```

`Registry.from_dict()` accepts wrapped or bare dictionaries, but only schema `version: 2`.

## Sections

A section is blueprint data:

```python
Section(
    id="personas",
    label="Personas",
    required=True,
    template_vars=[],
    items=[...],
)
```

Runtime choices do not live on `Section`. They live in `RegistryState`.

Canonical sections:

- `base_context`
- `personas`
- `sentiment`
- `static_injections`
- `runtime_injections`
- `output_prompt_directions`
- `groups`
- `prompt_endings`

The registry is open: other item sections can exist, but the hydrator has special behavior for the canonical sections and token forms.

## Items

All typed builders share `BaseItem`:

```python
BaseItem(id="...", label="", display=Display(), metadata={})
```

`Display` is presentation metadata only. It never changes hydration.

Dynamic items add:

```python
template_vars: list[str]
template_defaults: dict[str, str]
fragments: list[Fragment]
```

Scalable items add:

```python
scale: Scale
```

Important item types:

- `ContextItem`: base context text, template variables, and fragments.
- `Persona`: identity/voice context plus attached groups.
- `Sentiment`: affect/tone context, attached groups, and scale.
- `Group`: reusable prompt snippets with optional `pre_context`.
- `StaticInjection`: fixed optional text.
- `RuntimeInjection`: dynamic optional text rendered through `injections`.
- `OutputDirection`: response contract; dynamic and scalable.
- `PromptEnding`: final cue pool.

## Runtime State

State is section-scoped:

```python
RegistryState(sections={
    "personas": SectionState(selected="old_lady"),
    "sentiment": SectionState(
        selected="sarcastic",
        slider=8,
        slider_random=False,     # randomise slider within scale min/max
        section_random=False,    # randomise which item is selected
        array_modes={"groups[sarcastic_examples]": "random:1"},
    ),
    "base_context": SectionState(
        selected="scene",
        template_vars={"company": "Acme"},
    ),
})
```

Resolution order:

1. Explicit state passed to `hydrate()` / `Engine.run()`
2. Active route `default_state`
3. Registry `default_state`
4. Empty state

After that, selected item `template_defaults` merge in. Explicit state values win.

## Assembly Tokens

Token forms:

- `section`
- `section.field`
- `section.scale`
- `section.groups`
- `section.groups[group_id]`
- `groups[group_id]`
- `section[item_id]`
- `section[item_id].field`
- `injections`

Bare `section` renders that section's primary field. For canonical sections, primary fields are:

- `base_context`: `text`
- `personas`: `context`
- `sentiment`: `context`
- `static_injections`: `text`
- `runtime_injections`: `text`
- `output_prompt_directions`: `text`
- `prompt_endings`: `text` or `items`

## Groups and Array Modes

Groups are the reusable list primitive:

```json
{
  "id": "support_examples",
  "pre_context": "Examples:",
  "items": ["Sure, I can help.", "Let's check that."]
}
```

Array modes apply through `SectionState.array_modes`:

- `all`
- `none`
- `index:N`
- `indices:A,B,C`
- `random:K`

For attached groups, use keys like `groups[support_examples]`.

## Fragments

Fragments are conditional text blocks:

```json
{
  "id": "scene",
  "text": "You are helping {company}.",
  "fragments": [
    {
      "id": "artifact",
      "condition": "artifact",
      "text": "The artifact is {artifact}."
    }
  ]
}
```

A fragment with `condition` renders only when that section's template variable is non-empty.

## Scale

`Scale` is generic prompt text controlled by a section slider:

```python
Scale(
    label="Intensity",
    scale_descriptor="sarcasm",
    min_value=1,
    max_value=10,
    default_value=5,
    randomize=False,
    template="{label}: {value}/{max_value} - {scale_descriptor}.",
)
```

`section.scale` renders the selected item's scale. The value comes from section state, randomization, or the scale default.

## Injections

`static_injections` are fixed selectable text blocks.

`runtime_injections` are dynamic text blocks rendered through `injections`. If runtime injections are selected and `injections` is not in `assembly_order`, the hydrator appends them to the end.

`include_sections` is preserved as item metadata. The current v2 hydrator does not filter the assembled prompt by that field.

## Routes

Routes are optional overrides:

```python
Route(
    assembly_order=["output_prompt_directions"],
    generation={"max_tokens": 64},
    output_policy={"max_length": 240},
    default_state=RegistryState(...),
)
```

With no route, the top-level registry order/config is used.

## Engine

`Engine.hydrate()` renders prompt text only.

`Engine.run()` hydrates, calls the provider, cleans output, validates it, and retries according to generation config.

`Engine.stream()` supports providers with a `stream()` method.
