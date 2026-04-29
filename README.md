# promptlibretto

![promptlibretto intro](docs/assets/intro.gif)

A prompt-engineering library plus a browser studio for designing,
tuning, and exporting prompts as portable JSON.

A **registry** is a flat list of named *sections* (`personas`,
`sentiment`, `examples`, `prompt_endings`, …); each section holds *items*
with their own fields. An `assembly_order` of tokens
(`section` / `section.field` / `section[expr]`) tells the engine how to
weave the selected items into one prompt. Per-array runtime modes
(`all` / `index:N` / `random:K` / `none`), section-level random pickers,
optional `pre_context` headings, and conditional text fragments handle
all the small "don't show this if the var is empty" details that
otherwise pile up as f-string spaghetti.

- Full docs & walkthrough: **[sockheadrps.github.io/promptlibretto](https://sockheadrps.github.io/promptlibretto/)**
- Design rationale: [DESIGN.md](DESIGN.md)
- Studio: [studio/](studio/)
- online tool https://promptlibretto.readtheerror.com/

## Install

```bash
pip install promptlibretto                # library only
pip install "promptlibretto[ollama]"      # adds httpx for OllamaProvider
pip install "promptlibretto[studio]"      # adds the browser studio
pip install "promptlibretto[dev]"         # pytest + pytest-asyncio
```

## Two paths

### 1. Tune in the studio, load JSON in your app

```bash
pip install "promptlibretto[studio,ollama]"
promptlibretto-studio --port 8000
```

Open `http://localhost:8000`. The studio has two pages:

- **Studio** (`/`) — pick selections, set runtime modes, fill template
  vars, pre-generate, and generate against your local Ollama. Click
  **Export Model JSON** to copy the canonical registry.
- **Builder** (`/builder`) — visual form-based editor for constructing a
  registry from scratch. Hit **Load Example** to see a fully populated
  registry, or **Import JSON** to load an existing one. The **Finalizer**
  panel shows live Registry JSON and an **Example Prompt** tab that renders
  a text preview of the assembled prompt as you build. **Generate Registry**
  exports the JSON; **Open in Studio** sends it directly to the Studio.

![Studio Compose view](docs/assets/screenshots/studio-compose.png)

![Builder overview](docs/assets/screenshots/builder-overview.png)

When you like the setup, click **Export Model JSON** in the Studio to
copy the canonical registry — including selections, runtime modes,
slider positions, and generation overrides. Then in your app:

```python
import asyncio
from promptlibretto import load_registry, OllamaProvider

eng = load_registry(
    "twitch_chatter.json",
    provider=OllamaProvider("http://localhost:11434", "/api/chat"),
)

async def main():
    result = await eng.run(state={
        "selections": {
            "sentiment": "positive",
            "personas": "the_troll",
        },
        "array_modes": {
            "sentiment": {"nudges": "random:1", "examples": "none"},
            "examples":  {"items": "random:3"},
        },
        "section_random": {"personas": True},          # re-roll persona each run
        "sliders":        {"sentiment": 8},            # sentiment.scale token
        "template_vars":  {"base_context::location": "the kitchen"},
    })
    print(result.text)

asyncio.run(main())
```

`load_registry()` accepts a path, a JSON string, or a dict. It returns
an `Engine` you can call `hydrate()` on (no LLM, returns the prompt
string) or `run()` on (hydrate + provider call + output policy).

### 2. Build it in code

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
                {"id": "shy",   "context": "You're nervous about speaking."},
                {"id": "loud",  "context": "You're full of energy."},
            ],
        },
    }
})

