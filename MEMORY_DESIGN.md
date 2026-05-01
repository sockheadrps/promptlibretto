# promptlibretto — memory layer design

## Goal

Add a local-first, persistent memory system to the library that:

- Retrieves semantically relevant past context before each generation
- Routes that context into the right registry slots (injections, persona, sentiment)
- Maintains an evolving personality layer that grows over time
- Ships as an optional library extension, not a web-only feature
- Reflects in the Builder and Studio but is not owned by them

---

## Guiding principles

- The registry stays static. `MemoryEngine` produces a mutated `HydrateState` and hands it to the existing `Engine`. No changes to the core hydration pipeline.
- Everything runs locally. Embeddings come from Ollama (`/api/embed`). The vector store is a single SQLite file via `sqlite-vec`. No cloud, no server, no docker.
- The library owns the logic. The web app reflects it. If memory works from the CLI, it works in the studio automatically.

---

## Stack

| Concern | Choice | Why |
|---|---|---|
| Embeddings | Ollama `/api/embed` | Already connected, no new infra, models like `nomic-embed-text` run locally |
| Vector store | `sqlite-vec` | Single `.db` file, zero config, `pip install sqlite-vec` |
| Tag extraction | Small classifier LLM call | Smarter than hard-coded rules, uses existing Ollama connection |
| Personality store | JSON file on disk | Human-readable, easy to edit, version-controllable |

Install:

```bash
pip install "promptlibretto[memory]"   # adds sqlite-vec
ollama pull nomic-embed-text           # or mxbai-embed-large
```

---

## Architecture

```
user input
    │
    ▼
┌─────────────────────────────────────────┐
│              MemoryEngine               │
│                                         │
│  1. embed(input) → vector               │
│  2. store.retrieve(vector, top_k=5)     │  ← MemoryStore (sqlite-vec)
│  3. classifier_call(input, chunks)      │  ← OllamaProvider (small model)
│     → tags: ["past_conflict", ...]      │
│  4. router.mutate(base_state, tags)     │  ← Router (registry rules)
│     → adjusted HydrateState            │
│  5. personality.merge(state)            │  ← PersonalityLayer (JSON file)
│  6. engine.hydrate(state)              │  ← existing Engine (unchanged)
│  7. provider.generate(prompt)          │
│  8. store.upsert(input, response)       │  ← write turn back to memory
│  9. personality.amend(turn)            │  ← optional post-session update
│                                         │
└─────────────────────────────────────────┘
    │
    ▼
GenerationResult (same shape as today)
```

---

## Module layout

```
promptlibretto/
  memory/
    __init__.py          # exports MemoryEngine, MemoryStore, PersonalityLayer
    embedder.py          # OllamaEmbedder — POST /api/embed → float[]
    store.py             # MemoryStore — sqlite-vec: upsert, retrieve, forget
    personality.py       # PersonalityLayer — load / amend / save base context JSON
    classifier.py        # tag extraction via small LLM call
    router.py            # tag → HydrateState mutations
    engine.py            # MemoryEngine — orchestrates all of the above
```

---

## Component specs

### `OllamaEmbedder`

```python
class OllamaEmbedder:
    def __init__(self, base_url: str, model: str = "nomic-embed-text", client=None)

    async def embed(self, text: str) -> list[float]
    async def embed_batch(self, texts: list[str]) -> list[list[float]]
```

Hits `POST /api/embed` on the existing Ollama instance. Returns raw float vectors.
No new connection config needed — reuses the same base URL as `OllamaProvider`.

---

### `MemoryStore`

```python
class MemoryStore:
    def __init__(self, db_path: str, embedder: OllamaEmbedder, dimensions: int = 768)

    async def upsert(self, turn: MemoryTurn) -> None
    async def retrieve(self, query: str, top_k: int = 5) -> list[MemoryChunk]
    async def forget(self, turn_id: str) -> None
    def close(self) -> None
```

**`MemoryTurn`** — what gets written after each exchange:

```python
@dataclass
class MemoryTurn:
    id: str                      # uuid
    session_id: str
    role: str                    # "user" | "assistant"
    text: str
    tags: list[str]              # extracted by classifier
    timestamp: str               # ISO
    metadata: dict               # arbitrary — persona used, sentiment, slider value, etc.
```

**`MemoryChunk`** — what comes back from retrieval:

```python
@dataclass
class MemoryChunk:
    turn: MemoryTurn
    score: float                 # cosine similarity
```

**Schema (sqlite-vec):**

