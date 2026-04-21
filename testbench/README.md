# Test Bench Server

A browser-based test bench for the `promptlibretto` library. FastAPI on the
back, vanilla JS on the front, one engine instance per process. The goal
isn't to be a product — it's to exercise every surface of the library
(routes, overlays, injections, run history, iteration turns, streaming,
middleware, budget) against a real local model, so you can *see* the
pieces move when you change them.

## Framing

The engine is the source of truth. The server is a thin translation layer:
HTTP request in → engine state mutation or `engine.generate_once()` out.
Almost no logic lives in the route handlers. If a concept (routes,
overlays, injections, etc.) exists in the library, the server surfaces it
as close to raw as possible rather than inventing a parallel model.

That framing shows up in a few places:

- **`GET /api/state` is the single read endpoint.** It dumps config,
  routes, overlays, injections, recent outputs, and run history in one
  payload. The front-end re-renders from that on every meaningful change.
  Avoids the usual N-endpoint fan-out where the client has to stitch
  together independent views.
- **`POST /api/generate` is the normal write endpoint for generation.**
  Everything else mutates context — base text, overlays, config — then
  `/generate` reads it and produces output. `POST /api/generate/stream`
  exercises the same engine path with token streaming. Separating state
  mutation from generation keeps both sides simple.
- **Handlers never build prompts.** They call engine methods. Prompt
  construction, routing, output validation, retry, and recording all
  happen inside the engine. The server only wires HTTP shape to engine
  shape.

## Wiring

```
┌───────────────────── browser (static/app.js) ──────────────────────┐
│  config tab · context tab · routes · injections · iterate · runs  │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ fetch()
                           ▼
┌─────────────────── FastAPI (main.py) ──────────────────────────────┐
│  /api/state · /api/generate · /api/context/* · /api/config ·       │
│  /api/iterate · /api/scenarios · /api/run_history · /api/latency   │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ engine method calls
                           ▼
┌─────────────────── PromptEngine (library) ─────────────────────────┐
│  ContextStore · PromptAssetRegistry · PromptRouter · Provider ·    │
│  OutputProcessor · RecentOutputMemory · RunHistory · Middleware    │
└────────────────────────────────────────────────────────────────────┘
```

One engine is built in `lifespan()` and attached to `app.state`. All
handlers pull it via `_engine()`. The engine owns the context store, the
router, the provider, recent memory, and run history — the server only
holds two other stores (see below) that are *app-level concerns*, not
library concerns.

## App-level stores vs library stores

Some state belongs to the library (the things the engine needs to
generate). Some state belongs to the app (the things a UI wants to
persist across page reloads). They're kept separate on purpose.

| Store               | Lives in  | Purpose                                                 |
| ------------------- | --------- | ------------------------------------------------------- |
| `ContextStore`      | library   | Base text + overlays used to build prompts.             |
| `RecentOutputMemory`| library   | Dedup against near-duplicate outputs (Jaccard).         |
| `RunHistory`        | library   | Ordered log of full runs for replay.                    |
| `BaseLibrary`       | server    | Named, saveable base-context texts.                     |
| `ScenarioLibrary`   | server    | Full app-state snapshots (base + overlays + config).    |
| `LatencyLogger`     | server    | Middleware-populated ring buffer of run timings.        |

The library shouldn't know that someone wants to save base contexts by
name, or snapshot the entire UI, or watch request latency. Those are UI
affordances. Keeping them in the server makes the library boundary
obvious and keeps each store single-purpose.

Both `BaseLibrary` and `ScenarioLibrary` are tiny JSON-backed caches with
atomic tmp-file writes and a lock. They don't warrant a database.

## Composition, not configuration

The router and the asset registry are built imperatively in
[`presets.py`](presets.py) by calling `add_frame`, `add_injector`,
`PromptRoute(builder=CompositeBuilder(...))`. That's deliberate. The
library doesn't ship a YAML or JSON format for routes because the
expressive surface — sections as callables, overrides, output policy,
closures over assets — is already Python. Trying to encode that in a
declarative schema would either lose expressiveness or reinvent Python.