eng = Engine(reg, provider=MockProvider())
print(eng.hydrate(state={"selections": {"personas": "loud"}}))
# Be brief.
#
# You're full of energy.
```

The full state shape (all fields optional):

```python
state = {
    "selections":     {section_key: id | [id, ...]},   # required: id, multi: [ids]
    "array_modes":    {section_key: {field: "all" | "none" | "index:N" | "random:K"}},
    "section_random": {section_key: bool},             # re-roll item at hydrate time
    "sliders":        {section_key: int},              # drives `<section>.scale` token
    "slider_random":  {section_key: bool},             # re-roll slider at hydrate time
    "template_vars":  {"<section>::<var>": "value"},   # filled into {var} placeholders
}
```

Optional **routes** swap `assembly_order` / `generation` / `output_policy`
per call:

```python
reg.routes["short"] = Route(assembly_order=["output_prompt_directions"])
result = await eng.run(state=..., route="short")
```

If a registry has no `routes`, the top-level `assembly_order` is the
only path.

## Example registry shape

This is a neutral shape example, not default content. Keep only the
sections and tokens your prompt actually needs.

```jsonc
{
  "registry": {
    "version": 22,
    "title": "Example Registry",
    "assembly_order": [
      "output_prompt_directions",
      "base_context.text",
      "personas.context",
      "sentiment.context",
      "sentiment.nudges",
      "sentiment.scale",
      "examples.normal_examples",
      "sentiment.examples",
      "prompt_endings"
    ],
    "base_context": {
      "required": true,
      "template_vars": ["location"],
      "items": [{
        "name": "context",
        "text": "Use this runtime context: {location}."
      }]
    },
    "personas": { "required": true, "items": [/* {id, context, base_directives[]} */] },
    "sentiment": { "required": true, "items": [/* {id, context, nudges[], examples[]} */] },
    "static_injections":   { "required": false, "items": [/* {name, text} */] },
    "runtime_injections":  { "required": false, "items": [/*
      {id, text, include_sections[], required}
    */] },
    "output_prompt_directions": { "required": true, "items": [/* {name, text} */] },
    "examples":            { "required": false, "items": [/*
      {name, items[], pre_context}
    */] },
    "prompt_endings":      { "required": true, "items": [/* {name, items[]} */] }
  }
}
```

Sections you don't need can be omitted entirely; the registry is open.

## Why bother

- One mental model — sections of items, an assembly order, and per-array
  runtime modes. No separate route/overlay/injection vocabularies.
- The studio's JSON is the same JSON the library loads. No codegen, no
  schema drift between editor and runtime.
- Conditional text fragments (`{if_var, text}`) drop cleanly when their
  variable is empty, so an unfilled `{sublocation}` doesn't leave a
  broken sentence.
- Output policy (length caps, forbidden patterns, required regex,
  prefix/suffix stripping) and retries on rejection are still here, just
  nested inside the registry or a route.

Don't use it if you send exactly one prompt shape with one fixed wording.
An f-string is fine.

## Library API at a glance

Everything below is exported from the top-level package
(`from promptlibretto import …`).

| Name                                | What it is                                              |
| ----------------------------------- | ------------------------------------------------------- |
| `Engine`                            | Hydrate / run / stream against a registry.              |
| `Registry` / `Section` / `Route`    | The model dataclasses. `Registry.from_dict` / `to_dict` round-trip the JSON. |
| `HydrateState`                      | Per-call state object. `HydrateState.from_dict({...})` accepts the dict shown earlier. |
| `hydrate(reg, state, *, route=None, seed=None)` | Functional version of `Engine.hydrate`. Useful when you don't need a provider. |
| `load_registry(source, provider)`   | Parse path / JSON string / dict → `Engine`.             |
| `export_json(engine_or_registry)`   | Serialize back to JSON string.                          |
| `GenerationResult`                  | `text, accepted, prompt, route, reason, usage, timing, raw` |
| `GenerationChunk`                   | `delta, done, result` — yielded by `Engine.stream`.     |
| `GenerationConfig`                  | `model, temperature, top_p, top_k, max_tokens, repeat_penalty, retries, max_prompt_chars, timeout_ms`. `max_prompt_chars` is stored in config but not enforced by the current engine. |
| `OutputPolicy` / `OutputProcessor`  | Output cleaning + validation rules, see below.          |
| `MockProvider(responder=None, latency_ms=5.0)` | Echoes the prompt back, optionally transformed. Used in tests. |
| `OllamaProvider`                    | Talks to Ollama or any OpenAI-compatible endpoint.      |
| `ProviderAdapter` (Protocol)        | Implement `async def generate(request) -> ProviderResponse` to add your own. |
| `StreamingProviderAdapter`          | Plus `def stream(request) -> AsyncIterator[ProviderStreamChunk]`. |
| `supports_streaming(provider)`      | True iff the provider has a `stream` method.           |
| `SCHEMA_VERSION` / `SECTION_KEYS`   | The current registry version (22) and canonical section keys. |

### Streaming

```python
async for chunk in eng.stream(state=...):
    if chunk.delta:
        print(chunk.delta, end="", flush=True)
    if chunk.done:
        result: GenerationResult = chunk.result
        print(f"\n[ok={result.accepted} {result.timing}]")
