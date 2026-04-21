// promptlibretto studio — talks to the FastAPI server.
const $ = (id) => document.getElementById(id);

// --- minimal, safe markdown renderer -------------------------------
// Escapes HTML first, then converts a small subset of CommonMark.
// Supports: headers (h1-h6), bold, italic, inline code, fenced code,
// unordered + ordered lists (one level), links, paragraphs, line breaks.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderMarkdown(text) {
  if (!text) return "";
  // Hold fenced code blocks aside so their content is not transformed.
  const codeBlocks = [];
  let s = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.push({ lang, code }) - 1;
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  s = escapeHtml(s);

  // Headers (process longest match first)
  s = s.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  s = s.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  s = s.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  s = s.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Inline emphasis. Bold first (longer delimiter) then italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Links [label](url) — only allow http(s) / mailto for safety.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Lists. Group consecutive lines starting with bullets / numbers.
  s = s.replace(/(?:^[ \t]*[\*\-+]\s+.+(?:\n|$))+/gm, (block) => {
    const items = block.trim().split("\n").map((line) =>
      "<li>" + line.replace(/^[ \t]*[\*\-+]\s+/, "") + "</li>"
    ).join("");
    return `<ul>${items}</ul>`;
  });
  s = s.replace(/(?:^[ \t]*\d+\.\s+.+(?:\n|$))+/gm, (block) => {
    const items = block.trim().split("\n").map((line) =>
      "<li>" + line.replace(/^[ \t]*\d+\.\s+/, "") + "</li>"
    ).join("");
    return `<ol>${items}</ol>`;
  });

  // Paragraphs: split on blank lines, leave block-level chunks alone.
  s = s.split(/\n{2,}/).map((para) => {
    const trimmed = para.trim();
    if (!trimmed) return "";
    if (/^<(h[1-6]|ul|ol|pre|blockquote|table)/.test(trimmed)) return trimmed;
    return "<p>" + trimmed.replace(/\n/g, "<br>") + "</p>";
  }).join("\n");

  // Restore fenced code blocks (escape their bodies — they bypass markdown).
  s = s.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    return `<pre class="md-code"${langAttr}><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
  });

  return s;
}

const HELP = {
  compose: {
    title: "Compose Panel",
    body: `<p>This panel turns your intent into a model-ready prompt by combining four things:</p>
      <ul>
        <li><strong>Route</strong> — which prompt strategy to use</li>
        <li><strong>User Input</strong> — the actual request</li>
        <li><strong>Injections</strong> — optional fragments that modify behavior</li>
        <li><strong>Generation Overrides</strong> — per-request sampling parameters</li>
      </ul>
      <p>Hit <code>Generate</code> (or <code>Ctrl/Cmd+Enter</code>) and the engine combines these with your <em>Context State</em> and renders the trace on the right.</p>`,
  },
  route: {
    title: "Route",
    body: `<p>A <strong>route</strong> is a named prompt strategy. Each route has its own system frame, user-section composition, and default sampling.</p>
      <p>Available routes in this demo:</p>
      <ul>
        <li><code>default</code> — neutral, plainspoken assistant</li>
        <li><code>concise</code> — short factual answer with examples</li>
        <li><code>creative</code> — vivid creative composition</li>
        <li><code>analyst</code> — structured analysis with explicit tradeoffs</li>
        <li><code>json_extract</code> — strict JSON-only output for a known schema</li>
      </ul>
      <p>Leave it on <code>(auto-route)</code> to let the router pick based on context overlays + predicates.</p>`,
  },
  input: {
    title: "User Input",
    body: `<p>The freeform request the user is making. Builders treat this as the <code>{input}</code> field — they label it "Request", "Question", "Brief", "Topic", or "Source" depending on the route.</p>
      <p>Tip: <code>Ctrl/Cmd+Enter</code> generates without leaving the textarea.</p>`,
  },
  injections: {
    title: "Injections",
    body: `<p>Injections are reusable prompt fragments that <em>modify</em> the active route. Each one adds instruction text and can override sampling or output policy.</p>
      <ul>
        <li><code>tighten</code> — compress aggressively (lower temperature, fewer tokens)</li>
        <li><code>expand</code> — be expansive with examples (higher temperature)</li>
        <li><code>json_only</code> — force JSON-only output and validate structure</li>
      </ul>
      <p>Multiple injections can stack. Their overrides merge in order.</p>`,
  },
  overrides: {
    title: "Generation Overrides",
    body: `<p>Per-request sampling overrides. Empty fields inherit from the route, then the engine config. The placeholder shows the resolved value that will actually be sent.</p>
      <ul>
        <li><strong>temperature</strong> — scales the softmax distribution before sampling. Low values (0.0–0.3) make the model greedy and near-deterministic; mid values (0.5–0.8) loosen word choice while keeping coherence; high values (1.0+) flatten the distribution so unusual tokens can surface — useful for brainstorming, risky for precise answers.</li>
        <li><strong>top_p</strong> (nucleus) — at each step, keeps the smallest set of candidate tokens whose cumulative probability reaches <code>p</code>, then samples from that set. <code>1.0</code> keeps the whole distribution; <code>0.9</code> clips the long tail to kill obvious nonsense while still allowing variety. Generally prefer tuning this over temperature.</li>
        <li><strong>top_k</strong> — only considers the top <code>k</code> most likely tokens at each step (everything else truncated to zero probability). <code>0</code> or unset means no cap. Smaller <code>k</code> (10–40) is safer but more repetitive; larger <code>k</code> is more diverse.</li>
        <li><strong>max_tokens</strong> — hard cap on output length (in tokens, not characters). The model stops when it hits this or produces a natural end.</li>
        <li><strong>repeat_penalty</strong> — divides the logit of any recently-generated token by this factor, making the model less likely to say the same thing again. <code>1.0</code> is no penalty; <code>1.1–1.2</code> is typical for prose; values above <code>1.3</code> can hurt fluency by forcing awkward synonyms.</li>
        <li><strong>retries</strong> — if output validation (policy, schema, dedupe) fails, how many extra model calls the engine is allowed before giving up.</li>
      </ul>
      <p>These apply to <em>this generation only</em>; the engine config is restored afterward.</p>`,
  },
  debug: {
    title: "Debug Trace",
    body: `<p>When checked, the response includes a full trace: the rendered system + user prompts, active context, attempts, resolved config, token usage, and timing.</p>
      <p>Turn off in production-style runs to skip the extra payload.</p>`,
  },
  state: {
    title: "Context State",
    body: `<p>Two layers of state feed every prompt:</p>
      <ul>
        <li><strong>Base context</strong> — long-lived facts. Persists across generations.</li>
        <li><strong>Overlays</strong> — short-lived facts with names + priority. Highest priority wins, expired overlays are auto-purged.</li>
      </ul>
      <p>Both are concatenated into the active context that builders include in the prompt.</p>`,
  },
  base: {
    title: "Base Context",
    body: `<p>Long-lived framing or facts that should appear in <em>every</em> prompt — for example a persona, a domain constraint, or stable user metadata.</p>
      <ul>
        <li><strong>Save Base</strong> — persist the textarea as the engine's active base (what gets sent with every prompt).</li>
        <li><strong>Save As…</strong> — stash the current text in your personal library under a title, so you can recall it later.</li>
        <li><strong>Load…</strong> — browse the library; load or delete saved entries.</li>
      </ul>
      <p>Templates with <code>{slot}</code> placeholders are also supported via the API.</p>`,
  },
  overlays: {
    title: "Overlays",
    body: `<p>Overlays are <strong>temporary truth</strong>. Use them for transient facts that should ride along with the next few generations:</p>
      <ul>
        <li>A signal you just observed</li>
        <li>A mode-specific override</li>
        <li>An emphasis or reaction</li>
      </ul>
      <p>Each overlay has a <strong>name</strong> (replace by reusing it), a <strong>priority</strong> (higher appears first in active context), and optional expiry. Clear individually with the × or all at once.</p>
      <p>Hit <strong>✨ Suggest</strong> to ask the model for plausible overlays given the current base context. Each suggestion is a fill-in-the-blank: the model names a dimension (e.g. <em>"the maximum acceptable drive time"</em>) and you provide the value. The overlay text is then composed as <code>scenario: your value</code>.</p>`,
  },
  recent: {
    title: "Recent Outputs",
    body: `<p>Bounded log of the last accepted outputs. Used by the <code>RecentOutputMemory</code> dedupe check — if a new output is too similar (Jaccard similarity over the threshold), the engine rejects it and retries.</p>
      <p>Clear it manually after a major context change.</p>`,
  },
  output: {
    title: "Output",
    body: `<p>The cleaned, validated final text. Pills show:</p>
      <ul>
        <li><strong>route</strong> — which strategy ran</li>
        <li><strong>accepted/rejected</strong> — passed validation?</li>
        <li><strong>timing</strong> — total ms (provider-reported when available)</li>
        <li><strong>tokens</strong> — prompt + completion tokens</li>
      </ul>`,
  },
  iterate: {
    title: "Iterate on output",
    body: `<p>Respond to the latest output and attach your follow-up as a high-priority overlay so the next generation accounts for it.</p>
      <ul>
        <li><strong>Use verbatim</strong> — store your response as-is.</li>
        <li><strong>Compact &amp; insert</strong> — run a small compaction LLM call that condenses your follow-up into a 1-2 sentence overlay capturing the new constraint or preference. The verbatim original is kept on the overlay so you can revert or re-compact later from the overlay's card.</li>
      </ul>
      <p>Compaction params let you tune sampling for that helper call without touching the main generation config.</p>`,
  },
  trace: {
    title: "Debug Trace Sections",
    body: `<p>Inspectable details for the last generation:</p>
      <ul>
        <li><strong>System Prompt</strong> — what was sent as <code>role: "system"</code></li>
        <li><strong>User Prompt</strong> — what was sent as <code>role: "user"</code> (active context + injections + sections)</li>
        <li><strong>Active Context</strong> — base + overlays after expiry + ordering</li>
        <li><strong>Attempts</strong> — every model call this turn, including rejected ones with reasons</li>
        <li><strong>Resolved Config</strong> — final sampling params after all overrides merged</li>
      </ul>`,
  },
};

const EXAMPLES = [
  {
    id: "decision",
    title: "Everyday decision helper",
    blurb: "analyst route + two steering overlays + tighten/markdown injections.",
    base: "You help people think through everyday decisions by laying out clear tradeoffs and asking the one or two questions that would actually unlock the choice.",
    overlays: [
      { name: "budget", priority: 20, text: "The user mentioned they want to keep total cost under $800." },
      { name: "preferences", priority: 10, text: "They prefer outdoor activities over crowded cities and dislike long flights." },
    ],
    mode: "analyst",
    injections: ["tighten", "markdown"],
    input: "I'm trying to decide between a 4-day camping trip in a national park or a long weekend in a small coastal town. What should I think about before picking?",
    config: { temperature: 0.55, max_tokens: 500 },
  },
  {
    id: "release_notes",
    title: "Release-notes writer",
    blurb: "creative route + markdown injection; overlays flip priority toward breaking changes and an ops audience.",
    base: "You write changelog entries for a developer tool used by backend engineers and SREs. Entries should be skimmable, lead with impact, and never bury behaviour changes.",
    overlays: [
      { name: "breaking_change", priority: 30, text: "This release contains at least one breaking change. Call it out first, in bold, with a migration hint." },
      { name: "audience_ops", priority: 10, text: "Primary readers are on-call SREs — emphasise operational impact (restarts, config, resource use) over API ergonomics." },
    ],
    mode: "creative",
    injections: ["markdown"],
    input: "Draft release notes for v2.4.0. Changes:\n- rename env var DB_URL to DATABASE_URL (old name no longer read)\n- add read replicas for the metrics store\n- fix memory leak in the ingest worker under sustained backpressure\n- bump minimum Postgres version to 14",
    config: { temperature: 0.75, max_tokens: 500 },
  },
  {
    id: "support_triage",
    title: "Support-ticket triager",
    blurb: "json_extract route — no overlays. Shows output policy stripping fences to enforce strict JSON.",
    base: "You triage inbound support emails for a SaaS billing product. Your job is to classify and summarise, not to reply.",
    overlays: [],
    mode: "json_extract",
    injections: [],
    input: "Subject: charged twice???\n\nHey — saw TWO charges on my card this morning for $49 each, both from your company. I only have one account (kara@example.com) and I definitely only clicked subscribe once last night. Really need this sorted before my rent clears tomorrow. Fuming.\n\n— Kara",
    config: { temperature: 0.2, max_tokens: 400 },
  },
  {
    id: "brainstorm",
    title: "Solo-founder brainstorm partner",
    blurb: "creative route with two constraint overlays that should visibly bend the suggestions toward cheap, solo-executable ideas.",
    base: "You are a thinking partner for a solo founder. Generate a range of concrete options, not pep talks. Prefer specificity over breadth.",
    overlays: [
      { name: "cash_constrained", priority: 20, text: "Monthly burn must stay under $300. No paid ads, no paid tooling beyond what already exists." },
      { name: "solo_no_hires", priority: 15, text: "Founder is solo and cannot hire or delegate. Anything suggested must be doable by one person in under 10 hours per week." },
    ],
    mode: "creative",
    injections: [],
    input: "How do I get my first 10 paying users for a self-hosted log-tailing tool aimed at indie developers? I've been live for two weeks and have 40 github stars but no revenue.",
    config: { temperature: 0.9, max_tokens: 600 },
  },
  {
    id: "postmortem",
    title: "Incident post-mortem",
    blurb: "analyst route + tighten injection + customer-impact overlay — structured output squeezed short.",
    base: "You write blameless post-mortems for a small infrastructure team. Focus on systems and signals, never on individuals. Separate timeline from analysis.",
    overlays: [
      { name: "customer_impact_high", priority: 25, text: "This incident caused visible customer impact (checkout failures for ~18 minutes). The post-mortem must open with impact quantified in customer terms, not internal metrics." },
    ],
    mode: "analyst",
    injections: ["tighten"],
    input: "Incident facts:\n- 14:02 UTC: deploy of checkout-svc v482 begins\n- 14:04: error rate on /checkout climbs from 0.1% to 94%\n- 14:07: on-call paged\n- 14:12: rollback initiated\n- 14:20: error rate back under 1%\n\nRoot cause: v482 added a new required field to the Stripe webhook verifier, but the migration that populated that field on existing subscription records had not finished running. Verifier rejected ~everything.",
    config: { temperature: 0.5, max_tokens: 500 },
  },
];

const els = {
  metaProvider: $("meta-provider"),
  metaModel: $("meta-model"),
  metaUrl: $("meta-url"),
  routeSelect: $("route-select"),
  routeDesc: $("route-desc"),
  inputText: $("input-text"),
  injectionGroups: $("injection-groups"),
  baseText: $("base-text"),
  saveBase: $("save-base"),
  overlayList: $("overlay-list"),
  overlayName: $("overlay-name"),
  overlayPriority: $("overlay-priority"),
  overlayText: $("overlay-text"),
  overlayRuntime: $("overlay-runtime"),
  addOverlay: $("add-overlay"),
  clearOverlays: $("clear-overlays"),
  runHistory: $("run-history"),
  clearRecent: $("clear-recent"),
  generate: $("generate-btn"),
  editPromptBtn: $("edit-prompt-btn"),
  editPromptModal: $("edit-prompt-modal"),
  editSystem: $("edit-system"),
  editApply: $("edit-prompt-apply"),
  editClear: $("edit-prompt-clear"),
  editReset: $("edit-prompt-reset"),
  sectionOverrideBanner: $("section-override-banner"),
  clearSectionOverride: $("clear-section-override"),
  exportBtn: $("export-btn"),
  exportModal: $("export-modal"),
  exportCode: $("export-code"),
  exportCopy: $("export-copy"),
  exportName: $("export-name"),
  exportSave: $("export-save"),
  exportDownload: $("export-download"),
  exportDir: $("export-dir"),
  exportSavedList: $("export-saved-list"),
  debug: $("debug-toggle"),
  stream: $("stream-toggle"),
  outputRendered: $("output-rendered"),
  outputRaw: $("output-raw"),
  viewRendered: $("view-rendered"),
  viewRaw: $("view-raw"),
  outRoute: $("out-route"),
  outAccepted: $("out-accepted"),
  outTiming: $("out-timing"),
  outUsage: $("out-usage"),
  traceSystem: $("trace-system"),
  traceUser: $("trace-user"),
  traceActive: $("trace-active"),
  traceAttempts: $("trace-attempts"),
  traceUsage: $("trace-usage"),
  traceConfig: $("trace-config"),
  cfg: {
    temperature: $("cfg-temperature"),
    top_p: $("cfg-top_p"),
    top_k: $("cfg-top_k"),
    max_tokens: $("cfg-max_tokens"),
    repeat_penalty: $("cfg-repeat_penalty"),
    retries: $("cfg-retries"),
    max_prompt_chars: $("cfg-max_prompt_chars"),
  },
};

let routeDescriptions = {};
let routeOverrides = {};
let engineConfig = {};

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text);
      const detail = parsed && parsed.detail;
      if (detail && typeof detail === "object" && detail.message) {
        message = `${detail.error || "error"}: ${detail.message}`;
        if (detail.hint) message += `\n${detail.hint}`;
      } else if (typeof detail === "string") {
        message = detail;
      }
    } catch { /* not JSON; fall back to raw text */ }
    throw new Error(`${res.status} ${res.statusText}\n${message}`);
  }
  return res.status === 204 ? null : res.json();
}

function renderMeta(state) {
  els.metaProvider.textContent = `provider: ${state.config.provider}${state.ollama.mock ? " (mock)" : ""}`;
  els.metaModel.textContent = `model: ${state.config.model}`;
  els.metaUrl.textContent = `url: ${state.ollama.url}`;
}

function renderRoutes(state) {
  const prior = els.routeSelect.value;
  els.routeSelect.innerHTML = "";
  routeDescriptions = {};
  routeOverrides = {};
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "(auto-route)";
  els.routeSelect.appendChild(auto);
  for (const route of state.routes) {
    const opt = document.createElement("option");
    opt.value = route.name;
    opt.textContent = route.name;
    els.routeSelect.appendChild(opt);
    routeDescriptions[route.name] = route.description || "";
    routeOverrides[route.name] = route.generation_overrides || {};
  }
  if (prior && [...els.routeSelect.options].some((o) => o.value === prior)) {
    els.routeSelect.value = prior;
  }
  syncRouteDescription();
}

function syncRouteDescription() {
  els.routeDesc.textContent = routeDescriptions[els.routeSelect.value] || "Auto-selects based on context.";
  applyResolvedOverrides();
}

// Injections are exposed as exclusive groups in the GUI: at most one option
// per group. The engine itself still allows arbitrary stacking, but for the
// common cases on this test bench, mutually-exclusive choices are clearer.
const INJECTION_GROUPS = [
  {
    id: "length",
    label: "Length",
    options: ["tighten", "expand"],
    help: "Adjust how compressed or expansive the model should be.",
    // Length is always one or the other — no neutral option shown.
    noneOption: null,
  },
  {
    id: "format",
    label: "Format",
    options: ["json_only", "markdown"],
    help: "Force a specific output shape on top of the route's defaults.",
    // Neutral option is plain text — no format injection applied.
    noneOption: { value: "", label: "text" },
  },
];

let injectionDetails = {};

function renderInjections(state) {
  const prior = {};
  for (const w of els.injectionGroups.querySelectorAll(".injection-group")) {
    prior[w.dataset.groupId] = w.dataset.value || "";
  }
  els.injectionGroups.innerHTML = "";
  injectionDetails = {};
  for (const inj of state.injection_details || []) {
    injectionDetails[inj.name] = inj;
  }

  if (!Object.keys(injectionDetails).length) {
    els.injectionGroups.innerHTML = `<small class="muted">(no injectors registered)</small>`;
    return;
  }

  for (const group of INJECTION_GROUPS) {
    const available = group.options.filter((n) => injectionDetails[n]);
    if (!available.length) continue;

    const wrapper = document.createElement("div");
    wrapper.className = "injection-group";
    wrapper.dataset.groupId = group.id;
    wrapper.dataset.value = "";

    const header = document.createElement("div");
    header.className = "group-header";
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = group.label;
    header.appendChild(label);

    const segmented = document.createElement("div");
    segmented.className = "segmented";
    segmented.setAttribute("role", "radiogroup");

    const makeSeg = (value, text, extraClass = "", tip = "") => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "seg" + (extraClass ? " " + extraClass : "");
      btn.dataset.value = value;
      btn.textContent = text;
      btn.setAttribute("role", "radio");
      if (tip) btn.title = tip;
      btn.addEventListener("click", () => {
        // Groups without a "none" option let you click the active seg again to clear.
        const current = wrapper.dataset.value || "";
        const next = (!group.noneOption && current === value) ? "" : value;
        setGroupValue(wrapper, next);
      });
      return btn;
    };
    if (group.noneOption) {
      segmented.appendChild(makeSeg("", group.noneOption.label, "none", group.help));
    }
    for (const name of available) {
      const tip = (injectionDetails[name] || {}).instructions || "";
      segmented.appendChild(makeSeg(name, name, "", tip));
    }
    header.appendChild(segmented);
    wrapper.appendChild(header);

    els.injectionGroups.appendChild(wrapper);
    const want = prior[group.id] || "";
    const keep = want && available.includes(want) ? want : "";
    setGroupValue(wrapper, keep);
  }
}

function setGroupValue(wrapper, value) {
  wrapper.dataset.value = value || "";
  applyResolvedOverrides();
  wrapper.querySelectorAll(".seg").forEach((seg) => {
    seg.classList.toggle("active", seg.dataset.value === (value || ""));
    seg.setAttribute("aria-checked", seg.dataset.value === (value || "") ? "true" : "false");
  });
}

function selectedInjections() {
  return [...els.injectionGroups.querySelectorAll(".injection-group")]
    .map((w) => w.dataset.value)
    .filter((v) => v);
}

function setSelectedInjections(names) {
  const wanted = new Set(names || []);
  for (const wrapper of els.injectionGroups.querySelectorAll(".injection-group")) {
    const group = INJECTION_GROUPS.find((g) => g.id === wrapper.dataset.groupId);
    const match = group ? group.options.find((n) => wanted.has(n)) : null;
    setGroupValue(wrapper, match || "");
  }
}

function renderBase(state) {
  if (document.activeElement !== els.baseText) {
    els.baseText.value = state.context.base;
  }
}

function renderOverlays(state) {
  // Preserve which cards are open so re-renders don't collapse them and
  // throw away whatever the user was mid-editing.
  const openNames = new Set(
    [...els.overlayList.querySelectorAll(".overlay-card[open]")].map((c) => c.dataset.name)
  );
  els.overlayList.innerHTML = "";
  const overlays = state.context.overlays || {};
  const names = Object.keys(overlays);
  if (!names.length) {
    els.overlayList.innerHTML = `<small class="muted">(no overlays active)</small>`;
    return;
  }
  for (const name of names) {
    const o = overlays[name];
    const card = document.createElement("details");
    card.className = "overlay-card";
    card.dataset.name = name;
    card.dataset.metadata = JSON.stringify(o.metadata || {});
    if (openNames.has(name)) card.open = true;
    const runtimeMode = String((o.metadata || {}).runtime || "").toLowerCase();
    const runtimeBadge = runtimeMode === "required"
      ? ` <span class="turn-badge" title="required runtime slot in exported run()">runtime: required</span>`
      : runtimeMode === "optional"
      ? ` <span class="turn-badge" title="optional runtime slot in exported run()">runtime: optional</span>`
      : "";
    const isTurn = (o.metadata || {}).kind === "turn";
    const hasVerbatim = !!(o.metadata || {}).verbatim;
    const isCompacted = isTurn && !!(o.metadata || {}).compacted;
    const turnActions = isTurn && hasVerbatim ? `
      <div class="turn-actions">
        ${isCompacted ? `<button type="button" class="ghost small" data-act="revert" title="Restore the verbatim user response">⟲ revert to verbatim</button>` : ""}
        <button type="button" class="ghost small" data-act="recompact" title="Run compaction again with current params">↻ re-compact</button>
        <details class="turn-verbatim-peek">
          <summary class="muted">show verbatim</summary>
          <pre class="muted">${escapeHtml((o.metadata || {}).verbatim || "")}</pre>
        </details>
      </div>` : "";
    card.innerHTML = `
      <summary>
        <span class="chevron">▸</span>
        <span class="name">${escapeHtml(name)}${isTurn ? ` <span class="turn-badge" title="iteration turn overlay">turn</span>` : ""}${runtimeBadge} <small class="muted overlay-priority-badge">·p${o.priority}</small></span>
        <span class="text">${escapeHtml(o.text)}</span>
        <button class="remove" type="button" title="remove">×</button>
      </summary>
      <div class="overlay-body">
        <label class="overlay-edit-field">
          <span>priority</span>
          <input type="number" class="edit-priority" value="${o.priority}" step="1" />
        </label>
        <label class="overlay-edit-field">
          <span>text</span>
          <textarea class="edit-text" rows="3">${escapeHtml(o.text)}</textarea>
        </label>
        <label class="overlay-edit-field" title="In an exported run() wrapper, runtime slots become function arguments. Required raises ValueError if empty.">
          <span>runtime</span>
          <select class="edit-runtime">
            <option value="" ${runtimeMode === "" ? "selected" : ""}>fixed (set at export time)</option>
            <option value="optional" ${runtimeMode === "optional" ? "selected" : ""}>runtime — optional</option>
            <option value="required" ${runtimeMode === "required" ? "selected" : ""}>runtime — required</option>
          </select>
        </label>
        <div class="overlay-edit-status muted"><span class="save-state"></span></div>
        ${turnActions}
        ${o.expires_at ? `<div class="muted">expires_at: ${escapeHtml(String(o.expires_at))}</div>` : ""}
      </div>`;

    const priorityEl = card.querySelector(".edit-priority");
    const textEl = card.querySelector(".edit-text");
    const statusEl = card.querySelector(".save-state");

    const markDirty = () => {
      card.classList.add("dirty");
      statusEl.textContent = "unsaved…";
    };
    const runtimeEl = card.querySelector(".edit-runtime");
    priorityEl.addEventListener("input", markDirty);
    textEl.addEventListener("input", markDirty);
    if (runtimeEl) runtimeEl.addEventListener("change", () => {
      markDirty();
      saveOverlayCard(card);
    });
    // `change` fires on blur for priority, and committing text
    priorityEl.addEventListener("change", () => saveOverlayCard(card));
    textEl.addEventListener("change", () => saveOverlayCard(card));
    textEl.addEventListener("blur", () => saveOverlayCard(card));

    card.querySelector("button.remove").addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlayPendingSaves.delete(name);
      await api("DELETE", `/api/context/overlay/${encodeURIComponent(name)}`);
      await refresh();
    });

    const revertBtn = card.querySelector("[data-act='revert']");
    if (revertBtn) {
      revertBtn.addEventListener("click", async () => {
        try {
          await api("POST", `/api/context/overlay/${encodeURIComponent(name)}/revert`, {});
          await refresh();
        } catch (err) { alert("Revert failed: " + err.message); }
      });
    }
    const recompactBtn = card.querySelector("[data-act='recompact']");
    if (recompactBtn) {
      recompactBtn.addEventListener("click", async () => {
        recompactBtn.disabled = true;
        recompactBtn.textContent = "compacting…";
        try {
          await api("POST", `/api/context/overlay/${encodeURIComponent(name)}/recompact`, {
            user_prompt: lastTurnContext.user_prompt,
            assistant_output: lastTurnContext.assistant_output,
            compact_config: readCompactConfig(),
          });
          await refresh();
        } catch (err) {
          alert("Re-compact failed: " + err.message);
          recompactBtn.disabled = false;
          recompactBtn.textContent = "↻ re-compact";
        }
      });
    }

    els.overlayList.appendChild(card);
  }
}

// Per-name map tracking in-flight saves, so critical actions can await them.
const overlayPendingSaves = new Map();

function saveOverlayCard(card) {
  if (!card.classList.contains("dirty")) return Promise.resolve();
  const name = card.dataset.name;
  const statusEl = card.querySelector(".save-state");
  const priority = parseInt(card.querySelector(".edit-priority").value, 10) || 0;
  const text = card.querySelector(".edit-text").value;
  if (statusEl) statusEl.textContent = "saving…";
  let metadata = {};
  try { metadata = JSON.parse(card.dataset.metadata || "{}"); } catch { /* ignore */ }
  // For turn overlays, edits to the text effectively replace the compacted
  // (or verbatim, if never compacted) form; keep metadata intact.
  if (metadata && typeof metadata === "object" && metadata.kind === "turn") {
    if ("compacted" in metadata) metadata = { ...metadata, compacted: text };
  }
  const runtimeSel = card.querySelector(".edit-runtime");
  if (runtimeSel) {
    const v = runtimeSel.value;
    metadata = { ...(metadata || {}) };
    if (v === "optional" || v === "required") metadata.runtime = v;
    else delete metadata.runtime;
  }
  const p = api("PUT", `/api/context/overlay/${encodeURIComponent(name)}`, {
    text, priority, expires_at: null, metadata,
  }).then(() => {
    card.classList.remove("dirty");
    if (statusEl) statusEl.textContent = "saved";
    const badge = card.querySelector(".overlay-priority-badge");
    if (badge) badge.textContent = `·p${priority}`;
    const preview = card.querySelector("summary .text");
    if (preview) preview.textContent = text;
  }).catch((err) => {
    if (statusEl) statusEl.textContent = "save failed: " + err.message;
  }).finally(() => {
    if (overlayPendingSaves.get(name) === p) overlayPendingSaves.delete(name);
  });
  overlayPendingSaves.set(name, p);
  return p;
}

// Commit any dirty overlay edits (including the one currently being typed
// into) before we do anything that depends on server state.
async function flushOverlayEdits() {
  const active = document.activeElement;
  if (active && active.closest && active.closest(".overlay-card")) {
    const card = active.closest(".overlay-card");
    if (card.classList.contains("dirty")) saveOverlayCard(card);
  }
  for (const card of els.overlayList.querySelectorAll(".overlay-card.dirty")) {
    saveOverlayCard(card);
  }
  await Promise.all([...overlayPendingSaves.values()]);
}

function renderRecent(state) {
  lastRunHistory = (state.run_history || []).slice();
  lastRecentSnapshot = (state.recent_outputs || []).slice();
  renderRunHistory(lastRunHistory);
}

let lastRunHistory = [];

function renderRunHistory(records) {
  const host = els.runHistory;
  host.innerHTML = "";
  if (!records.length) {
    host.innerHTML = `<div class="library-empty">No runs yet.</div>`;
    return;
  }
  // Newest first; original index in the deque is the array position.
  records.map((r, i) => ({ r, i })).reverse().forEach(({ r, i }) => {
    const card = document.createElement("div");
    card.className = "run-card" + (r.accepted ? "" : " rejected");
    const when = new Date((r.at || 0) * 1000);
    const promptText = ((r.request || {}).inputs || {}).input || "";
    const route = r.route || "(auto)";
    const injBits = ((r.request || {}).injections || []).join(", ") || "—";
    card.innerHTML = `
      <div class="run-head">
        <span class="run-route">${escapeHtml(route)}</span>
        <span class="run-meta muted">inj: ${escapeHtml(injBits)}</span>
        <span class="spacer"></span>
        <span class="run-time muted">${escapeHtml(when.toLocaleTimeString())}</span>
        <button type="button" class="run-load" data-act="load" title="Load this run back into the form">↺</button>
        <button type="button" class="run-del" data-act="del" title="Delete this run">×</button>
      </div>
      <div class="run-prompt" title="${escapeHtml(promptText)}">${escapeHtml(promptText)}</div>
      <div class="run-output" title="${escapeHtml(r.text || "")}">${escapeHtml(r.text || "")}</div>
    `;
    card.querySelector("[data-act='load']").addEventListener("click", () => loadRun(r));
    card.querySelector("[data-act='del']").addEventListener("click", async () => {
      try {
        await api("DELETE", `/api/run_history/${i}`);
        await refresh();
      } catch (err) { alert("Delete failed: " + err.message); }
    });
    host.appendChild(card);
  });
}

function loadRun(record) {
  const req = record.request || {};
  const inputs = req.inputs || {};
  if (req.mode !== undefined) {
    els.routeSelect.value = req.mode || "";
    syncRouteDescription();
  }
  if (typeof inputs.input === "string") els.inputText.value = inputs.input;
  if (Array.isArray(req.injections)) setSelectedInjections(req.injections);
  for (const k of Object.keys(els.cfg)) els.cfg[k].value = "";
  for (const [k, v] of Object.entries(req.config_overrides || {})) {
    if (els.cfg[k] && v !== null && v !== undefined) els.cfg[k].value = v;
  }
  // Surface the prior output too so the user sees what they're iterating on.
  setOutputText(record.text || "", "(empty response)");
  lastTurnContext.user_prompt = (req.inputs && req.inputs.input) || "";
  lastTurnContext.assistant_output = record.text || "";
  els.inputText.focus();
}

function renderConfigInputs(state) {
  engineConfig = state.config || {};
  // On initial load only, seed inputs with the engine config so the user
  // sees real numbers. After that we leave them alone except when the user
  // changes the route / injections (then we fill resolved values directly).
  if (!renderConfigInputs._seeded) {
    for (const key of Object.keys(els.cfg)) {
      const v = state.config[key];
      els.cfg[key].value = v === null || v === undefined ? "" : v;
    }
    renderConfigInputs._seeded = true;
  }
}

// Resolved precedence (lowest → highest): engine config → route overrides →
// each selected injection's overrides. We write these values directly into
// the inputs whenever the route or injections change; the user is then free
// to edit them from there.
function applyResolvedOverrides() {
  const effective = { ...engineConfig };
  const route = els.routeSelect.value;
  if (route && routeOverrides[route]) Object.assign(effective, routeOverrides[route]);
  for (const inj of selectedInjections()) {
    const overrides = (injectionDetails[inj] || {}).generation_overrides || {};
    Object.assign(effective, overrides);
  }
  for (const key of Object.keys(els.cfg)) {
    const v = effective[key];
    if (v === undefined || v === null) continue;
    els.cfg[key].value = v;
  }
}

async function refresh() {
  const state = await api("GET", "/api/state");
  renderMeta(state);
  renderRoutes(state);
  renderInjections(state);
  renderBase(state);
  renderOverlays(state);
  renderRecent(state);
  renderConfigInputs(state);
}

// Last turn context — what we sent and what came back. Used to give the
// compaction LLM the surrounding context for the user's follow-up.
const lastTurnContext = { user_prompt: "", assistant_output: "" };

function readCompactConfig() {
  const out = {};
  const t = $("compact-temperature");
  const m = $("compact-max_tokens");
  if (t && t.value !== "") out.temperature = Number(t.value);
  if (m && m.value !== "") out.max_tokens = Number(m.value);
  return out;
}

async function iterate(mode) {
  const ta = $("iterate-input");
  const text = (ta.value || "").trim();
  if (!text) { ta.focus(); return; }
  const verbBtn = $("iterate-verbatim");
  const compBtn = $("iterate-compact");
  verbBtn.disabled = compBtn.disabled = true;
  const origLabel = mode === "compact" ? compBtn.textContent : verbBtn.textContent;
  if (mode === "compact") compBtn.textContent = "compacting…";
  try {
    await flushOverlayEdits();
    await api("POST", "/api/iterate", {
      user_prompt: lastTurnContext.user_prompt,
      assistant_output: lastTurnContext.assistant_output,
      user_response: text,
      mode,
      compact_config: mode === "compact" ? readCompactConfig() : {},
    });
    ta.value = "";
    await refresh();
  } catch (err) {
    alert("Iterate failed: " + err.message);
  } finally {
    verbBtn.disabled = compBtn.disabled = false;
    if (mode === "compact") compBtn.textContent = origLabel;
  }
}

function readConfigOverrides() {
  const out = {};
  for (const key of Object.keys(els.cfg)) {
    const raw = els.cfg[key].value.trim();
    if (raw === "") continue;
    const num = Number(raw);
    if (!Number.isNaN(num)) out[key] = num;
  }
  return out;
}

function setOutputText(text, placeholder) {
  const display = text && text.length ? text : (placeholder || "");
  els.outputRaw.textContent = display;
  if (text && text.length) {
    els.outputRendered.innerHTML = renderMarkdown(text);
  } else {
    els.outputRendered.textContent = display;
  }
}

function renderOutput(result) {
  setOutputText(result.text, "(empty response)");
  els.outRoute.textContent = `route: ${result.route}`;
  els.outAccepted.textContent = result.accepted ? "accepted" : "rejected";
  els.outAccepted.className = "pill " + (result.accepted ? "ok" : "bad");

  const t = result.trace || {};
  const timing = result.timing || t.timing || {};
  const usage = result.usage || t.usage || {};
  els.outTiming.textContent = timing.total_ms != null ? `${timing.total_ms.toFixed(0)} ms` : "—";
  const totalTokens = usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
  els.outUsage.textContent = totalTokens ? `${totalTokens} tokens` : "—";

  els.traceSystem.textContent = t.system_prompt || "(none)";
  els.traceUser.textContent = t.user_prompt || "";
  els.traceActive.textContent = t.active_context || "(empty)";
  els.traceAttempts.textContent = (t.attempts || []).map((a, i) =>
    `#${i + 1} ${a.accepted ? "OK" : "REJECTED"}${a.reject_reason ? " — " + a.reject_reason : ""}\n--- raw ---\n${a.raw}\n--- cleaned ---\n${a.cleaned}`
  ).join("\n\n");
  els.traceUsage.textContent = formatUsageTiming(usage, timing);
  const layers = (t.metadata || {}).config_layers;
  els.traceConfig.textContent = JSON.stringify(layers || { resolved_config: t.config || {} }, null, 2);
}