The presets are the example of how an app *should* wire up an engine,
not a required pattern. A real app swaps `presets.py` for its own
builders and keeps the rest.

## How generation flows through a request

1. Browser edits base text, adds an overlay, or flips a config value.
   Each is a small `PUT /api/context/*` or `PUT /api/config`. The engine
   is mutated in place.
2. Browser calls `POST /api/generate` or `POST /api/generate/stream` with
   `{mode, inputs, injections, debug, config_overrides}`.
3. Server constructs an engine `GenerationRequest` and calls
   `engine.generate_once()`. That's it — no prompt assembly on the
   server side.
4. Engine routes, builds, calls the provider, cleans+validates output,
   records to run history, runs middleware. The `GenerationResult` comes
   back with `{text, accepted, route, trace}`.
5. Handler returns it as JSON. Browser re-fetches `/api/state` to pick
   up the new overlay set, updated run history, etc., and re-renders.

## Middleware as app-level instrumentation

`middleware.py` has `LatencyLogger` — a minimal middleware that times
each generation and keeps the last 50 records in a deque. It's attached
at engine construction in `_build_engine()`. `GET /api/latency` exposes
the records for any UI that wants them.

This is the canonical use of the library's middleware hook: cross-cutting
concerns that shouldn't touch prompt construction. Logging, rate limiting,
caching, redaction all fit the same pattern. Adding one is ~20 lines and
one registration.

## Iteration turns

`POST /api/iterate` takes the most recent run's prompt + output plus the
user's follow-up, optionally runs a compaction route to densify it, and
writes the result back as a `turn_N` overlay via `make_turn_overlay()`.
The verbatim text is always preserved in overlay metadata, so the UI
exposes `recompact` and `revert` endpoints to undo the compaction step
without losing the underlying turn.

This is an app-level feature assembled from library primitives — the
library ships `make_turn_overlay`, a `compact_turn` route is registered
in `presets.py`, and the server orchestrates the three steps. The
library doesn't need to know what "iteration" means.

## Scenarios vs run history

Run history is the engine's. Scenarios are the server's. They answer
different questions:

- Run history: "what did I send and what came back, recently?"
- Scenario: "snapshot the whole app (base + overlays + config + recent
  runs) so I can come back to this exact setup tomorrow."

Scenarios are opaque JSON blobs captured and applied by the browser —
the server just persists them by name. Keeping the *capture* logic in
the browser (`captureScenarioState` / `applyScenarioState` in `app.js`)
means the server doesn't need to know what the UI considers "state."

Run history reloads only the original request-level `config_overrides`.
The fully resolved config is stored separately in each run's metadata, so
route defaults remain inspectable without becoming sticky GUI overrides
when a prior run is loaded.

## Running

```bash
pip install fastapi uvicorn httpx pydantic
python run.py                         # defaults to Ollama at localhost:8080
PROMPT_ENGINE_MOCK=1 python run.py    # no model required; echoes prompts
```

Env vars: `OLLAMA_URL`, `OLLAMA_MODEL`, `PROMPT_ENGINE_MOCK`.

## File map

- [`main.py`](main.py) — FastAPI app, lifespan, endpoints, Pydantic bodies.
- [`presets.py`](presets.py) — example routes, frames, personas, injectors.
- [`middleware.py`](middleware.py) — `LatencyLogger` middleware.
- [`base_library.py`](base_library.py) — named base-context store.
- [`scenario_library.py`](scenario_library.py) — named full-state store.
- [`static/index.html`](static/index.html) — single-page UI skeleton.
- [`static/app.js`](static/app.js) — fetch + render + event wiring.
- [`static/style.css`](static/style.css) — layout and pills/cards styling.