```

`Engine.stream()` raises if the provider doesn't implement
`StreamingProviderAdapter`. `OllamaProvider` does; `MockProvider` does too.

### Custom provider

```python
from promptlibretto import ProviderAdapter, ProviderRequest, ProviderResponse

class MyProvider:
    async def generate(self, request: ProviderRequest) -> ProviderResponse:
        return ProviderResponse(text="…")  # call your API here

eng = Engine(reg, provider=MyProvider())
```

### `OllamaProvider` configuration

```python
from promptlibretto import OllamaProvider

OllamaProvider(
    base_url="http://localhost:11434",     # default
    chat_path="/api/chat",                 # or "/v1/chat/completions" for OpenAI-compat
    payload_shape="auto",                  # "ollama" | "openai" | "auto"
    client=httpx.AsyncClient(timeout=120.0),  # optional — pass a custom httpx.AsyncClient
)
```

`payload_shape="auto"` picks `openai` when `chat_path` contains `/v1/`,
`ollama` otherwise — covers both real Ollama and OpenAI-compatible
shims (LM Studio, llama.cpp's server, vLLM).

### `OutputPolicy` fields

All optional. Registry-level policy applies by default; when a route
defines `output_policy`, the route's fields replace fields with the
same names before the processor is built:

```python
OutputPolicy(
    min_length=None, max_length=None,
    strip_prefixes=(),               # remove these prefixes (case-insensitive)
    strip_patterns=(),               # regex; multiline; replaced with ""
    forbidden_substrings=(),         # exact substrings; reject if present
    forbidden_patterns=(),           # regex; reject if matched
    require_patterns=(),             # regex; reject if not matched
    append_suffix=None,              # always appended after cleaning
    collapse_whitespace=True,
)
```

`OutputPolicy.merged_with()` itself is additive for sequence-typed
fields (`strip_prefixes`, `strip_patterns`, `forbidden_*`,
`require_patterns`) and replace-on-merge for scalars. `Engine.run()`
currently applies route policy with a dictionary update first, so a
route-level sequence field replaces the registry-level value for that
field rather than extending it.

### Generation overrides at registry / route level

```python
reg = Registry.from_dict({
    "registry": {
        "generation": {"temperature": 0.4, "max_tokens": 96},
        "output_policy": {"max_length": 280, "forbidden_substrings": ['"']},
        "routes": {
            "raid": {
                "assembly_order": [...],
                "generation": {"max_tokens": 64},   # overrides for this route
                "output_policy": {"strip_prefixes": ["Sure,"]},
            },
        },
        # … sections …
    }
})
```

## CLI

```bash
promptlibretto-studio --host 0.0.0.0 --port 8000
```

Environment variables (server-side `/api/registry/generate` only):

| Var                      | Default                  | Effect                                |
| ------------------------ | ------------------------ | ------------------------------------- |
| `PROMPT_ENGINE_MOCK`     | `0`                      | `1` / `true` — use `MockProvider`.    |
| `OLLAMA_URL`             | `http://localhost:11434` | Base URL for Ollama.                  |
| `OLLAMA_CHAT_PATH`       | `/api/chat`              | Chat endpoint path (auto-detects shape). |

The studio frontend itself goes browser-direct to the user's local
Ollama after asking the server to hydrate the prompt. In that path,
response validation/retries are not applied by the Python engine; these
vars and the engine's output policy only affect the optional
server-side generate route.

## Development

```bash
pip install "promptlibretto[dev]"
pytest
```

## License

MIT (see LICENSE when added).