```sql
CREATE TABLE memory_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    text TEXT,
    tags TEXT,          -- JSON array
    timestamp TEXT,
    metadata TEXT       -- JSON object
);

CREATE VIRTUAL TABLE memory_vss USING vec0(
    turn_id TEXT,
    embedding FLOAT[768]
);
```

Retrieve = embed query → `vec0` cosine search → join back to `memory_turns`.

---

### `Classifier`

A single LLM call that reads the retrieved chunks and the current input, then
returns a list of tags. Tags are defined in the registry's memory rules — the
classifier only returns tags it recognises from that vocabulary.

```python
class Classifier:
    def __init__(self, provider: ProviderAdapter, model: str)

    async def extract_tags(
        self,
        user_input: str,
        chunks: list[MemoryChunk],
        known_tags: list[str],         # vocabulary from registry memory rules
    ) -> list[str]
```

Prompt shape (not user-visible, generated internally):

```
You are a context classifier. Given the user's message and relevant past
exchanges, return only the tags from this list that apply:
{known_tags}

User message: {input}

Relevant past exchanges:
{chunks}

Reply with a JSON array of matching tags only. No explanation.
```

Uses a small, fast model (e.g. `llama3.2:1b` or `phi3:mini`). The response is
parsed as JSON; anything that fails to parse returns `[]` gracefully.

---

### `Router`

Maps extracted tags to `HydrateState` mutations. Rules are defined in the
registry under a new top-level key `memory_rules`.

```python
class Router:
    def __init__(self, rules: list[MemoryRule])

    def mutate(self, base_state: HydrateState, tags: list[str]) -> HydrateState
```

**`MemoryRule`** (stored in registry JSON):

```json
{
  "tag": "past_conflict",
  "actions": [
    { "type": "inject",   "section": "runtime_injections", "item": "conflict_context" },
    { "type": "sentiment","value": "tense" }
  ]
}
```

Supported action types:

| type | effect |
|---|---|
| `inject` | adds a named `runtime_injections` or `static_injections` item to the active set |
| `persona` | overrides the persona selection |
| `sentiment` | overrides the sentiment selection |
| `template_var` | sets a template variable value |

Rules are evaluated in order. Later rules can override earlier ones.
Conflicts (two rules setting the same field) are resolved last-wins.

---

### `PersonalityLayer`

A mutable base context that lives in a separate JSON file alongside the registry.
Starts from a seed, accumulates amendments over time.

```python
class PersonalityLayer:
    def __init__(self, path: str)

    def load(self) -> PersonalityProfile
    def merge_into_state(self, state: HydrateState) -> HydrateState
    async def amend(self, session_turns: list[MemoryTurn], provider: ProviderAdapter) -> None
    def save(self) -> None
```

**`PersonalityProfile`** (the JSON file):

```json
{
  "version": 1,
  "seed": "Base personality description set at creation.",
  "amendments": [
    {
      "timestamp": "2026-04-29T...",
      "text": "Tends to deflect when asked about past failures.",
      "source_session": "abc123"
    }
  ],
  "assembled": "Base personality description... Tends to deflect..."
}
```

`assembled` is pre-built by concatenating seed + amendments. `merge_into_state`
injects it as a `template_var` that maps to a `{personality_context}` placeholder
in the registry's `base_context`.

**Amendment flow** (runs post-session, optional):

After a session ends, `amend()` sends the last N turns to the LLM with a prompt
like:

```
Given this conversation, what did you learn about this character's personality,
preferences, or tendencies that isn't already captured in the current profile?
Reply with a single concise observation, or "nothing new" if there's nothing to add.

Current profile: {assembled}
Conversation: {turns}
```

If the response isn't "nothing new", it's appended as a new amendment entry.

---

### `MemoryEngine`

The top-level orchestrator. Wraps `Engine` and is the only public API most users
need to touch.

```python
class MemoryEngine:
    def __init__(
        self,
        engine: Engine,
        store: MemoryStore,
        embedder: OllamaEmbedder,
        classifier: Classifier,
        router: Router,
        personality: PersonalityLayer | None = None,
        session_id: str | None = None,          # auto-generated if omitted
        top_k: int = 5,
        classifier_model: str = "llama3.2:1b",
    )

    async def run(
        self,
        user_input: str,
        base_state: HydrateState | dict | None = None,
    ) -> MemoryGenerationResult

    async def end_session(self) -> None    # triggers personality amendment if configured
```

**`MemoryGenerationResult`** extends `GenerationResult`:

```python
@dataclass
class MemoryGenerationResult(GenerationResult):
    retrieved_chunks: list[MemoryChunk]
    extracted_tags: list[str]
    applied_rules: list[str]
    final_state: HydrateState
```

---

## Registry schema additions