function formatUsageTiming(usage, timing) {
  const lines = [];
  const ms = (v) => (v == null ? null : `${v.toFixed(1)} ms`);
  const fmtRow = (label, value) => { if (value != null) lines.push(`${label.padEnd(18)} ${value}`); };

  fmtRow("total time", ms(timing.total_ms));
  fmtRow("load", ms(timing.load_ms));
  fmtRow("prompt eval", ms(timing.prompt_eval_ms));
  fmtRow("completion eval", ms(timing.eval_ms));

  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const inferredTotal = (prompt || 0) + (completion || 0);
  const total = (usage.total_tokens ?? inferredTotal) || null;
  if (prompt != null || completion != null || total != null) {
    if (lines.length) lines.push("");
    fmtRow("prompt tokens", prompt);
    fmtRow("completion tokens", completion);
    fmtRow("total tokens", total);
  }

  // Tokens per second if both completion-token count and eval time are known.
  if (completion && timing.eval_ms) {
    const tps = (completion / (timing.eval_ms / 1000));
    fmtRow("completion tok/s", tps.toFixed(1));
  }

  return lines.length ? lines.join("\n") : "(no usage/timing reported)";
}

const PY_KEYWORDS = new Set([
  "False","None","True","and","as","assert","async","await","break","class","continue",
  "def","del","elif","else","except","finally","for","from","global","if","import","in",
  "is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield",
]);
const PY_BUILTINS = new Set([
  "print","len","range","str","int","float","dict","list","tuple","set","bool","type",
  "isinstance","hasattr","getattr","setattr","enumerate","zip","map","filter","sum","min","max",
  "sorted","open","repr","id","iter","next","any","all","abs","object",
]);

