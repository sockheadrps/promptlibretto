# promptlibretto

A prompt-engineering library — plus a browser studio to design, tune, and
export that setup as a portable JSON config.

Define named **routes** that each compose their own system + user prompt,
sampling params, and output policy. Layer transient **context overlays**
on a long-lived base. Attach stackable **injections** for cross-cutting
style/format tweaks. Swap providers without touching the rest.

Good fit for multi-mode assistants, agents that switch strategies per
task, prompt A/B testing, and iterative refinement loops where each user
follow-up becomes a reusable overlay.

- Full docs & walkthrough: **[sockheadrps.github.io/promptlibretto](https://sockheadrps.github.io/promptlibretto/)**
- Design rationale: [DESIGN.md](DESIGN.md)
- Studio: [studio/](studio/)

![Analyst route generating](docs/assets/screenshots/generation.gif)

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
PROMPTLIBRETTO_EXPORT_DIR=. promptlibretto-studio
```

Design the route, mark any overlays as `runtime: required/optional`,
click **Export as JSON → Save to disk**. Then:

```python
import asyncio
from promptlibretto import load_engine

engine, run = load_engine("my_assistant.json")

async def main():
    result = await run(
        "what should I cook tonight?",
        location="kitchen",            # required runtime slot
        focus="quick weeknight meal",  # optional runtime slot
        dietary="vegetarian",          # ad-hoc priority-10 overlay
    )
    print(result.text)

asyncio.run(main())
```

No codegen. `load_engine()` rebuilds the exact engine you tuned and
returns a `run()` closure that handles runtime slots and stray kwargs.

### 2. Build it in code

The smallest useful engine:

```python
import asyncio
from promptlibretto import PromptEngine

engine = PromptEngine(routes={"default": "Say hi."})
print(asyncio.run(engine.generate_once()).text)
```

The constructor takes loose types: `config` as dict or `GenerationConfig`;
`context_store` as str, dict, or `ContextStore`; `provider` as `"mock"`,
`"ollama"`, or an adapter; `routes` as `{name: str | list | dict |
CompositeBuilder | PromptRoute}`.

A fuller wiring:

```python
import asyncio
from promptlibretto import (
    CompositeBuilder, ContextOverlay, GenerationConfig, GenerationRequest,
    MockProvider, PromptAssetRegistry, PromptEngine, PromptRoute,
    PromptRouter, section, make_runtime_overlay,
)

assets = PromptAssetRegistry()
assets.add("frame.core", "You are a careful, helpful assistant.")

router = PromptRouter(default_route="default")
router.register(PromptRoute(
    name="default",
    builder=CompositeBuilder(
        name="default",
        system_sections=(lambda ctx: ctx.assets.get("frame.core"),),
        user_sections=(
            section(lambda ctx: f"Q:\n{ctx.request.inputs.get('input','')}"),
            section("Respond now."),
        ),
        generation_overrides={"temperature": 0.6},
        output_policy={"strip_prefixes": ["```"]},
    ),
))

engine = PromptEngine(
    config=GenerationConfig(provider="mock", model="demo"),
    context_store="The assistant operates in demo mode.",
    asset_registry=assets,
    router=router,
    provider=MockProvider(),
)

# Overlays are transient facts layered on the base, keyed by name:
engine.context_store.set_overlay(
    "budget", ContextOverlay(text="Keep total under $800.", priority=20),
)
# `make_runtime_overlay` declares a slot caller fills at call time:
engine.context_store.set_overlay("location", make_runtime_overlay("required"))

asyncio.run(engine.generate_once(GenerationRequest(
    inputs={"input": "What should I cook?", "location": "kitchen"},
)))
```

See the [docs site](https://sockheadrps.github.io/promptlibretto/) for
streaming, middleware, injections, output policy, the prompt-size budget,
the debug trace, and `export_json` / `load_engine` internals.

## Why not just f-strings?

Use this when:

- **You have more than one kind of prompt** and they share structure.
  Routes let you name and swap strategies without duplicating boilerplate.
- **Follow-ups should affect future runs.** Overlays let "make it shorter"
  stick around as a reusable piece of context.
- **Output needs validation or retry** — required regex, stripped code
  fences, banned phrases — handled once by the output processor instead of
  copy-pasted around call sites.

Don't use it if you send exactly one prompt shape. An f-string and a
direct provider call are fine.

## Development

```bash
pip install "promptlibretto[dev]"
pytest
```

## License

MIT (see LICENSE when added).
