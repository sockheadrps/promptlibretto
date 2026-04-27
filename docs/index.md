# promptlibretto

A prompt-engineering library plus a browser studio for designing,
tuning, and exporting prompts as portable JSON.

A **registry** is a flat list of named *sections* — `personas`,
`sentiment`, `examples`, `prompt_endings`, and so on — each holding a
list of *items*. An `assembly_order` of tokens
(`section`, `section.field`, or `section[expr]`) tells the engine how to
weave the selected items into one prompt.

The same JSON the studio exports is the JSON the library loads. No
codegen, no schema drift between the editor and the runtime.

## Install

```bash
pip install promptlibretto                # library only
pip install "promptlibretto[ollama]"      # adds httpx for OllamaProvider
pip install "promptlibretto[studio]"      # adds the browser studio
pip install "promptlibretto[dev]"         # pytest + pytest-asyncio
```

## Quick start — library

```python
import asyncio
from promptlibretto import Engine, MockProvider, Registry

reg = Registry.from_dict({
    "registry": {
        "assembly_order": ["output_prompt_directions", "personas.context"],
        "output_prompt_directions": {
            "required": True,
            "items": [{"name": "rules", "text": "Be brief."}],
        },
        "personas": {
            "required": True,
            "items": [
                {"id": "shy",  "context": "You're nervous about speaking."},
                {"id": "loud", "context": "You're full of energy."},
            ],
        },
    }
})

eng = Engine(reg, provider=MockProvider())
print(eng.hydrate(state={"selections": {"personas": "loud"}}))
```

Output:

```
Be brief.

You're full of energy.
```

## Quick start — studio

```bash
pip install "promptlibretto[studio,ollama]"
promptlibretto-studio --port 8000
```

Open <http://localhost:8000>. From there:

1. **Import JSON…** to paste a registry, or use the schema skeleton in
   the repo as a starting point.
2. Pick selections (dropdowns / checkboxes), set per-array runtime modes
   (`all` / `none` / `index:N` / `random:K`), fill template-var inputs,
   and use the sentiment-intensity slider.
3. **Pre-generate** to render the prompt; **Generate** to send it
   browser-direct to your local Ollama.
4. **Export Model JSON** copies the canonical registry — selections,
   runtime modes, slider, generation overrides, all baked in — to
   load in your app via `load_registry()`.

## State shape

```python
state = {
    "selections":     {section_key: id | [id, ...]},
    "array_modes":    {section_key: {field: "all" | "none" | "index:N" | "random:K"}},
    "section_random": {section_key: bool},
    "sliders":        {section_key: int},
    "slider_random":  {section_key: bool},
    "template_vars":  {"<section>::<var>": "value"},
}
```

All fields optional. Selections default to the first item of each
required section. Modes default to `all`.

## Hydrate vs run

```python
prompt = eng.hydrate(state=...)             # string, no LLM call
result = await eng.run(state=...)           # hydrate + provider + output policy
result = await eng.run(state=..., route="raid")    # optional route override
async for chunk in eng.stream(state=...):   # streaming providers only
    ...
```

Seed for reproducibility:

```python
prompt = eng.hydrate(state=..., seed=42)
```

## Optional routes

```python
from promptlibretto import Route

reg.routes["raid"] = Route(
    assembly_order=["runtime_injections", "output_prompt_directions"],
    generation={"max_tokens": 96, "temperature": 0.4},
    output_policy={"max_length": 280},
)

result = await eng.run(state=..., route="raid")
```

If a registry has no `routes`, the top-level `assembly_order` is the
only path.

## API reference

Everything lives at the top of the package: `from promptlibretto import …`.

### Model

`Registry`
: Dataclass for the whole model. `Registry.from_dict(d)` accepts both
  wrapped (`{"registry": {...}}`) and bare dicts. `reg.to_dict(wrap=True)`
  serializes it back. Attributes: `version`, `title`, `description`,
  `assembly_order: list[str]`, `sections: dict[str, Section]`,
  `routes: dict[str, Route]`, `generation: dict`, `output_policy: dict`.

`Section`
: One section. `required: bool`, `template_vars: list[str]`,
  `items: list[dict]`. May also carry studio-state extras
  (`selected`, `section_random`, `array_modes`, `slider`,
  `slider_random`) when round-tripping through `Export Model JSON`.

`Route`
: Optional override bundle. `assembly_order: list[str] | None`,
  `generation: dict`, `output_policy: dict`. Only the fields you set
  override the registry-level defaults at run time.

`SCHEMA_VERSION` / `SECTION_KEYS`
: Constants. `SCHEMA_VERSION == 22` for the current schema. `SECTION_KEYS`
  is the canonical ordered tuple of recognized section names.

### Hydration

`HydrateState`
: Per-call inputs. Either build it directly or use `HydrateState.from_dict(d)`
  with the state dict shape:

  ```python
  HydrateState(
      selections     = {"sentiment": "positive", "examples": ["normal"]},
      array_modes    = {"sentiment": {"nudges": "random:1"}},
      section_random = {"personas": True},
      sliders        = {"sentiment": 8},
      slider_random  = {"sentiment": False},
      template_vars  = {"base_context::location": "the kitchen"},
  )
  ```

