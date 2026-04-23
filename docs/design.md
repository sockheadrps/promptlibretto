# Design

A reusable architecture for building prompts from modular state, templates, rules, examples, and runtime overlays. Domain, UI, model provider, and output type are left to the caller.

Prompt generation is a deterministic pipeline with controlled stochastic choices. The library separates what is known, what is temporarily true, how prompts are assembled, how model parameters are chosen, and how outputs are cleaned or rejected.

## Goals

- Build prompts from composable parts instead of one large hardcoded string.
- Keep domain text editable without burying it in service logic.
- Support reusable context templates with slots.
- Allow temporary runtime facts to override or augment base context.
- Route requests to specialized prompt builders based on active state.
- Preserve variety through controlled random choices.
- Capture prompt text, model parameters, token usage, latency, and output for debugging.
- Keep provider-specific API calls behind an adapter.
- Validate and normalize model output after generation.

## Non-Goals

- The engine should not know the application domain.
- The engine should not require a specific model provider.
- The engine should not assume the output is conversational.
- The engine should not force all use cases into a single prompt format.

## Conceptual Model

Six layers:

1. Configuration
2. Context State
3. Prompt Assets
4. Prompt Builders
5. Generation Runtime
6. Output Processing

## 1. Configuration

Stable operating boundaries for generation.

Examples:

- Provider endpoint
- Model name
- Temperature
- Sampling parameters
- Max generated tokens
- Retry count
- Timeout
- Output length limits
- Cache sizes
- Debug parameter locking

Configuration is declarative and injectable. A prompt builder doesn't need to know where a model is hosted or how HTTP calls are made.

Suggested shape:

```ts
type GenerationConfig = {
  provider: string;
  model: string;
  temperature: number;
  topP?: number;
  topK?: number;
  maxTokens: number;
  repeatPenalty?: number;
  timeoutMs: number;
  retries: number;
  lockParams?: boolean;
};
```

## 2. Context State

Facts and transient conditions that influence prompt construction. Split into durable base state and temporary overlays.

Base state:

- Long-lived facts
- User-authored base prompt
- Template slots
- Persisted settings
- Profile or entity metadata

Overlay state:

- Temporary event context
- Short-lived reaction or emphasis
- Mode-specific overrides
- Expiring instructions
- Recently observed input

The effective context is produced by resolving these layers in order:

1. Load or construct base context.
2. Apply mode-specific base substitutions.
3. Expire stale overlays.
4. Append or replace with active overlays.
5. Return the final active context for routing.

Suggested interface:

```ts
interface ContextStore {
  getBase(): string;
  setBase(value: string): void;
  setOverlay(name: string, overlay: ContextOverlay): void;
  clearOverlay(name: string): void;
  getState(now?: number): ContextSnapshot;  // pure read, does not mutate
  prune(now?: number): string[];              // evicts expired overlays, returns names
}

type ContextOverlay = {
  text: string;
  priority: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};
```

## Iteration Turn Overlays

Iteration loops are overlays, not a separate chat-history primitive. A
**turn overlay** is an ordinary overlay whose metadata carries the user's
verbatim follow-up plus an optional compacted form:

```
metadata: {
  kind: "turn",
  verbatim: "actually please make it shorter",
  compacted: "Prefer concise output."   // optional
}
```

The overlay's active `text` is the compacted form when present, otherwise
the verbatim. Compaction runs through a named route (e.g. `compact_turn`)
on the same engine surface — no special code path. Preserving the verbatim
in metadata lets the caller:

- Revert to verbatim (swap `text` ↔ `metadata.verbatim`)
- Re-compact (re-run the compaction route against `metadata.verbatim`)
- Audit what the user actually said versus what was shown to the model

`make_turn_overlay(verbatim, compacted=None, priority=25)` is the
recommended constructor so the `kind: "turn"` contract is uniform.
Orchestration (when to compact, what params to use) stays in the caller.

## Template Slots

Templates allow explicit slots such as:

```txt
The task concerns {subject}.
```

Slot substitution happens at exactly one place: the section callable.
Sections receive a `BuildContext` and call `str.format_map` against
`request.inputs` to fill slots. Exported engines store templated sections
as `{"template": "Q:\n{input}"}` — the loader compiles them back to
section callables that do the `format_map` at build time.

There is no separate template-renderer object, no field aliasing
machinery, no whitespace normaliser. If you want any of that, it's a
helper function in your own section callable. Keep the substitution
surface small and obvious.

## 3. Prompt Assets

Domain-editable text blocks and option pools used by builders. They live outside the runtime service layer.

`PromptAssetRegistry` exposes three primitives:

- `assets: Record<string, string>` — single named strings (anything: framings, rules, personas, endings, fallback prompts).
- `pools: Record<string, string[]>` — sampleable lists (examples, nudges).
- `injectors: Record<string, InjectionTemplate>` — stackable instruction blocks with optional generation/output overrides.

Categories like `frame.*`, `rule.*`, `persona.*` are naming conventions
you choose, not enforced types. The earlier 7-pool taxonomy
(`frames`/`rules`/`personas`/`endings`/`examples`/`nudges`/`injectors`)
collapsed to one flat dict because nothing structural distinguished a
"frame" string from a "rule" string.

