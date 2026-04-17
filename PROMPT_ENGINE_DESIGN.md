# Generic Modular Prompt Engine Design

This document describes a reusable architecture for building prompts from modular state, templates, rules, examples, and runtime overlays. It intentionally avoids tying the design to any specific product domain, UI, model provider, or output type.

The core idea is to treat prompt generation as a deterministic pipeline with controlled stochastic choices. The library should separate what is known, what is temporarily true, how prompts are assembled, how model parameters are chosen, and how outputs are cleaned or rejected.

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

The engine can be thought of as six layers:

1. Configuration
2. Context State
3. Prompt Assets
4. Prompt Builders
5. Generation Runtime
6. Output Processing

Each layer has a different responsibility. The library becomes powerful because these concerns stay separate but interoperable.

## 1. Configuration

Configuration defines the stable operating boundaries for generation.

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

Configuration should be declarative and injectable. A prompt builder should not need to know where a model is hosted or how HTTP calls are made.

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

Context state represents the facts and transient conditions that influence prompt construction.

The design separates context into durable base state and temporary overlays.

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
  renderTemplate(template: string, values: Record<string, unknown>): string;
  getActive(now?: number): string;
  setOverlay(name: string, overlay: ContextOverlay): void;
  clearOverlay(name: string): void;
  getState(): ContextSnapshot;
}

type ContextOverlay = {
  text: string;
  priority: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};
```

## Iteration Turn Overlays

Iteration loops (user responds to an output, the app regenerates) are
modelled as overlays rather than a separate chat-history primitive. A
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
the verbatim. Compaction is produced by a named route (e.g.
`compact_turn`) using the same engine surface — no special code path.
Preserving the verbatim in metadata means the caller can:

- Revert to verbatim (swap `text` ↔ `metadata.verbatim`)
- Re-compact (re-run the compaction route against `metadata.verbatim`)
- Audit what the user actually said versus what was shown to the model

A small helper (`make_turn_overlay(verbatim, compacted=None, priority=25)`)
is the recommended constructor so the `kind: "turn"` contract is uniform.
Orchestration (when to compact, what params to use) stays in the caller —
the library only provides the data primitive and the route.

## Template Slots

Templates should allow explicit slots such as:

```txt
The task concerns {subject}.{focus_sentence}{constraint_sentence}
```

The important pattern is not the exact placeholders, but the slot contract:

- Slots are named.
- Slot values come from structured state.
- Rendering is deterministic.
- Missing fields do not silently erase important context.
- The renderer can append missing details if a template lacks newer slots.

This last point is key. A long-lived user-authored template may predate newer context fields. The renderer should be able to detect that a field was not represented and append it safely.

Example:

```ts
type TemplateRenderOptions = {
  appendMissingFields?: boolean;
  normalizeWhitespace?: boolean;
};