`hydrate(reg, state, *, route=None, seed=None) -> str`
: Functional version of `Engine.hydrate`. Returns the assembled prompt.
  No provider call. Pass `seed` for deterministic random rolls.

### Engine

```python
class Engine:
    def __init__(
        self,
        registry: Registry | Mapping | None = None,
        provider: ProviderAdapter | str | None = None,
        output_processor: OutputProcessor | None = None,
    ): ...

    def hydrate(self, state, *, route=None, seed=None) -> str: ...
    async def run(self, state, *, route=None, seed=None) -> GenerationResult: ...
    async def stream(self, state, *, route=None, seed=None) -> AsyncIterator[GenerationChunk]: ...
```

`provider="mock"` builds a `MockProvider`. `None` does the same and
defers — calling `run` without a provider is fine if you only ever
`hydrate`.

### Results

`GenerationResult`
: Returned by `Engine.run`. Fields: `text` (cleaned + validated output),
  `accepted: bool`, `prompt` (the exact string sent to the LLM),
  `route: Optional[str]`, `reason: Optional[str]` (why a non-accepted
  result was rejected), `usage: Optional[dict]`, `timing: Optional[dict]`,
  `raw` (provider-specific payload).

`GenerationChunk`
: Yielded by `Engine.stream`. `delta: str` for incremental text;
  `done: bool` for the final chunk; `result: Optional[GenerationResult]`
  populated on the final chunk only.

### Generation config

```python
GenerationConfig(
    provider="ollama",      # informational only
    model="default",
    temperature=0.8,
    top_p=None, top_k=None,
    max_tokens=256,
    repeat_penalty=None,
    timeout_ms=60_000,
    retries=1,
    max_prompt_chars=None,
)
```

`Engine` builds one of these per call from `registry.generation` merged
with the active route's `generation`. You don't usually instantiate it
directly — set fields on the registry/route JSON instead.

### Output policy

```python
OutputPolicy(
    min_length=None, max_length=None,
    strip_prefixes=(),         # tuple/list of strings
    strip_patterns=(),         # tuple/list of regex strings
    forbidden_substrings=(),
    forbidden_patterns=(),
    require_patterns=(),
    append_suffix=None,
    collapse_whitespace=True,
)
```

`OutputProcessor.clean(text, ctx, policy)` strips, collapses whitespace,
truncates to `max_length`, and appends `append_suffix`. `validate(text,
ctx, policy)` returns a `ValidationResult(ok, reason)`.

Merge semantics on `OutputPolicy.merged_with(overrides)`:

- Sequence fields (`strip_prefixes`, `strip_patterns`,
  `forbidden_substrings`, `forbidden_patterns`, `require_patterns`) —
  **additive**: existing rules survive, overrides extend them.
- Scalars (`max_length`, `min_length`, `append_suffix`,
  `collapse_whitespace`) — **replace**.

This is why route-level policy plays nicely with registry-level
defaults: you don't have to redeclare base rules per route.

### Providers

`ProviderAdapter` (Protocol)
: Anything with `async def generate(request: ProviderRequest) -> ProviderResponse`.
  Drop-in: pass an instance to `Engine(...)`.

`StreamingProviderAdapter` (Protocol)
: Adds `def stream(request) -> AsyncIterator[ProviderStreamChunk]`. The
  final chunk has `done=True` and a `response` carrying the aggregated
  text/usage/timing.

`supports_streaming(provider) -> bool`
: True iff `provider.stream` is callable.

`OllamaProvider(base_url, chat_path, payload_shape="auto")`
: Talks to Ollama or any OpenAI-compatible chat endpoint. `payload_shape`
  defaults to auto-detect from `chat_path` (presence of `/v1/` ⇒
  `openai`).

`MockProvider(responder=None, latency_ms=10.0)`
: Echoes the user prompt back, optionally transformed by `responder`.
  Used in tests and demos.

`ProviderRequest` / `ProviderResponse` / `ProviderStreamChunk`
: Wire-shape dataclasses. `ProviderResponse` carries `text`, `usage`
  (`prompt_tokens` / `completion_tokens` / `total_tokens`), `timing`
  (`total_ms` / `load_ms` / `prompt_eval_ms` / `eval_ms`), and `raw`.

### Serialization

`load_registry(source, provider=None, output_processor=None) -> Engine`
: `source` may be a file path (`str` or `Path`), a JSON string, or an
  already-parsed `dict`. Returns a ready `Engine`.

`export_json(engine_or_registry, *, indent=2) -> str`
: Pretty-printed JSON wrapped under `"registry": { … }`. Round-trips
  through `Registry.from_dict`.

## Where to read next

- [Design rationale](design.md) — how the registry model fits together
  and why it replaced routes/overlays/injections/presets.
- [Studio](server.md) — designing prompts in the browser, exporting
  models, browser-direct LLM, and the registry HTTP API.
