# Design

A reusable architecture for building prompts from modular state,
templates, and runtime modes. Domain text, model provider, and output
shape are left to the caller.

Prompt generation is a deterministic pipeline with controlled stochastic
choices. The library separates *what is known* (registry sections),
*what's chosen for this call* (selections + runtime modes), *how the
prompt is assembled* (assembly_order tokens), and *how outputs are
cleaned and validated* (output policy).

## Goals

- Build prompts from composable parts rather than one large hardcoded
  string or a deep tree of decorators.
- Keep the JSON the editor produces *literally* the JSON the runtime
  loads — no codegen, no schema drift.
- Make conditional text behave: an unfilled template variable should
  drop the surrounding sentence, not leave a `{var}` in the output.
- Make randomness visible and reproducible: every random pick (which
  item, which entries from an array, which slider value) is per-field,
  controllable, and deterministic when seeded.

## One abstraction, repeated

A **section** is `{ required: bool, template_vars: [str], items: [obj] }`.
That shape covers everything that used to be five different concepts:

| Old concept            | Now                                             |
| ---------------------- | ----------------------------------------------- |
| Routes                 | optional top-level `routes` map (overrides)     |
| Overlays               | sections + `template_vars` + fragments          |
| Injections (stacked)   | `static_injections`, `runtime_injections`       |
| Persona presets        | `personas` section, items have `id, context`    |
| Few-shot pools         | `examples` section, items have `items[]`        |

The studio renders one card per section with the same affordances
(`+ Add` form, runtime-mode dropdown, value editor) regardless of which
section it is.

## The token language

`assembly_order` is a list of tokens. Three forms:

- `section` — bare. Renders the selected item's primary text field
  (`text` for most sections, `context` for `personas` / `sentiment`).
  Multi-select sections render each chosen item.
- `section.field` — dotted. Renders that field of the selected item.
  When the item doesn't have the field but does have an `items[]` array,
  the resolver falls back to the array (so `prompt_endings.<anything>`
  Just Works for pool-shaped sections).
- `section[expr]` — bracket. Evaluates `expr` recursively, then looks up
  an item in `section` whose `name`/`id` matches the result. Useful for
  cross-section indirection like `examples[sentiment.example_pool]`.

Singular aliases (`persona` → `personas`, `injections` → `static_injections`,
`ending` → `prompt_endings`) read naturally inside an `assembly_order`.

## Glue rules

- Consecutive same-section tokens join with `\n`.
- Different sections join with `\n\n`.
- Adjacent list tokens that share the same `pre_context` heading merge
  into one bulleted list — so a sentiment-specific examples list and a
  generic examples pool produce one heading + one combined bullet list.
- `prompt_endings` is structurally trailing: it never absorbs into the
  preceding merged block.

## Per-array runtime modes

Any array field on a selected item (`nudges`, `examples`, pool `items`,
`base_directives`) supports four modes:

- `all` — render every entry.
- `none` — skip entirely. The token drops out of the assembly.
- `index:N` — render only the Nth entry.
- `random:K` — pick K fresh random entries every hydrate. Seedable.

Modes attach to `(section, field)` not `(item, field)` — when you switch
items, the section's modes still apply to the new selection.

A bullet list is rendered when `pre_context` is present *or* when there
are 2+ entries. A single entry without `pre_context` renders as a plain
line, so `random:1` on `sentiment.nudges` produces a single sentence
instead of `- one item`.

## Conditional fragments

`base_context` items (and any other section that wants them) can carry
a `fragments` array beside `text`:

```json
{
  "name": "scene",
  "text": "You're watching a streamer.",
  "fragments": [
    { "if_var": "location",    "text": "Currently at {location}." },
    { "if_var": "sublocation", "text": "Specifically: {sublocation}." }
  ]
}
```

Each fragment renders with `{var}` substitution. If `if_var` is set and
the template-var has no value at runtime, the fragment is dropped — so
an unfilled `{sublocation}` doesn't leave a broken sentence behind.

## Selections vs evaluation

The studio tracks two related but distinct things:

- **Selections** — what the user picked in the UI (dropdown values,
  checked boxes). Stable; doesn't move under you.