function highlightPython(src) {
  const tokenRe = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[^\s])/g;
  let out = "";
  let last = 0;
  let prev = "";
  src.replace(tokenRe, (tok, _g, idx) => {
    out += escapeHtml(src.slice(last, idx));
    last = idx + tok.length;
    let cls = null;
    if (tok.startsWith("#")) cls = "c";
    else if (/^["']/.test(tok)) cls = "s";
    else if (/^\d/.test(tok)) cls = "n";
    else if (/^[A-Za-z_]/.test(tok)) {
      if (PY_KEYWORDS.has(tok)) cls = "k";
      else if (PY_BUILTINS.has(tok)) cls = "b";
      else if (prev === "def" || prev === "class") cls = "f";
      else if (prev === "@") cls = "d";
    }
    out += cls ? `<span class="${cls}">${escapeHtml(tok)}</span>` : escapeHtml(tok);
    if (!/^\s+$/.test(tok)) prev = tok;
    return tok;
  });
  out += escapeHtml(src.slice(last));
  return out;
}

function setExportCode(code) {
  els.exportCode.dataset.raw = code;
  els.exportCode.classList.add("py-hl");
  els.exportCode.innerHTML = highlightPython(code);
}

function suggestExportName() {
  if (currentScenarioName) return currentScenarioName;
  const route = els.routeSelect.value || "";
  return route ? `${route}_export` : "export";
}

async function exportPython() {
  const route = els.routeSelect.value || null;
  const injections = selectedInjections();
  els.exportBtn.disabled = true;
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route,
        injections,
        include_overlays: true,
        section_overrides: pendingSectionOverrides || {},
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      const msg = `# export failed (${res.status})\n${detail}`;
      els.exportCode.dataset.raw = msg;
      els.exportCode.textContent = msg;
    } else {
      const { code, dir } = await res.json();
      setExportCode(code);
      if (dir && els.exportDir) els.exportDir.textContent = dir;
    }
    if (!els.exportName.value.trim()) els.exportName.value = suggestExportName();
    els.exportModal.hidden = false;
    refreshSavedExports();
  } catch (err) {
    const msg = `# export failed\n${err}`;
    els.exportCode.dataset.raw = msg;
    els.exportCode.textContent = msg;
    els.exportModal.hidden = false;
  } finally {
    els.exportBtn.disabled = false;
  }
}