Prompt text belongs in prompt modules, not in orchestration code.

```ts
type PromptAssets = {
  assets: Record<string, string>;
  pools: Record<string, string[]>;
  injectors: Record<string, InjectionTemplate>;
};
```

## 4. Prompt Builders

Builders convert active context plus request state into model-ready messages. A builder is thin:

- Pick from configured asset pools.
- Format slots.
- Join sections.
- Return a prompt package.

It does not:

- Call the model.
- Mutate long-lived state.
- Perform HTTP requests.
- Know provider-specific payload details.

Suggested output:

```ts
type PromptPackage = {
  route: string;
  system?: string;
  user: string;
  metadata?: Record<string, unknown>;
  generationOverrides?: Partial<GenerationConfig>;
};
```

## Prompt Routing

Before building a prompt, the engine chooses a route.

Routing can use:

- Active overlays
- Request type
- Priority
- Random chance
- Explicit caller mode
- Feature flags
- Current context markers

Route selection is explicit and inspectable. When two prompt contexts are active, precedence is a clear rule rather than incidental `if` order.

Example:

```ts
type PromptRoute = {
  name: string;
  priority: number;
  applies: (state: ContextSnapshot, request: GenerationRequest) => boolean;
  build: PromptBuilder;
};
```

## Prompt Injections

A small optional prompt module that augments a base prompt.

Examples:

- A time-limited event occurred.
- A choice or result is active.
- An external signal changed sentiment.
- A relevant profile fact may be included.
- A tool result should be referenced.

Injection modules return instruction text and optional examples.

```ts
type PromptInjection = {
  instructions: string;
  examples?: string[];
  generationOverrides?: Partial<GenerationConfig>;
  outputPolicy?: Partial<OutputPolicy>;
};
```

Injections can be probabilistic, but probabilities belong in the module configuration so behavior is testable.

## Controlled Randomness

Randomness is useful for variety when scoped.

Use it for:

- Picking examples
- Picking style/persona fragments
- Picking prompt endings
- Occasionally selecting alternate prompt routes
- Slightly varying temperature or token budget

Avoid randomness for:

- Core facts
- Safety constraints
- Required output schema
- Provider selection
- Persistence behavior

The engine accepts a random source so tests can seed it.

```ts
interface RandomSource {
  float(): number;
  choice<T>(items: T[]): T;
  sample<T>(items: T[], count: number): T[];
  weighted<T>(items: Array<{ value: T; weight: number }>): T;
}
```

## 5. Generation Runtime

The runtime owns the generation lifecycle.

Responsibilities:

- Resolve active context.
- Select route.
- Build prompt package.
- Apply config and builder overrides.
- Call provider adapter.
- Record prompt and metrics.
- Retry if output fails validation.
- Return normalized result and diagnostics.

Suggested pipeline:

```txt
request
  -> context_store.getActive()
  -> router.select()
  -> builder.build()
  -> config_resolver.merge()
  -> provider.generate()
  -> output_processor.clean()
  -> validator.accept_or_retry()
  -> result
```

## Provider Adapter

Provider-specific details stay behind an adapter. The engine uses a normalized generation request:

```ts
type ProviderRequest = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  stream?: boolean;
};
```

And a normalized response:

```ts
type ProviderResponse = {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  timing?: {
    totalMs?: number;
    loadMs?: number;
    promptEvalMs?: number;
    evalMs?: number;
  };
  raw?: unknown;
};
```

Local models, hosted APIs, and mock providers all fit without changing prompt logic.

## Debug Parameter Locking

Normal usage may jitter parameters for natural variety. Debug mode needs exact repeatability. Lock mode:

- No temperature jitter.
- No token budget jitter.
- Seeded random source if available.
- Capture exact system prompt.
- Capture exact user prompt.
- Capture chosen route and injections.

Single-step testing matches normal structure while staying inspectable.

## 6. Output Processing

Code-driven, not left entirely to the model. Common steps:

- Trim whitespace.
- Remove labels or prefixes.
- Strip forbidden symbols.
- Remove echoed input.
- Enforce max length.
- Validate required schema.
- Deduplicate against recent outputs.
- Append deterministic tokens or markup.
- Reject and retry if invalid.

Prompt rules guide the model. Output processors enforce the contract.

Suggested interface:

```ts
type OutputProcessor = {
  clean(text: string, ctx: ProcessingContext): string;
  validate(text: string, ctx: ProcessingContext): ValidationResult;
};

type ValidationResult = {
  ok: boolean;
  reason?: string;
};
```

## Streaming

Some providers can emit tokens incrementally. The engine exposes this via
`generate_stream(request)`, an async iterator of chunks:

- Intermediate chunks carry a `delta` string.
- The terminal chunk has `done=True` and a fully populated `GenerationResult`
  so downstream callers pick up `accepted`, `route`, and an optional trace
  without a second round.

