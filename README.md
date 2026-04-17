# prompt_engine

A small, composable library for building prompts, routing requests through
named strategies, and generating with pluggable providers. The engine is
domain-agnostic — it provides the pieces, you assemble them.

See [`PROMPT_ENGINE_DESIGN.md`](PROMPT_ENGINE_DESIGN.md) for design rationale.
A browser-based test bench built on top of the library lives on the
[`test-bench`](https://github.com/sockheadrps/PromptEngine/tree/test-bench)
branch.

## Install

```bash
pip install httpx  # only needed for OllamaProvider
```

The library itself has no runtime dependencies. Drop the `prompt_engine/`
package into your project, or install from source.

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
to omit the section. That's the whole extension point.

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
