# prompt_engine

A small, composable library for apps that send more than one kind of prompt
to an LLM. Define named **routes** (e.g. `analyst`, `creative`, `json_extract`)
that each compose their own system + user prompt, sampling params, and
output-validation policy. Layer transient **context overlays** on top of a
long-lived base context to steer a single run without rewriting it. Attach
stackable **injections** (e.g. `tighten`, `json_only`) for cross-cutting
style/format tweaks. Swap providers (Ollama, mock, or your own) without
touching the rest.

Good fit for: multi-mode assistants, agents that switch strategies per
task, prompt A/B testing, iterative refinement loops where each user
follow-up becomes a reusable overlay, and any app where prompt-construction
logic has outgrown f-strings. Domain-agnostic — the library ships the
pieces, you decide what they mean.

See [`PROMPT_ENGINE_DESIGN.md`](PROMPT_ENGINE_DESIGN.md) for design rationale.
A browser-based test bench built on top of the library lives on the
[`test-bench`](https://github.com/sockheadrps/PromptEngine/tree/test-bench)
branch.

## Install

```bash
pip install .                 # library only, no runtime deps
pip install ".[ollama]"       # adds httpx for OllamaProvider
pip install ".[server]"       # adds FastAPI stack for the test bench
pip install ".[dev]"          # adds pytest + pytest-asyncio for the test suite
```

The library itself has no runtime dependencies. The extras above pull in
only what the named surface needs.

## Tests

```bash
pip install ".[dev]"
pytest
```

Covers engine flow, composite builder, overlay priority + expiry, prompt
budget trim, middleware ordering, streaming, output policy, run history,
and typed route inputs.

## Core concepts

| Piece                    | What it does                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `GenerationConfig`       | Sampling params + provider/model selection. Immutable; use `merged_with()`. |
| `ContextStore`           | Long-lived base context + named overlays with priority and optional expiry. |
| `PromptAssetRegistry`    | Reusable snippets: frames, rules, personas, endings, example/nudge pools, injectors. |
| `PromptRoute` / `Router` | Named composition strategies. The router picks one per request.             |
| `CompositeBuilder`       | Assembles system + user prompts from ordered section callables.             |
| `ProviderAdapter`        | The thing that actually runs the model. Ships with `OllamaProvider`, `MockProvider`. |
| `OutputProcessor`        | Cleans and validates model output against a policy (strip fences, regex, etc). |
| `RecentOutputMemory`     | Bounded log used to detect near-duplicate outputs (Jaccard).                |
| `RunHistory`             | Bounded log of full runs `{request, output, accepted, route, at}` for replay. |
| `TemplateRenderer`       | Small `{slot}` substitution for parameterised base contexts / overlays.     |
| `RandomSource`           | Injectable RNG (`DefaultRandom`, `SeededRandom`) used by example/nudge pools. |
| `PromptEngine`           | Glues it together. `generate_once(request)` is the single entry point.      |

## Minimal example

```python
import asyncio
from prompt_engine import (
    CompositeBuilder, ContextStore, GenerationConfig, GenerationRequest,
    MockProvider, OutputProcessor, PromptAssetRegistry, PromptEngine,
    PromptRoute, PromptRouter, section,
)
from prompt_engine.builders.builder import BuildContext


def frame(ctx: BuildContext) -> str:
    return ctx.assets.frame("core")


def user_input(ctx: BuildContext) -> str:
    return f"Question:\n{ctx.request.inputs.get('input', '')}"


assets = PromptAssetRegistry()
assets.add_frame("core", "You are a careful, helpful assistant. Be concise.")

router = PromptRouter(default_route="default")
router.register(PromptRoute(
    name="default",
    description="General assistant.",
    builder=CompositeBuilder(
        name="default",
        system_sections=(frame,),
        user_sections=(user_input, section("Respond now.")),
    ),
))

engine = PromptEngine(
    config=GenerationConfig(provider="mock", model="demo"),
    context_store=ContextStore(base="The assistant operates in demo mode."),
    asset_registry=assets,
    router=router,
    provider=MockProvider(),
    output_processor=OutputProcessor(),
)

async def main():
    result = await engine.generate_once(GenerationRequest(
        mode="default",
        inputs={"input": "What is entropy?"},
        debug=True,
    ))
    print(result.text)

asyncio.run(main())
```

## How the pieces fit

```
GenerationRequest
      │
      ▼
PromptRouter ───► PromptRoute.builder ──► PromptPackage (system + user + overrides)
      ▲                  ▲                        │
      │                  │                        ▼
ContextStore       PromptAssetRegistry       ProviderAdapter
(base + overlays)  (frames, rules, injectors)       │
                                                    ▼
                                         OutputProcessor (clean + validate)
                                                    │
                                                    ▼
                                         GenerationResult
                                         (plus trace, plus RunHistory entry)
```

A request flows through `router.select()`, then the selected route's builder
produces a `PromptPackage`. Injections and generation overrides in the
package merge with the engine's base config. The provider runs it, the
output processor cleans/validates, and the engine optionally retries.

## Context overlays

`ContextStore` holds one long-lived `base` string plus any number of named
overlays. Overlays have a priority (higher = applied first) and an optional
expiry. They're the right place for transient facts, user preferences, or
follow-up constraints:

```python
from prompt_engine import ContextOverlay, make_turn_overlay

store.set_overlay("budget", ContextOverlay(
    text="User wants to keep total under $800.",
    priority=20,
))

# Helper for iteration turns — keeps the verbatim original in metadata so
# callers can revert or re-compact later.
store.set_overlay("iteration_1", make_turn_overlay(
    verbatim="actually please make this shorter",
    compacted="Prefer shorter responses.",  # optional
    priority=25,
))
```

## Routes and builders

A route is a named strategy. `CompositeBuilder` is usually enough — give it
a sequence of section callables and it concatenates their output:

```python
PromptRoute(
    name="analyst",
    description="Structured analysis with explicit tradeoffs.",
    builder=CompositeBuilder(
        name="analyst",
        system_sections=(frame_fn, persona_fn),
        user_sections=(user_input_fn, section("Summary / Tradeoffs / Open questions.")),
        generation_overrides={"temperature": 0.6, "max_tokens": 700},
        output_policy={"strip_prefixes": ["```"]},
    ),
)
```

Section callables receive a `BuildContext` and return a string. Return `""`
to omit the section. That's the whole extension point for `CompositeBuilder`.
For anything more elaborate, implement the `PromptBuilder` protocol — a
single method, `build(ctx: BuildContext) -> PromptPackage`.

## Typed route inputs (opt-in)

Routes can declare an `inputs_schema` — any dataclass — that describes
what `GenerationRequest.inputs` must contain. The engine validates inputs
before building and raises `InputValidationError` with a list of missing
required fields:

```python
from dataclasses import dataclass, field
from prompt_engine import InputValidationError, PromptRoute