function closeExport() {
  els.exportModal.hidden = true;
}

async function copyExport() {
  try {
    await navigator.clipboard.writeText(els.exportCode.dataset.raw || els.exportCode.textContent || "");
    const original = els.exportCopy.textContent;
    els.exportCopy.textContent = "Copied ✓";
    setTimeout(() => (els.exportCopy.textContent = original), 1200);
  } catch {
    els.exportCopy.textContent = "Copy failed";
  }
}

function downloadExport() {
  const code = els.exportCode.dataset.raw || "";
  if (!code) return;
  const name = (els.exportName.value.trim() || suggestExportName()).replace(/[^A-Za-z0-9_.-]+/g, "_") || "export";
  const blob = new Blob([code], { type: "text/x-python" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.py`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveExport() {
  const name = els.exportName.value.trim();
  if (!name) { els.exportName.focus(); return; }
  const code = els.exportCode.dataset.raw || "";
  if (!code) return;
  els.exportSave.disabled = true;
  try {
    const scenario = (typeof captureScenarioState === "function")
      ? captureScenarioState()
      : null;
    await api("PUT", `/api/exports/${encodeURIComponent(name)}`, { code, scenario });
    const original = els.exportSave.textContent;
    els.exportSave.textContent = "Saved ✓";
    setTimeout(() => (els.exportSave.textContent = original), 1200);
    refreshSavedExports();
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    els.exportSave.disabled = false;
  }
}

async function refreshSavedExports() {
  try {
    const { exports = [] } = await api("GET", "/api/exports");
    const host = els.exportSavedList;
    host.innerHTML = "";
    if (!exports.length) {
      host.innerHTML = `<div class="library-empty">No saved exports yet.</div>`;
      return;
    }
    for (const row of exports) {
      const card = document.createElement("div");
      card.className = "library-item";
      const saved = new Date((row.saved_at || 0) * 1000);
      const scenarioBtn = row.has_scenario
        ? `<button type="button" class="ghost small" data-act="load-scenario" title="Restore the studio state captured when this export was saved">Load scenario</button>`
        : "";
      card.innerHTML = `
        <div class="item-head">
          <span class="item-name">${escapeHtml(row.name)}${row.has_scenario ? ` <small class="muted">· scenario</small>` : ""}</span>
          <span class="item-date">${escapeHtml(saved.toLocaleString())}</span>
        </div>
        <div class="item-actions">
          <button type="button" class="primary small" data-act="load">Load</button>
          ${scenarioBtn}
          <button type="button" class="ghost small" data-act="delete">Delete</button>
        </div>`;
      card.querySelector("[data-act='load']").addEventListener("click", async () => {
        try {
          const entry = await api("GET", `/api/exports/${encodeURIComponent(row.name)}`);
          setExportCode(entry.code || "");
          els.exportName.value = row.name;
        } catch (err) { alert("Load failed: " + err.message); }
      });
      const scEl = card.querySelector("[data-act='load-scenario']");
      if (scEl) scEl.addEventListener("click", async () => {
        try {
          const entry = await api("GET", `/api/scenarios/${encodeURIComponent(row.name)}`);
          await applyScenarioState(entry.state || {});
          els.exportModal.hidden = true;
        } catch (err) { alert("Scenario load failed: " + err.message); }
      });
      card.querySelector("[data-act='delete']").addEventListener("click", async () => {
        if (!confirm(`Delete export "${row.name}"?`)) return;
        try {
          await api("DELETE", `/api/exports/${encodeURIComponent(row.name)}`);
          refreshSavedExports();
        } catch (err) { alert("Delete failed: " + err.message); }
      });
      host.appendChild(card);
    }
  } catch {
    /* ignore */
  }
}

async function generate() {
  els.generate.disabled = true;
  setOutputText("", "Generating…");
  try {
    await flushOverlayEdits();
    const request = {
      mode: els.routeSelect.value || null,
      inputs: { input: els.inputText.value },
      injections: selectedInjections(),
      debug: els.debug.checked,
      config_overrides: readConfigOverrides(),
    };
    if (pendingSectionOverrides) request.section_overrides = pendingSectionOverrides;
    const result = els.stream.checked
      ? await generateStream(request)
      : await api("POST", "/api/generate", request);
    lastTurnContext.user_prompt = els.inputText.value || "";
    lastTurnContext.assistant_output = result.text || "";
    renderOutput(result);
    await refresh();
  } catch (err) {
    setOutputText("", `ERROR: ${err.message}`);
  } finally {
    els.generate.disabled = false;
  }
}

async function generateStream(request) {
  const res = await fetch("/api/generate/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("Streaming is not supported by this browser.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let output = "";
  let finalResult = null;

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error.message || event.error.error || "stream failed");
      if (event.delta) {
        output += event.delta;
        setOutputText(output, "Generating…");
      }
      if (event.done) finalResult = event.result;
    }
    if (done) break;
  }

  if (!finalResult) throw new Error("stream ended without a final result");
  return finalResult;
}

function setView(mode) {
  const renderedActive = mode === "rendered";
  els.outputRendered.hidden = !renderedActive;
  els.outputRaw.hidden = renderedActive;
  els.viewRendered.classList.toggle("active", renderedActive);
  els.viewRaw.classList.toggle("active", !renderedActive);
}

els.viewRendered.addEventListener("click", () => setView("rendered"));
els.viewRaw.addEventListener("click", () => setView("raw"));

function syncDebugPanel() {
  document.querySelector("main.grid").classList.toggle("no-debug", !els.debug.checked);
}
els.debug.addEventListener("change", syncDebugPanel);
syncDebugPanel();

async function saveBase() {
  await flushOverlayEdits();
  await api("PUT", "/api/context/base", { base: els.baseText.value, fields: {} });
  await refresh();
}

// --- base context library (named saves) -----------------------------
function openSaveAsDialog() {
  const text = els.baseText.value;
  if (!text.trim()) { alert("Enter some base context first."); return; }
  const node = document.createElement("div");
  node.className = "dialog-form";
  node.innerHTML = `
    <label>Title
      <input type="text" id="dlg-base-title" placeholder="e.g. Friendly code reviewer" autocomplete="off" />
    </label>
    <div class="hint">Current base context will be saved to your library under this title. Reusing an existing title overwrites it.</div>
    <div class="dialog-actions">
      <button type="button" class="ghost" data-act="cancel">Cancel</button>
      <button type="button" class="primary" data-act="save">Save</button>
    </div>`;
  openModal("Save Base As…", node);
  const title = node.querySelector("#dlg-base-title");
  title.focus();
  const submit = async () => {
    const name = title.value.trim();
    if (!name) { title.focus(); return; }
    try {
      await api("PUT", `/api/base_library/${encodeURIComponent(name)}`, { text });
      closeModal();
    } catch (err) { alert("Save failed: " + err.message); }
  };
  node.querySelector("[data-act='save']").addEventListener("click", submit);
  node.querySelector("[data-act='cancel']").addEventListener("click", closeModal);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

async function openLoadDialog() {
  const node = document.createElement("div");
  node.innerHTML = `<div class="library-list"><div class="library-empty">Loading…</div></div>`;
  openModal("Load Base Context", node);
  try {
    const res = await api("GET", "/api/base_library");
    renderLibraryList(node.querySelector(".library-list"), res.bases || []);
  } catch (err) {
    node.querySelector(".library-list").innerHTML = `<div class="library-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderLibraryList(host, items) {
  host.innerHTML = "";
  if (!items.length) {
    host.innerHTML = `<div class="library-empty">No saved base contexts yet. Use "Save As…" to add one.</div>`;
    return;
  }
  for (const item of items) {
    const saved = new Date((item.saved_at || 0) * 1000);
    const card = document.createElement("div");
    card.className = "library-item";
    card.innerHTML = `
      <div class="item-head">
        <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="item-date">${escapeHtml(saved.toLocaleString())}</span>
      </div>
      <div class="item-text">${escapeHtml(item.text)}</div>
      <div class="item-actions">
        <button type="button" class="primary small" data-act="load">Load</button>
        <button type="button" class="ghost small" data-act="delete">Delete</button>
      </div>`;
    card.querySelector("[data-act='load']").addEventListener("click", async () => {
      els.baseText.value = item.text;
      await api("PUT", "/api/context/base", { base: item.text, fields: {} });
      closeModal();
      await refresh();
    });
    card.querySelector("[data-act='delete']").addEventListener("click", async () => {
      if (!confirm(`Delete "${item.name}"?`)) return;
      try {
        await api("DELETE", `/api/base_library/${encodeURIComponent(item.name)}`);
        card.remove();
        if (!host.querySelector(".library-item")) {
          host.innerHTML = `<div class="library-empty">No saved base contexts yet. Use "Save As…" to add one.</div>`;
        }
      } catch (err) { alert("Delete failed: " + err.message); }
    });
    host.appendChild(card);
  }
}

// --- scenarios (full app-state save/load) ---------------------------
// A scenario is everything the user can set up: base context + overlays +
// route + injections + draft prompt + generation overrides + recent outputs.
// Captured as an opaque blob and rehydrated on load.

function captureScenarioState() {
  const overlays = [];
  for (const card of els.overlayList.querySelectorAll(".overlay-card")) {
    const name = card.dataset.name;
    const text = (card.querySelector(".edit-text") || {}).value || "";
    const priority = parseInt(
      (card.querySelector(".edit-priority") || {}).value || "0", 10
    ) || 0;
    if (name) overlays.push({ name, text, priority });
  }
  const cfg = {};
  for (const k of Object.keys(els.cfg)) {
    const v = els.cfg[k].value;
    if (v !== "") cfg[k] = isNaN(Number(v)) ? v : Number(v);
  }
  return {
    base: els.baseText.value,
    overlays,
    route: els.routeSelect.value || "",
    injections: selectedInjections(),
    input: els.inputText.value,
    config_overrides: cfg,
    run_history: lastRunHistory.slice(),
  };
}

let lastRecentSnapshot = [];
let currentScenarioName = "";
let pendingSectionOverrides = null;

function updateSectionOverrideBanner() {
  const has = pendingSectionOverrides && Object.keys(pendingSectionOverrides).length > 0;
  els.sectionOverrideBanner.hidden = !has;
}

async function fetchResolvedPrompt() {
  const res = await fetch("/api/prompt/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: els.routeSelect.value || null,
      inputs: { input: els.inputText.value || "" },
      injections: selectedInjections(),
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function openEditPrompt() {
  try {
    if (pendingSectionOverrides) {
      els.editSystem.value = pendingSectionOverrides.system ?? "";
    } else {
      const { system } = await fetchResolvedPrompt();
      els.editSystem.value = system || "";
    }
    els.editPromptModal.hidden = false;
  } catch (err) {
    alert("Couldn't resolve prompt: " + err.message);
  }
}

function closeEditPrompt() {
  els.editPromptModal.hidden = true;
}

function applyEditPrompt() {
  pendingSectionOverrides = { system: els.editSystem.value };
  updateSectionOverrideBanner();
  closeEditPrompt();
}

function clearSectionOverride() {
  pendingSectionOverrides = null;
  updateSectionOverrideBanner();
}

async function resetEditPrompt() {
  try {
    const { system } = await fetchResolvedPrompt();
    els.editSystem.value = system || "";
  } catch (err) {
    alert("Reload failed: " + err.message);
  }
}

async function applyScenarioState(state) {
  if (!state || typeof state !== "object") return;
  await api("DELETE", "/api/context/overlays");
  await api("PUT", "/api/context/base", { base: state.base || "", fields: {} });
  for (const o of state.overlays || []) {
    if (!o || !o.name) continue;
    await api("PUT", `/api/context/overlay/${encodeURIComponent(o.name)}`, {
      text: o.text || "",
      priority: typeof o.priority === "number" ? o.priority : 0,
      expires_at: null,
      metadata: {},
    });
  }
  await refresh();
  if (state.route !== undefined) {
    els.routeSelect.value = state.route || "";
    syncRouteDescription();
  }
  if (Array.isArray(state.injections)) setSelectedInjections(state.injections);
  if (state.input !== undefined) els.inputText.value = state.input;
  for (const k of Object.keys(els.cfg)) els.cfg[k].value = "";
  for (const [k, v] of Object.entries(state.config_overrides || {})) {
    if (els.cfg[k]) els.cfg[k].value = v;
  }
  if (Array.isArray(state.run_history)) {
    try {
      await api("PUT", "/api/run_history", { records: state.run_history });
      await refresh();
    } catch (err) { console.warn("run_history restore failed:", err); }
  }
}

function openScenariosDialog() {
  const node = document.createElement("div");
  node.className = "dialog-form";
  node.innerHTML = `
    <label>Save current state as
      <input type="text" id="dlg-scn-title" placeholder="e.g. Working setup for billing triage" autocomplete="off" />
    </label>
    <div class="dialog-actions">
      <button type="button" class="primary" data-act="save">Save</button>
    </div>
    <div class="subhead" style="margin-top:14px"><span>Saved scenarios</span></div>
    <div class="library-list" data-role="list"><div class="library-empty">Loading…</div></div>
  `;
  openModal("Scenarios", node);
  const title = node.querySelector("#dlg-scn-title");
  title.focus();
  const list = node.querySelector("[data-role='list']");
  const refreshList = async () => {
    try {
      const res = await api("GET", "/api/scenarios");
      renderScenarioList(list, res.scenarios || []);
    } catch (err) {
      list.innerHTML = `<div class="library-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  };
  const submit = async () => {
    const name = title.value.trim();
    if (!name) { title.focus(); return; }
    try {
      await flushOverlayEdits();
      const state = captureScenarioState();
      await api("PUT", `/api/scenarios/${encodeURIComponent(name)}`, { state });
      currentScenarioName = name;
      title.value = "";
      await refreshList();
    } catch (err) { alert("Save failed: " + err.message); }
  };
  node.querySelector("[data-act='save']").addEventListener("click", submit);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  refreshList();
}

function renderScenarioList(host, items) {
  host.innerHTML = "";
  if (!items.length) {
    host.innerHTML = `<div class="library-empty">No saved scenarios yet.</div>`;
    return;
  }
  for (const item of items) {
    const saved = new Date((item.saved_at || 0) * 1000);
    const card = document.createElement("div");
    card.className = "library-item";
    card.innerHTML = `
      <div class="item-head">
        <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="item-date">${escapeHtml(saved.toLocaleString())}</span>
      </div>
      <div class="item-actions">
        <button type="button" class="primary small" data-act="load">Load</button>
        <button type="button" class="ghost small" data-act="delete">Delete</button>
      </div>`;
    card.querySelector("[data-act='load']").addEventListener("click", async () => {
      try {
        const row = await api("GET", `/api/scenarios/${encodeURIComponent(item.name)}`);
        await applyScenarioState(row.state || {});
        currentScenarioName = item.name;
        closeModal();
      } catch (err) { alert("Load failed: " + err.message); }
    });
    card.querySelector("[data-act='delete']").addEventListener("click", async () => {
      if (!confirm(`Delete scenario "${item.name}"?`)) return;
      try {
        await api("DELETE", `/api/scenarios/${encodeURIComponent(item.name)}`);
        card.remove();
        if (!host.querySelector(".library-item")) {
          host.innerHTML = `<div class="library-empty">No saved scenarios yet.</div>`;
        }
      } catch (err) { alert("Delete failed: " + err.message); }
    });
    host.appendChild(card);
  }
}

async function addOverlay() {
  const name = els.overlayName.value.trim();
  if (!name) return alert("overlay needs a name");
  const text = els.overlayText.value.trim();
  if (!text) return alert("overlay needs text");
  const priority = parseInt(els.overlayPriority.value || "0", 10) || 0;
  const runtimeMode = els.overlayRuntime ? els.overlayRuntime.value : "";
  const metadata = (runtimeMode === "optional" || runtimeMode === "required")
    ? { runtime: runtimeMode }
    : {};
  await flushOverlayEdits();
  await api("PUT", `/api/context/overlay/${encodeURIComponent(name)}`, {
    text, priority, expires_at: null, metadata,
  });
  els.overlayName.value = "";
  els.overlayText.value = "";
  if (els.overlayRuntime) els.overlayRuntime.value = "";
  await refresh();
}

async function clearOverlays() {
  // No point flushing — we're about to wipe them all.
  overlayPendingSaves.clear();
  await api("DELETE", "/api/context/overlays");
  await refresh();
}

// --- overlay suggestions --------------------------------------------
async function suggestOverlays() {
  const btn = $("suggest-overlays");
  const countInput = $("suggest-count");
  const host = $("overlay-suggestions");
  const count = Math.max(1, Math.min(parseInt(countInput.value, 10) || 5, 20));
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "thinking…";
  host.hidden = false;
  host.innerHTML = `<div class="muted">Generating ${count} suggestion${count === 1 ? "" : "s"}…</div>`;
  try {
    await flushOverlayEdits();
    const res = await api("POST", "/api/context/base/suggest_overlays", {
      count,
      user_input: els.inputText.value || "",
    });
    renderSuggestions(res.suggestions || [], res.raw || "");
  } catch (err) {
    host.innerHTML = `<div class="suggestion-error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function renderSuggestions(list, raw) {
  const host = $("overlay-suggestions");
  host.innerHTML = "";
  if (!list.length) {
    host.innerHTML = `<div class="suggestion-error">No parseable suggestions. Raw output:<br><pre class="trace">${escapeHtml(raw)}</pre></div>`;
    return;
  }
  const header = document.createElement("div");
  header.className = "suggestion-header";
  header.innerHTML = `<span>Suggested overlays</span><button class="ghost small" type="button" data-dismiss>dismiss</button>`;
  header.querySelector("[data-dismiss]").addEventListener("click", () => { host.hidden = true; host.innerHTML = ""; });
  host.appendChild(header);

  for (const s of list) {
    const card = document.createElement("div");
    card.className = "suggestion-card";
    // If the model gave us a pre-baked `text`, fall back to scenario for the label.
    const scenario = s.scenario || s.text || "";
    card.innerHTML = `
      <div class="suggestion-top">
        <span class="suggestion-name">${escapeHtml(s.name)}</span>
        <span class="muted">·p${s.priority}</span>
        <span class="spacer"></span>
        <button class="primary small" type="button" data-act="add" disabled>Add</button>
        <button class="ghost small" type="button" data-act="edit">Edit</button>
      </div>
      <div class="suggestion-scenario">${escapeHtml(scenario)}</div>
      <label class="suggestion-slot">
        <span>user input</span>
        <input type="text" class="slot-input" placeholder="${escapeHtml(s.placeholder || "your value…")}" />
      </label>
      ${s.rationale ? `<div class="suggestion-rationale muted">${escapeHtml(s.rationale)}</div>` : ""}`;

    const slotInput = card.querySelector(".slot-input");
    const addBtn = card.querySelector("[data-act='add']");
    const editBtn = card.querySelector("[data-act='edit']");

    // Compose the overlay text as `scenario: user_value`. Require a value
    // before enabling Add so suggestions don't become half-baked overlays.
    const composedText = () => {
      const v = slotInput.value.trim();
      return v ? `${scenario}: ${v}` : "";
    };
    const refreshState = () => {
      addBtn.disabled = !composedText();
    };
    slotInput.addEventListener("input", refreshState);
    slotInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); if (!addBtn.disabled) addBtn.click(); }
    });

    addBtn.addEventListener("click", async () => {
      const text = composedText();
      if (!text) return;
      await api("PUT", `/api/context/overlay/${encodeURIComponent(s.name)}`, {
        text, priority: s.priority, expires_at: null, metadata: {},
      });
      card.classList.add("added");
      addBtn.textContent = "added ✓";
      addBtn.disabled = true;
      slotInput.disabled = true;
      await refresh();
    });
    editBtn.addEventListener("click", () => {
      els.overlayName.value = s.name;
      els.overlayPriority.value = s.priority;
      els.overlayText.value = composedText() || scenario;
      els.overlayText.focus();
    });
    host.appendChild(card);
  }
}

async function clearRecent() {
  await api("DELETE", "/api/recent");
  await refresh();
}

// --- modal & example wiring ----------------------------------------
const modal = $("modal");
const modalTitle = $("modal-title");
const modalBody = $("modal-body");

function openHelp(key) {
  const entry = HELP[key];
  if (!entry) return;
  openModal(entry.title, entry.body);
}

function openModal(title, bodyHtmlOrNode) {
  modalTitle.textContent = title;
  modalBody.innerHTML = "";
  if (typeof bodyHtmlOrNode === "string") {
    modalBody.innerHTML = bodyHtmlOrNode;
  } else if (bodyHtmlOrNode instanceof Node) {
    modalBody.appendChild(bodyHtmlOrNode);
  }
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
  modalBody.innerHTML = "";
}

document.querySelectorAll("button.help").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openHelp(btn.dataset.help);
  });
});