Two new optional top-level keys:

```jsonc
{
  "registry": {
    // ... existing fields ...

    "memory_rules": [
      {
        "tag": "past_conflict",
        "actions": [
          { "type": "inject",    "section": "runtime_injections", "item": "conflict_note" },
          { "type": "sentiment", "value": "tense" }
        ]
      },
      {
        "tag": "shared_joke",
        "actions": [
          { "type": "persona",   "value": "casual" },
          { "type": "inject",    "section": "static_injections",  "item": "rapport_note" }
        ]
      }
    ],

    "memory_config": {
      "classifier_model": "llama3.2:1b",
      "top_k": 5,
      "personality_file": "personality.json"   // relative to registry file
    }
  }
}
```

Injection items that are memory-activated get a `"memory_tag"` field so the
router knows which item maps to which tag:

```jsonc
"runtime_injections": {
  "items": [
    {
      "id": "conflict_note",
      "text": "There is unresolved tension from a previous exchange.",
      "memory_tag": "past_conflict"
    }
  ]
}
```

---

## Builder UI additions

### Memory Rules panel (new section)

- A collapsible **Memory Rules** section at the bottom of the Builder
- Each rule: tag name (text input) + a list of actions (type + target)
- Actions built with dropdowns populated from the current registry's sections/items
- Known tags list auto-populated from all rules (used as classifier vocabulary)

### Memory Config panel (in Generation/Policy tab)

- Classifier model input (defaults to `llama3.2:1b`)
- Top-k slider (1–10)
- Personality file path input

### Per-item `memory_tag` field

- `runtime_injections` and `static_injections` item forms get an optional
  **Memory tag** input — the tag that activates this item

### Studio

- No changes needed to the Studio compose/tuning flow
- A future "Memory Inspector" panel could show retrieved chunks and applied rules
  from the last generation (debug trace extension)

---

## Usage example

```python
from promptlibretto import load_registry, OllamaProvider
from promptlibretto.memory import MemoryEngine, MemoryStore, OllamaEmbedder, Classifier, Router

provider  = OllamaProvider("http://localhost:11434")
embedder  = OllamaEmbedder("http://localhost:11434", model="nomic-embed-text")
engine    = load_registry("my_character.json", provider=provider)
store     = MemoryStore("memory.db", embedder=embedder)
classifier = Classifier(provider, model="llama3.2:1b")
router    = Router(rules=engine.registry.memory_rules)

mem_engine = MemoryEngine(
    engine=engine,
    store=store,
    embedder=embedder,
    classifier=classifier,
    router=router,
)

result = await mem_engine.run("Hey, remember last time when you said...")
print(result.text)
print(result.extracted_tags)   # ["past_conflict", "recall"]
print(result.applied_rules)    # ["past_conflict → inject:conflict_note, sentiment:tense"]

await mem_engine.end_session()  # runs personality amendment
```

---

## Implementation order

1. `OllamaEmbedder` — hits `/api/embed`, returns vectors. No new deps.
2. `MemoryStore` — sqlite-vec schema, upsert, retrieve. Adds `sqlite-vec` dep.
3. `Classifier` — single LLM call, JSON parse, graceful fallback.
4. `Router` — pure Python, no I/O. Reads `memory_rules` from registry.
5. `MemoryEngine` — wires 1–4 together around existing `Engine`.
6. `PersonalityLayer` — load/save JSON, post-session amendment call.
7. Registry schema — add `memory_rules`, `memory_config`, `memory_tag` fields.
8. Builder UI — Memory Rules panel, memory_tag inputs, Memory Config tab.

Steps 1–6 are pure library. Step 7 is a schema change. Step 8 is UI only.
The library is fully usable from code before step 8 is done.

---

## Decisions

- **Forgetting policy** — sliding window by count. Keep the last N turns
  (default 200, configurable in `memory_config`). Individual turns can be
  flagged `important: true` to exempt them from the window permanently.
  Pruning is explicit via `store.prune()` — nothing is deleted mid-session
  automatically. No TTL; calendar time is irrelevant for conversational context.

- **Multi-character memory** — one store per registry. The `.db` file lives
  alongside the registry JSON (or at a path set in `memory_config`). No
  shared stores across registries.

- **Ensemble memory** — each participant gets their own `MemoryEngine` and
  their own store. They don't share memory. Cleaner isolation; avoids one
  participant's history bleeding into the other's routing decisions.

- **Embedding dimensions** — `nomic-embed-text` (768-dim) is the default.
  Dimension is fixed at store creation time. Attempting to upsert a vector
  with the wrong dimension raises a clear error rather than silently corrupting
  the index.