- **Evaluated state** — what hydrate actually uses. Folds in
  `section_random` toggles (re-roll the item) and `slider_random`
  toggles (re-roll the slider).

`Engine.hydrate()` and `Engine.run()` both go through evaluation. The
inline editor reads only selections so what you see is what you set.

## Runtime injections

Items in `runtime_injections` are special: each carries an
`include_sections[]` whitelist. When at least one injection is enabled
(checked in the studio), the assembled prompt is **filtered** to only
the sections in the union of those whitelists, plus the injection's own
text appended at the end.

Use case: a "raid" injection blanks out base context, sentiment,
examples, etc., and substitutes one tight reaction prompt — without
needing a separate route.

## Output policy

`OutputPolicy` is unchanged from the previous library: `min_length`,
`max_length`, `strip_prefixes`, `strip_patterns`, `forbidden_substrings`,
`forbidden_patterns`, `require_patterns`, `append_suffix`,
`collapse_whitespace`. Lives at the registry top level and on each
optional route. `Engine.run()` cleans + validates the model response and
retries up to `generation.retries` times when validation fails.

### Merge semantics

Policy and config merge in the same way: route layers on top of
registry. The asymmetry lives in `OutputPolicy.merged_with`:

- **Sequence fields** (`strip_prefixes`, `strip_patterns`,
  `forbidden_substrings`, `forbidden_patterns`, `require_patterns`) are
  **additive** — the route's rules extend the registry's, they don't
  replace them. So a registry-level `forbidden_substrings: ['"']` plus a
  route-level `forbidden_substrings: ['username:']` together forbid
  both.
- **Scalar fields** (`max_length`, `min_length`, `append_suffix`,
  `collapse_whitespace`) **replace**. Set them on a route to tighten or
  loosen base behavior.

`GenerationConfig.merged_with` is straight key-by-key replace; setting
`temperature` on a route just overrides it.

This way a registry can declare cross-cutting "always strip these
prefixes" rules once, and a route can pile on its own without needing
to recopy them.

## Optional routes

A registry can declare named **routes** that override `assembly_order`
(and optionally `generation` / `output_policy`):

```json
"routes": {
  "raid": { "assembly_order": [...] },
  "short": { "assembly_order": [...], "generation": { "max_tokens": 64 } }
}
```

`Engine.run(state, route="raid")` picks one. With no routes, the
top-level fields are the only path. Routes are optional structural
sugar — the same effect can be achieved by swapping which registry you
load.

## Item metadata fields

Two fields appear on items in canonical exports but aren't consumed by
the engine — they're authoring metadata for the studio:

- **`runtime_variables: list[str]`** on items declares which template
  vars the item *expects* the caller to fill. Useful for documentation,
  for the studio to flag missing inputs, and for validators that want
  to check coverage. `Engine.hydrate` doesn't enforce it; missing vars
  just substitute as empty strings.
- **`pre_context` / `pre_context:`** — string heading that prefixes
  list-shaped content (`items` / `examples` array fields). The trailing
  colon spelling is tolerated for legacy data; canonical is
  `pre_context`.

## What lives in the registry vs in the call

In the registry:

- All authored content (items, fragments, pre_context, template_vars)
- Default selections / array modes / sliders (when you `Export Model JSON`)
- Generation overrides + output policy

In the per-call `state`:

- Runtime template-var values (`{location}` → "the kitchen")
- Selections and modes the caller wants to override

The same JSON your editor exports is loadable as a self-contained model;
the studio also lets you save snapshots in the browser's localStorage
for quick switching during authoring.

## What the engine does NOT do

- It does not parse free-form natural language descriptions of prompts.
- It does not multiplex providers within a single call.
- It does not "chain" — that's a higher-level concern. Compose by
  calling `Engine.run` multiple times with different states.
- It does not validate semantic correctness of generated text beyond
  what `OutputPolicy` regex/length checks express.

## Why this shape

The earlier iteration of the library shipped Routes, Overlays,
Injections, Presets, and Pools as separate concepts. They each had
their own merge/sample/select rule. Authoring a prompt meant learning
four mental models and reasoning about how they composed. The registry
collapses all of that into one shape (sections of items + an assembly
order) with one set of orthogonal modifiers (runtime modes, fragments,
sliders). Less to learn, less to round-trip, less to break.