@dataclass
class AnalystInputs:
    topic: str                # required
    tone: str = "neutral"     # optional
    tags: list[str] = field(default_factory=list)

route = PromptRoute(
    name="analyst",
    builder=analyst_builder,
    inputs_schema=AnalystInputs,
)

try:
    await engine.generate_once(GenerationRequest(mode="analyst", inputs={"tone": "crisp"}))
except InputValidationError as e:
    print(e.route, e.missing)   # "analyst", ["topic"]
```

The contract is additive — extras beyond the schema are allowed, so
callers can pass metadata through without breaking existing routes.
Leaving `inputs_schema` unset preserves the old `Mapping[str, Any]`
behavior, so this is opt-in per route.

## Templating

`TemplateRenderer` does small-footprint `{slot}` substitution, useful when
a base context or overlay has parameterised values:

```python
from prompt_engine import TemplateRenderer, TemplateField

renderer = TemplateRenderer()
rendered = renderer.render(
    "You advise {user_name} about {topic}.",
    fields=[
        TemplateField(key="user_name", value="Kara"),
        TemplateField(key="topic", value="billing disputes", aliases=("subject",)),
    ],
)
```

Missing slots can auto-append as trailing sentences, whitespace is
normalised, and `aliases` let one value resolve multiple slot names.

## Reproducibility

Pick examples and nudges deterministically by passing a seeded RNG:

```python
from prompt_engine import SeededRandom

