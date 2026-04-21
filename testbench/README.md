# promptlibretto test bench

A browser UI over the `promptlibretto` library. FastAPI backend, vanilla
JS frontend, one engine per process. Exists to exercise every surface of
the library (routes, overlays, injections, run history, iteration turns,
streaming, middleware, budget) against a local model.

## Wiring

```
┌────────────── browser (static/app.js) ──────────────┐
│ config · context · routes · injections · runs       │
└───────────────────────┬─────────────────────────────┘
                        │ fetch()
                        ▼
┌────────────── FastAPI (main.py) ────────────────────┐
│ /api/state · /api/generate · /api/context/*         │
│ /api/config · /api/iterate · /api/scenarios         │
└───────────────────────┬─────────────────────────────┘
                        │ engine calls
                        ▼
┌────────────── PromptEngine (library) ───────────────┐
│ ContextStore · PromptAssetRegistry · PromptRouter   │
│ Provider · OutputProcessor · RecentOutputMemory     │
│ RunHistory · Middleware                             │
└─────────────────────────────────────────────────────┘
```

One engine is built in `lifespan()` and attached to `app.state`. Handlers
pull it via `_engine()`. The engine owns the context store, router,
provider, recent memory, and run history. The server holds two extra
stores for app concerns the library shouldn't know about.

## Stores

| Store               | Owner     | Purpose                                                 |
| ------------------- | --------- | ------------------------------------------------------- |
| `ContextStore`      | library   | Base text + overlays used to build prompts.             |
| `RecentOutputMemory`| library   | Dedup against near-duplicate outputs (Jaccard).         |
| `RunHistory`        | library   | Ordered log of full runs for replay.                    |
| `BaseLibrary`       | server    | Named, saveable base-context texts.                     |
| `ScenarioLibrary`   | server    | Full app-state snapshots (base + overlays + config).    |
| `LatencyLogger`     | server    | Middleware-populated ring buffer of run timings.        |

`BaseLibrary` and `ScenarioLibrary` are JSON-backed caches with atomic
tmp-file writes and a lock.

## API shape

- `GET /api/state` dumps config, routes, overlays, injections, recent
  outputs, and run history in one payload. The frontend re-renders from
  this on every meaningful change.
- `POST /api/generate` / `POST /api/generate/stream` run `engine.generate_once`
  or `engine.generate_stream`. Everything else mutates state; generate reads it.
- `PUT /api/context/*`, `PUT /api/config` mutate the engine in place.
- `POST /api/iterate` writes a compacted user follow-up back as a `turn_N`
  overlay via `make_turn_overlay()`. Verbatim text is preserved in overlay
  metadata so the UI can revert or recompact.

Handlers don't build prompts; they call engine methods.

## Panels

**Compose tab.** Route selector, user input, injection checkboxes,
generation overrides.

**Context state tab.** Base text at the top, named overlays below with
priority and expiry. "Suggest" asks the model to propose overlays against
the current base.

**Debug trace panel.** System prompt, user prompt, active context, every
attempt, and the resolved config — live-updated per run.

## Why imperative presets

The router and asset registry are built imperatively in
[`presets.py`](presets.py) with `add_frame`, `add_injector`,
`PromptRoute(builder=CompositeBuilder(...))`. Sections are callables,
overrides and output policy are passed through, and builders close over
assets — that expressive surface is already Python, so a YAML schema
would lose expressiveness or reinvent it. Swap `presets.py` for your own
and keep the rest.

## Middleware

`LatencyLogger` in [`middleware.py`](middleware.py) times each generation
and keeps the last 50 records in a deque, attached at engine construction.
`GET /api/latency` exposes them. Same pattern works for logging, caching,
redaction — any cross-cutting concern that shouldn't touch prompt
construction.

## Scenarios vs run history

Run history answers "what did I send and what came back recently?"
Scenarios answer "snapshot the whole app so I can come back to this
setup." Scenarios are opaque JSON blobs captured and applied by the
browser (`captureScenarioState` / `applyScenarioState` in `app.js`); the
server just persists them by name.

Run history reloads only the original `config_overrides`. The resolved
config lives in each run's metadata so route defaults stay inspectable
and don't become sticky GUI overrides on reload.

## Running

```bash
pip install "promptlibretto[testbench]"
promptlibretto-testbench                         # defaults to Ollama at localhost:8080
PROMPT_ENGINE_MOCK=1 promptlibretto-testbench    # no model required; echoes prompts
```

Env vars: `HOST`, `PORT`, `OLLAMA_URL`, `OLLAMA_MODEL`, `PROMPT_ENGINE_MOCK`,
`PROMPTLIBRETTO_DATA_DIR` (defaults to `~/.promptlibretto/testbench`).

## Files

- [`main.py`](main.py) — FastAPI app, lifespan, endpoints.
- [`presets.py`](presets.py) — example routes, frames, personas, injectors.
- [`middleware.py`](middleware.py) — `LatencyLogger`.
- [`base_library.py`](base_library.py) — named base-context store.
- [`scenario_library.py`](scenario_library.py) — named full-state store.
- [`static/index.html`](static/index.html) — single-page UI.
- [`static/app.js`](static/app.js) — fetch + render + event wiring.
- [`static/style.css`](static/style.css) — layout and styling.