type TemplateField = {
  key: string;
  value: string;
  aliases?: string[];
  fallbackSentence?: (value: string) => string;
};
```

## Template Inference

The system can infer a reusable template from a rendered prompt by replacing known current values with slots.

This is useful when a user edits the rendered text directly. Instead of treating the edited prompt as static forever, the engine can recover slots for future updates.

Example process:

1. Start with rendered text.
2. Compare against known current field values.
3. Replace exact matches with slot tokens.
4. Store the inferred template.

This should be conservative. Only replace values that are known and unambiguous.

## 3. Prompt Assets

Prompt assets are domain-editable text blocks and option pools used by builders.

They should live outside the runtime service layer.

Asset categories:

- Framing lines
- Shared rules
- Specialized instructions
- Example pools
- Persona or style descriptors
- Nudge pools
- Prompt endings
- Injection templates
- Fallback prompts

The design principle is: prompt text belongs in prompt modules, not in orchestration code.

Suggested structure:

```ts
type PromptAssets = {
  frames: Record<string, string>;
  rules: Record<string, string>;
  examples: Record<string, string[]>;
  nudges: Record<string, string[]>;
  injectors: Record<string, InjectionTemplate>;
};
```

## 4. Prompt Builders

Prompt builders convert active context plus request state into model-ready messages.

A builder should be thin:

- Pick from configured asset pools.
- Format slots.
- Join sections.
- Return a prompt package.

It should not:

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

Route selection should be explicit and inspectable. If two prompt contexts are active, the engine should have a clear precedence rule rather than relying on incidental `if` order.

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

An injection is a small optional prompt module that augments a base prompt.

Examples in generic terms:

- A time-limited event occurred.
- A choice or result is active.
- An external signal changed sentiment.
- A relevant profile fact may be included.
- A tool result should be referenced.

Injection modules should return both instruction text and optional examples.

```ts
type PromptInjection = {
  instructions: string;
  examples?: string[];
  generationOverrides?: Partial<GenerationConfig>;
  outputPolicy?: Partial<OutputPolicy>;
};
```

Injections can be probabilistic, but the probabilities should be part of the module configuration so behavior is testable.

## Controlled Randomness

Randomness is useful for variety, but it should be deliberate.

Use controlled randomness for:

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

The engine should accept a random source so tests can seed it.

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

Provider-specific details should be isolated.

The engine should use a normalized generation request:

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

This allows the library to support local models, hosted APIs, and mock providers without changing prompt logic.

## Debug Parameter Locking

Normal usage may jitter parameters for natural variety. Debug mode often needs exact repeatability.

The runtime should support a lock mode:

- No temperature jitter.
- No token budget jitter.
- Seeded random source if available.
- Capture exact system prompt.
- Capture exact user prompt.
- Capture chosen route and injections.

This makes single-step testing representative of normal structure while still inspectable.

## 6. Output Processing

Output processing should be code-driven, not left entirely to the model.

Common steps:

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

## Recent Output Memory

A small recent-output memory helps reduce repetition.

It can compare:

- Exact normalized text
- Token overlap
- Phrase overlap
- Shared special tokens
- Similarity score

This memory should be bounded and context-aware. Clearing it on major context changes is often useful, while preserving it across minor overlays can avoid loops.

## Run History

Distinct from recent-output memory. Recent-output memory exists to detect
repetition (Jaccard over text). Run history exists to let UIs and callers
*replay* past runs — reloading the exact request shape that produced a
given output.

Each record captures:

- The `GenerationRequest` as sent (mode, inputs, injections, config overrides)
- The cleaned output text
- Whether it was accepted
- The route that handled it
- A timestamp
- Optional metadata

Keep it bounded and keep it separate. Two primitives each doing one thing
beats a single struct with a growing optional-field bag. A caller wanting
chat-style history can read run history; a caller only wanting dedup
continues to use recent-output memory; neither depends on the other.

## Programmatic Additions

Some output features are better handled after generation.

Examples:

- Appending structured tokens
- Expanding one generated marker into repeated markers
- Selecting one item from a manifest
- Enforcing allowed asset names
- Removing unsupported model-invented tokens

The pattern is:

1. Let the model decide natural language content.
2. Let code enforce structured affordances.
3. Keep generated text and programmatic additions separately inspectable when possible.

## Metrics and Inspection

Every generation should be able to return a debug envelope:

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

This trace is what makes a one-step debug UI useful. The step should use the same context resolution, route selection, prompt builders, model parameters, and post-processing as normal generation. The only difference is that the scheduler is paused and the output is not automatically emitted downstream.

## Scheduler Versus Stepper

Separate generation from scheduling.

The scheduler decides when to call the engine repeatedly.
The stepper calls the same engine once.

Both should use the same path:

```txt
generateOnce(request) -> GenerationResult
```

Then:

- Scheduler loops over `generateOnce`.
- Debug stepper invokes `generateOnce` manually.
- Tests invoke `generateOnce` with seeded state.

This prevents debug behavior from drifting away from production behavior.

## Suggested Library Modules

```txt
prompt-engine/
  config/
    generationConfig.ts
  context/
    ContextStore.ts
    TemplateRenderer.ts
    OverlayStore.ts
  assets/
    PromptAssetRegistry.ts
  routing/
    PromptRouter.ts
    PromptRoute.ts
  builders/
    PromptBuilder.ts
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
    RecentOutputMemory.ts
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