Providers declare support by implementing `stream()` alongside `generate()`.
A helper `supports_streaming(provider)` lets the engine refuse the request
cleanly when the adapter is non-streaming.

Streaming runs the output processor exactly once on the aggregated buffer.
Retries are skipped because replaying a stream mid-output is more
surprising than useful — callers that need retry semantics fall back to
`generate_once` when the terminal result is rejected. Both paths share a
single pipeline: one buffer is cleaned, validated, recorded to run history,
and passed through middleware.

## Middleware

Logging, metrics, caching, rate-limiting, and redaction don't belong inside
builders or providers. The engine exposes a middleware hook around the
generation path:

```
Middleware:
  before(request) -> request | None
  after(request, result) -> result | None
```

Either method may be sync or async. Returning `None` means pass-through.
Middleware runs in registration order on the way in and reverse order on
the way out, so outer wraps inner. Both `generate_once` and
`generate_stream` use the same hooks.

Middleware does NOT intercept provider calls, add retry semantics, or
mutate prompt construction — those concerns live in the builder, output
processor, and route config. Keeping middleware narrow preserves the
invariant that all generation goes through one code path: schedulers,
stepper debuggers, and middleware all see the same `GenerationResult`.

## Prompt-Size Budget

Accumulating overlays (iteration turns, user preferences, transient facts)
can grow the built prompt past what the model or the surrounding app
tolerates. `GenerationConfig` supports an optional `max_prompt_chars`
budget (or per-route via `generation_overrides`). When set, the engine:

1. Builds the prompt package normally.
2. If `len(system) + len(user)` exceeds the budget, drops the
   lowest-priority overlay from the snapshot and rebuilds.
3. Repeats until the prompt fits or no overlays remain.

Priority doubles as importance: higher applies first and drops last. Ties
break on overlay name for determinism.

Character count, not token count — provider-agnostic, no tokenizer
dependency. Conservative relative to token budgets (tokens are usually 3–4
chars each).

The debug trace reports budget state under `metadata.budget`:
`{budget_chars, final_chars, dropped, over_budget}`. If the prompt is
still over budget after exhausting overlays, `over_budget=True` flags it
rather than erroring — the engine never drops user-authored base context.

## Programmatic Additions

Some output features are better handled after generation:

- Appending structured tokens
- Expanding one generated marker into repeated markers
- Selecting one item from a manifest
- Enforcing allowed asset names
- Removing unsupported model-invented tokens

The pattern:

1. Let the model decide natural language content.
2. Let code enforce structured affordances.
3. Keep generated text and programmatic additions separately inspectable.

## Metrics and Inspection

Every generation can return a debug envelope:

```ts
type GenerationTrace = {
  route: string;
  activeContext: string;
  systemPrompt?: string;
  userPrompt: string;
  injections: string[];
  config: GenerationConfig;
  outputRaw: string;
  outputFinal: string;
  attempts: Array<{
    raw: string;
    cleaned: string;
    accepted: boolean;
    rejectReason?: string;
  }>;
  usage?: ProviderResponse["usage"];
  timing?: ProviderResponse["timing"];
};
```

A one-step debug UI uses the same context resolution, route selection, builders, model parameters, and post-processing as normal generation. The scheduler is paused and the output isn't emitted downstream; everything else is identical.

## Scheduler Versus Stepper

Generation is separate from scheduling.

The scheduler decides when to call the engine repeatedly.
The stepper calls the same engine once.

Both use the same path:

```txt
generateOnce(request) -> GenerationResult
```

Then:

- Scheduler loops over `generateOnce`.
- Debug stepper invokes `generateOnce` manually.
- Tests invoke `generateOnce` with seeded state.

Debug behavior stays aligned with production.

## Suggested Library Modules

```txt
prompt-engine/
  config/
    generationConfig.ts
  context/
    ContextStore.ts
    OverlayStore.ts
  assets/
    PromptAssetRegistry.ts
  routing/
    PromptRouter.ts
    PromptRoute.ts
  builders/
    CompositeBuilder.ts
  runtime/
    PromptEngine.ts
    GenerationTrace.ts
  providers/
    ProviderAdapter.ts
    LocalProviderAdapter.ts
    MockProviderAdapter.ts
  output/
    OutputProcessor.ts
  random/
    RandomSource.ts
```

## Minimal Public API

```ts
const engine = new PromptEngine({
  config,
  contextStore,
  assetRegistry,
  router,
  provider,
  outputProcessor,
  random,
});

const result = await engine.generateOnce({
  mode: "default",
  inputs: { subject: "..." },
  debug: true,
});
```

Result:

```ts
type GenerationResult = {
  text: string;
  accepted: boolean;
  trace?: GenerationTrace;
};
```

## Design Principles

- Treat context as structured state before it becomes prose.
- Treat prompt text as assets, not service code.
- Use builders as small composition functions.
- Use routing to make prompt mode selection explicit.
- Use overlays for temporary truth.
- Use code to enforce hard output constraints.
- Use probabilistic modules for variety, but make them testable.
- Keep provider APIs behind adapters.
- Make every generation inspectable.
- Ensure manual debug stepping and automated scheduling call the same generation path.