engine = PromptEngine(..., random=SeededRandom(42))
```

Useful for tests, golden-output fixtures, and A/B comparing prompt changes
without sampling noise swamping the signal.

## Injections

Injectors are small, named `InjectionTemplate` objects registered on the
asset registry. Callers pass their names in `GenerationRequest.injections`
to layer extra instructions and/or generation overrides on top of a route:

```python
assets.add_injector("json_only", InjectionTemplate(
    instructions="Return ONLY minified JSON.",
    generation_overrides={"temperature": 0.2},
    output_policy={"strip_prefixes": ["```json", "```"]},
))

await engine.generate_once(GenerationRequest(
    mode="analyst",
    inputs={"input": "..."},
    injections=["json_only"],
))
```

## Providers

`ProviderAdapter` is a small async interface. Implementations included:

- `OllamaProvider(base_url=...)` — talks to a local Ollama / OpenAI-compatible server.
- `MockProvider()` — echoes the prompt; handy for tests.

Write your own by implementing `async def generate(request) -> ProviderResponse`.

### Streaming

Providers can optionally implement `async def stream(request)` yielding
`ProviderStreamChunk(text=..., done=False)` per token and a terminal
`ProviderStreamChunk(done=True, response=ProviderResponse(...))`. Both
`MockProvider` and `OllamaProvider` support this. The engine exposes
`generate_stream(request)`, which yields `GenerationChunk(delta=...)` per
chunk and a final `GenerationChunk(done=True, result=GenerationResult(...))`:

```python
async for chunk in engine.generate_stream(request):
    if chunk.done:
        final = chunk.result        # same shape as generate_once returns
    elif chunk.delta:
        print(chunk.delta, end="", flush=True)
```

Streaming makes exactly one provider call — retries are skipped because
replaying a stream mid-output is more surprising than useful. If the
terminal `result.accepted` is `False`, fall back to `generate_once`.

## Middleware

Attach cross-cutting concerns (logging, metrics, caching, rate-limiting,
redaction) without touching prompt construction:

```python
class LatencyLogger:
    async def before(self, request):
        self.started = time.perf_counter()
    async def after(self, request, result):
        print(f"route={result.route} ms={(time.perf_counter() - self.started)*1000:.1f}")

engine = PromptEngine(..., middlewares=[LatencyLogger()])
engine.add_middleware(OtherMiddleware())
```

Either method can be sync or async. Returning `None` means pass-through;
returning a new request/result replaces it for inner middleware and the
engine. `before` runs in registration order, `after` in reverse, so a
middleware registered first sees the final outbound request and the final
returned result. Middleware wraps both `generate_once` and `generate_stream`.

## Prompt-size budget

Set `max_prompt_chars` on `GenerationConfig` (or via a route's
`generation_overrides`) to cap the outgoing prompt. When the built
`system + user` exceeds the budget, the engine drops the lowest-priority
overlay from the snapshot, rebuilds the package, and repeats until it fits
or no overlays remain. The debug trace reports under `metadata.budget`
which overlays were dropped, the final size, and whether the prompt was
still over budget after exhausting overlays.

## Output processor

`OutputProcessor` applies a policy derived from the route + any injection
overrides: strip code fences, enforce required regex patterns, reject
forbidden substrings. Rejected attempts are retried up to
`GenerationConfig.retries` times before the best-available text is
returned.

## Debug trace

Pass `debug=True` on the request and the result carries a `GenerationTrace`
with the system/user prompts, every attempt, the resolved config, and the
context snapshot that produced them. Useful for reproducing runs and
understanding routing decisions.

## Run history

Plug a `RunHistory` into the engine and every `generate_once` call is
recorded with its full request shape so UIs can surface replay / reload.
Kept separate from `RecentOutputMemory` (which only exists to detect
output repetition). Each does one thing.

## License

MIT (see LICENSE when added).
