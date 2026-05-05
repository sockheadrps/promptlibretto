# Studio and Server

The studio is a browser toolset for schema v2 registries. It runs as a FastAPI server and exposes three tools — Studio, Builder, and Ensemble — plus memory and registry HTTP APIs.

## Run

```bash
pip install "promptlibretto[studio,ollama]"
promptlibretto-studio --port 8000
```

Open <http://localhost:8000>.

## Pages

| Path | Tool | Purpose |
| --- | --- | --- |
| `/` | Studio | Runtime tuning: load a registry, adjust state, preview prompt, generate. |
| `/builder` | Builder | Visual authoring: build registry JSON from forms, then open it in Studio. |
| `/ensemble` | Ensemble | Two-participant conversation: model-vs-model or model-vs-human. |

## Registry Format

The studio loads and exports the same schema v2 registry shape that `Registry.from_dict()` accepts:

```json
{
  "registry": {
    "version": 2,
    "assembly_order": ["output_prompt_directions", "personas.context"],
    "output_prompt_directions": {
      "required": true,
      "items": [{"id": "rules", "text": "Reply briefly."}]
    },
    "personas": {
      "required": true,
      "items": [{"id": "direct", "context": "Be direct."}]
    }
  }
}
```

Runtime state is section-scoped:

```json
{
  "personas": {"selected": "direct"},
  "sentiment": {
    "selected": "warm",
    "slider": 7,
    "array_modes": {"groups[warm_examples]": "random:1"}
  }
}
```

## Studio

Studio is the runtime tuning surface. It lets you load a registry, select items per section, fill template variables, adjust sliders, set array modes, preview the hydrated prompt, and generate against a local model.

Browser-direct generation connects to a local Ollama or OpenAI-compatible endpoint from the browser. That path skips Python-side output-policy retries. For Python-side policy and retry behavior, use the server generate endpoint or load the exported registry in code with `Registry.from_dict()`.

## Builder

Builder is the visual authoring surface. It constructs registry JSON from forms — no hand-writing JSON required.

Builder supports:

- Guided new-registry setup flow (meta → memory choice → memory config → sections)
- Loading and importing existing registry JSON
- Editing sections, items, groups, assembly order, generation config, output policy, and memory config
- Previewing generated registry JSON
- Opening the result directly in Studio

Bundled builder examples live in `studio/static/builder-examples/`.

The server endpoint `POST /api/registry/example/save` can save examples back to the allowed static examples directory.

Registry version is always locked to `2`. There are no older schema versions.

## Ensemble

Ensemble runs two participants in conversation. Each participant can be model-driven (with a registry) or human-driven, and memory-enabled or disabled.

Participants each get their own engine, state, provider, and optional memory pipeline. Generation streams back to the browser as server-sent events.

Ensemble memory is isolated per participant. Each participant gets separate:

- Vector store database
- Personality file
- Working notes file
- System summary file

Resetting a participant wipes all of those artifacts. Personality, working notes, and system summary can preserve behavior even after the turn store is cleared.

## Registry HTTP API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/registry/load` | Parse and canonicalize registry JSON. |
| `POST /api/registry/hydrate` | Build a prompt for a registry and state. |
| `POST /api/registry/generate` | Hydrate, call provider, apply output policy. |
| `POST /api/registry/example/save` | Save a registry JSON file to the builder examples directory. |
| `GET /health` | Liveness check. |

Hydrate/generate request shape:

```json
{
  "registry": {"registry": {"version": 2}},
  "state": {
    "personas": {"selected": "direct"}
  },
  "route": "optional-route-name",
  "seed": 42
}
```

## Memory HTTP API

Memory routes live under `/api/memory`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/memory/generate` | Full memory pipeline: embed, retrieve, classify, route, generate, store turn. |
| `POST /api/memory/reset` | Clear memory store for a registry. |
| `POST /api/memory/personality` | Load the personality profile. |
| `POST /api/memory/personality/save` | Save edits to the personality profile. |
| `POST /api/memory/personality/clear` | Reset personality to seed. |
| `WebSocket /api/memory/ws/{session_id}` | Browser-delegated embedding and inference (see below). |

The `/api/memory/generate` response includes text, prompt, retrieved chunks, extracted tags, applied rules, timing, usage, and classifier stats.

Memory files (vector store, personality) are resolved from the registry title and `memory_config`. In multi-tenant mode they are nested under a per-user directory in `~/.promptlibretto/memory_stores/`.

## Ensemble HTTP API

Ensemble routes live under `/api/ensemble`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/ensemble/run` | Start an ensemble session. |
| `POST /api/ensemble/step/{session_id}` | Advance one turn. |
| `POST /api/ensemble/submit/{session_id}` | Submit human input for a human-driven participant. |
| `POST /api/ensemble/reset_store` | Wipe all artifacts for a participant. |
| `POST /api/ensemble/view_store` | Return recent turns, personality, working notes, and system summary. |
| `WebSocket /api/ensemble/ws/{session_id}/embed` | Browser-delegated embedding for ensemble memory. |

## Browser-Delegated Inference

Both the memory and ensemble pipelines support a WebSocket-backed delegation mode. When the user's local model is accessible from the browser but not from the server process, the browser opens the relevant WebSocket and handles embedding and inference calls on behalf of the server.

The server sends pending requests over the socket; the browser calls its local model and returns results. This keeps all model traffic client-side without changing the server-side orchestration logic.

## Multi-Tenant Mode

When multi-tenant mode is enabled, the server assigns each visitor a persistent anonymous user ID cookie. Memory files (vector store, personality, working notes, system summary) are then partitioned under:

```
~/.promptlibretto/memory_stores/{user_id}/
```

Single-user deployments (the default) share a common store path.

## Environment

| Variable | Default | Effect |
| --- | --- | --- |
| `PROMPT_ENGINE_MOCK` | `0` | Use `MockProvider` for server-side generation. |
| `OLLAMA_URL` | `http://localhost:11434` | Base URL for server-side `OllamaProvider`. |
| `OLLAMA_CHAT_PATH` | `/api/chat` | Chat endpoint path. `/v1/` paths use OpenAI-compatible payloads. |
| `HOST` | `127.0.0.1` | Studio bind host. |
| `PORT` | `8000` | Studio bind port. |

## Docker

```bash
docker compose up -d
```

The container exposes the studio on port 8000. Browser state remains in the user's browser storage.