modal.addEventListener("click", (e) => {
  if (e.target.dataset && e.target.dataset.close !== undefined) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.hidden) closeModal();
});

function openExamplePicker() {
  const node = document.createElement("div");
  node.className = "library-list";
  for (const ex of EXAMPLES) {
    const overlayBits = ex.overlays.length
      ? ex.overlays.map((o) => escapeHtml(o.name)).join(", ")
      : "none";
    const injBits = ex.injections.length ? ex.injections.join(", ") : "none";
    const card = document.createElement("div");
    card.className = "library-item";
    card.innerHTML = `
      <div class="item-head">
        <span class="item-name">${escapeHtml(ex.title)}</span>
        <span class="item-date">${escapeHtml(ex.mode)}</span>
      </div>
      <div class="item-text">${escapeHtml(ex.blurb)}</div>
      <div class="item-text muted">overlays: ${overlayBits} · injections: ${injBits}</div>
      <div class="item-actions">
        <button type="button" class="primary small" data-act="load">Load</button>
      </div>`;
    card.querySelector("[data-act='load']").addEventListener("click", async () => {
      closeModal();
      await applyExample(ex);
    });
    node.appendChild(card);
  }
  openModal("Load Example Scenario", node);
}

async function applyExample(ex) {
  const btn = $("example-btn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    await api("DELETE", "/api/context/overlays");
    await api("PUT", "/api/context/base", { base: ex.base, fields: {} });
    for (const o of ex.overlays) {
      await api("PUT", `/api/context/overlay/${encodeURIComponent(o.name)}`, {
        text: o.text, priority: o.priority, expires_at: null, metadata: {},
      });
    }
    await refresh();
    els.routeSelect.value = ex.mode;
    syncRouteDescription();
    els.inputText.value = ex.input;
    setSelectedInjections(ex.injections);
    for (const k of Object.keys(els.cfg)) {
      if (els.cfg[k]) els.cfg[k].value = "";
    }
    for (const [k, v] of Object.entries(ex.config || {})) {
      if (els.cfg[k]) els.cfg[k].value = v;
    }
    els.debug.checked = true;
    els.inputText.focus();
  } catch (err) {
    alert("Failed to load example: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Load Example Scenario";
  }
}

$("example-btn").addEventListener("click", openExamplePicker);
$("scenarios-btn").addEventListener("click", openScenariosDialog);
$("iterate-verbatim").addEventListener("click", () => iterate("verbatim"));
$("iterate-compact").addEventListener("click", () => iterate("compact"));

els.generate.addEventListener("click", generate);
els.editPromptBtn.addEventListener("click", openEditPrompt);
els.editApply.addEventListener("click", applyEditPrompt);
els.editClear.addEventListener("click", () => { clearSectionOverride(); closeEditPrompt(); });
els.editReset.addEventListener("click", resetEditPrompt);
els.editPromptModal.querySelectorAll("[data-close-edit-prompt]").forEach((el) =>
  el.addEventListener("click", closeEditPrompt)
);
els.clearSectionOverride.addEventListener("click", (e) => { e.preventDefault(); clearSectionOverride(); });
els.exportBtn.addEventListener("click", exportPython);
els.exportCopy.addEventListener("click", copyExport);
els.exportSave.addEventListener("click", saveExport);
els.exportDownload.addEventListener("click", downloadExport);
els.exportName.addEventListener("keydown", (e) => { if (e.key === "Enter") saveExport(); });
els.exportModal.querySelectorAll("[data-close-export]").forEach((el) =>
  el.addEventListener("click", closeExport)
);
els.saveBase.addEventListener("click", saveBase);
$("save-base-as").addEventListener("click", openSaveAsDialog);
$("load-base").addEventListener("click", openLoadDialog);
els.addOverlay.addEventListener("click", addOverlay);
els.clearOverlays.addEventListener("click", clearOverlays);
els.clearRecent.addEventListener("click", clearRecent);
$("suggest-overlays").addEventListener("click", suggestOverlays);
els.routeSelect.addEventListener("change", syncRouteDescription);
els.inputText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate();
});

// --- tab switching --------------------------------------------------
// Tabs in the controls panel. Help "?" buttons live inside the tab
// triggers, so we ignore clicks that originate on a help button.
function activateTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
}

document.querySelectorAll(".tabs .tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    if (e.target.closest("button.help")) return;
    activateTab(tab.dataset.tab);
  });
  tab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateTab(tab.dataset.tab);
    }
  });
});

refresh().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<div style="background:#5b1c1c;color:#fff;padding:10px">Failed to load state: ${err.message}</div>`);
});
