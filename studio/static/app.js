// promptlibretto studio — talks to the FastAPI server.
import { mountConnectionChip, getConnection } from "/static/connection.js";
import { generate as ollamaGenerate, streamGenerate as ollamaStream } from "/static/ollama_client.js";
const $ = (id) => document.getElementById(id);

mountConnectionChip(document.getElementById("connection-slot"));

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
    body: `<p>This panel sets the stage for one generation:</p>
      <ul>
        <li><strong>Base Context</strong> — long-lived framing that rides along with every route</li>
        <li><strong>Route</strong> — which prompt strategy to use</li>
        <li><strong>User Input</strong> — the actual request</li>
      </ul>
      <p>Tuning knobs (overlays, injections, sampling overrides) live on the <em>Tuning</em> tab. Hit <code>Generate</code> (or <code>Ctrl/Cmd+Enter</code>) to run and see the trace on the right.</p>`,
  },
  route: {
    title: "Route",
    body: `<p>A <strong>route</strong> is a named end-to-end strategy for one kind of prompt. It bundles:</p>
      <ul>
        <li><strong>A composition recipe</strong> — ordered system + user sections (functions, not strings) assembled per call against the live context, request inputs, and active injections.</li>
        <li><strong>Sampling defaults</strong> — temperature, max_tokens, etc. that fit that strategy.</li>
        <li><strong>An output policy</strong> — how to clean and validate what comes back (strip fences, require a regex, ban substrings).</li>
        <li><strong>An applicability predicate</strong> (optional) — lets the router auto-pick this route when the request/context fits.</li>
      </ul>
      <p>The point is reuse and switching: instead of one huge branchy prompt, you define <code>analyst</code>, <code>creative</code>, <code>json_extract</code>, etc. as separate routes and let the router (or the caller via <code>mode=</code>) pick one. Two callers asking different questions get different system frames, sampling, and validation — without either site knowing how the other works.</p>
      <p><em>Mental model:</em> a route is to prompts what an HTTP endpoint handler is to requests — a named, self-contained way of handling one shape of input that shares infrastructure (context, assets, provider, history) with all the others.</p>
      <p>Available routes in this demo:</p>
      <ul>
        <li><code>default</code> — neutral, plainspoken assistant</li>
        <li><code>concise</code> — short factual answer with examples</li>
        <li><code>creative</code> — vivid creative composition</li>
        <li><code>analyst</code> — structured analysis with explicit tradeoffs</li>
        <li><code>json_extract</code> — strict JSON-only output for a known schema</li>
      </ul>
      <p>Leave it on <code>(auto-route)</code> to let the router pick based on context overlays + predicates. Custom routes (★) you author via <strong>+ Custom</strong> are explicit-select only.</p>`,
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
    title: "Tuning",
    body: `<p>Per-call knobs for the next generation:</p>
      <ul>
        <li><strong>Overlays</strong> — short-lived facts with names + priority. Highest priority wins, expired overlays are auto-purged. Layered on top of Base Context.</li>
        <li><strong>Injections</strong> — reusable prompt fragments that modify the active route.</li>
        <li><strong>Generation Overrides</strong> — per-request sampling parameters (temperature, top_p, max_tokens, …).</li>
      </ul>`,
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
  overlayTemplate: $("overlay-template"),
  addOverlay: $("add-overlay"),
  clearOverlays: $("clear-overlays"),
  saveResponseOverlay: $("save-response-overlay"),
  generate: $("generate-btn"),
  promptStage: $("prompt-stage"),
  stageReset: $("stage-reset"),
  outputRendered: $("output-rendered"),
  outputRaw: $("output-raw"),
  editPromptBtn: $("edit-prompt-btn"),
  newCustomRouteBtn: $("new-custom-route-btn"),
  editCustomRouteBtn: $("edit-custom-route-btn"),
  deleteCustomRouteBtn: $("delete-custom-route-btn"),
  customRouteModal: $("custom-route-modal"),
  crName: $("cr-name"),
  crDescription: $("cr-description"),
  crSystem: $("cr-system"),
  crUserTemplate: $("cr-user-template"),
  crPriority: $("cr-priority"),
  crOverrides: $("cr-overrides"),
  crOutputPolicy: $("cr-output-policy"),
  crSave: $("cr-save"),
  crDelete: $("cr-delete"),
  crError: $("cr-error"),
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
let routePolicies = {};
let routeIsCustom = {};
let engineConfig = {};

async function apiWithSignal(method, path, body, signal) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;
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

function renderRoutes(state) {
  const prior = els.routeSelect.value;
  els.routeSelect.innerHTML = "";
  routeDescriptions = {};
  routeOverrides = {};
  routePolicies = {};
  routeIsCustom = {};
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "(auto-route)";
  els.routeSelect.appendChild(auto);
  for (const route of state.routes) {
    const opt = document.createElement("option");
    opt.value = route.name;
    opt.textContent = route.is_custom ? `${route.name} ★` : route.name;
    els.routeSelect.appendChild(opt);
    routeDescriptions[route.name] = route.description || "";
    routeOverrides[route.name] = route.generation_overrides || {};
    routePolicies[route.name] = route.output_policy || {};
    routeIsCustom[route.name] = !!route.is_custom;
  }
  if (prior && [...els.routeSelect.options].some((o) => o.value === prior)) {
    els.routeSelect.value = prior;
  }
  syncRouteDescription();
}

function syncRouteDescription() {
  const desc = routeDescriptions[els.routeSelect.value] || "";
  const descWrap = document.getElementById("route-desc-wrap");
  if (descWrap) {
    if (desc) {
      els.routeDesc.textContent = desc;
      descWrap.hidden = false;
    } else {
      descWrap.hidden = true;
    }
  }
  applyResolvedOverrides();
  syncCustomRouteButtons();
  syncPolicySummary();
}

function syncPolicySummary() {
  const fieldset = document.getElementById("route-policy-fieldset");
  const list = document.getElementById("route-policy-list");
  if (!fieldset || !list) return;
  const policy = routePolicies[els.routeSelect.value] || {};

  const rows = [];
  const addRow = (label, value) => rows.push({ key: label, val: value });
  const addList = (label, items) => {
    for (const item of items) addRow(label, item);
  };

  if (policy.min_length != null) addRow("min length", `${policy.min_length} chars`);
  if (policy.max_length != null) addRow("max length", `${policy.max_length} chars`);
  if (policy.collapse_whitespace === false) addRow("collapse whitespace", "off");
  if (policy.append_suffix) addRow("append suffix", `"${policy.append_suffix}"`);
  if ((policy.strip_prefixes || []).length) addList("strip prefix", policy.strip_prefixes);
  if ((policy.strip_patterns || []).length) addList("strip pattern", policy.strip_patterns);
  if ((policy.require_patterns || []).length) addList("require pattern", policy.require_patterns);
  if ((policy.forbidden_substrings || []).length) addList("forbidden substring", policy.forbidden_substrings);
  if ((policy.forbidden_patterns || []).length) addList("forbidden pattern", policy.forbidden_patterns);

  if (rows.length) {
    list.innerHTML = rows.map(r =>
      `<div class="route-policy-item"><span class="pol-key">${escapeHtml(r.key)}</span><span class="pol-val">${escapeHtml(r.val)}</span></div>`
    ).join("");
    fieldset.hidden = false;
  } else {
    fieldset.hidden = true;
    list.innerHTML = "";
  }
}

function syncCustomRouteButtons() {
  const name = els.routeSelect.value;
  const isCustom = !!routeIsCustom[name];
  if (els.editCustomRouteBtn) els.editCustomRouteBtn.hidden = !isCustom;
  if (els.deleteCustomRouteBtn) els.deleteCustomRouteBtn.hidden = !isCustom;
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
let injectionTextOverrides = {};

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

    // Single pencil button — shown only when an injection is active
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ghost small inj-edit-btn";
    editBtn.textContent = "\u270E";
    editBtn.hidden = true;
    editBtn.addEventListener("click", () => {
      const active = wrapper.dataset.value;
      if (active) toggleInjectionEditor(wrapper, active);
    });
    header.appendChild(editBtn);

    wrapper.appendChild(header);

    // Container for inline editor (initially hidden)
    const editorWrap = document.createElement("div");
    editorWrap.className = "inj-editor-wrap";
    editorWrap.hidden = true;
    wrapper.appendChild(editorWrap);

    els.injectionGroups.appendChild(wrapper);
    const want = prior[group.id] || "";
    const keep = want && available.includes(want) ? want : "";
    setGroupValue(wrapper, keep);
  }
}

function toggleInjectionEditor(wrapper, name) {
  const editorWrap = wrapper.querySelector(".inj-editor-wrap");
  // If already showing this injection's editor, toggle it off
  if (!editorWrap.hidden && editorWrap.dataset.editing === name) {
    editorWrap.hidden = true;
    return;
  }
  const detail = injectionDetails[name] || {};
  const defaultText = detail.instructions || "";
  const currentText = injectionTextOverrides[name] !== undefined
    ? injectionTextOverrides[name]
    : defaultText;

  editorWrap.dataset.editing = name;
  editorWrap.hidden = false;
  editorWrap.innerHTML = "";

  const label = document.createElement("span");
  label.className = "inj-editor-label";
  label.innerHTML = `<strong>${escapeHtml(name)}</strong> prompt text`;
  editorWrap.appendChild(label);

  const ta = document.createElement("textarea");
  ta.className = "inj-editor-textarea";
  ta.rows = 3;
  ta.value = currentText;
  ta.placeholder = "Injection instructions…";
  editorWrap.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "inj-editor-actions";

  const isOverridden = injectionTextOverrides[name] !== undefined;
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "ghost small";
  resetBtn.textContent = "Reset to default";
  resetBtn.disabled = !isOverridden;
  const pencilBtn = wrapper.querySelector(".inj-edit-btn");
  resetBtn.addEventListener("click", () => {
    delete injectionTextOverrides[name];
    ta.value = defaultText;
    resetBtn.disabled = true;
    if (pencilBtn) pencilBtn.classList.remove("overridden");
    markSnapshotDirty();
  });
  actions.appendChild(resetBtn);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "ghost small";
  saveBtn.textContent = "Apply";
  saveBtn.addEventListener("click", () => {
    const val = ta.value.trim();
    if (val === defaultText) {
      delete injectionTextOverrides[name];
      resetBtn.disabled = true;
      if (pencilBtn) pencilBtn.classList.remove("overridden");
    } else {
      injectionTextOverrides[name] = val;
      resetBtn.disabled = false;
      if (pencilBtn) pencilBtn.classList.add("overridden");
    }
    markSnapshotDirty();
    editorWrap.hidden = true;
  });
  actions.appendChild(saveBtn);

  editorWrap.appendChild(actions);
  ta.focus();
}

function setGroupValue(wrapper, value) {
  wrapper.dataset.value = value || "";
  applyResolvedOverrides();
  wrapper.querySelectorAll(".seg").forEach((seg) => {
    seg.classList.toggle("active", seg.dataset.value === (value || ""));
    seg.setAttribute("aria-checked", seg.dataset.value === (value || "") ? "true" : "false");
  });
  // Sync pencil button: visible only when an injection is active
  const editBtn = wrapper.querySelector(".inj-edit-btn");
  if (editBtn) {
    editBtn.hidden = !value;
    editBtn.title = value ? `Edit "${value}" prompt text` : "";
    editBtn.classList.toggle("overridden", !!(value && injectionTextOverrides[value] !== undefined));
  }
  // Close editor if the active injection changed away from what's being edited
  const editorWrap = wrapper.querySelector(".inj-editor-wrap");
  if (editorWrap && !editorWrap.hidden && editorWrap.dataset.editing !== value) {
    editorWrap.hidden = true;
  }
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
  // Preserve test values — these are studio-only and not persisted server-side
  const prevTestValues = {};
  for (const card of els.overlayList.querySelectorAll(".overlay-card")) {
    const tv = card.querySelector(".edit-test-value");
    if (tv && tv.value) prevTestValues[card.dataset.name] = tv.value;
  }
  els.overlayList.innerHTML = "";
  const overlays = state.context.overlays || {};
  // Sort by priority descending so top card = highest priority
  const names = Object.keys(overlays).sort((a, b) => (overlays[b].priority || 0) - (overlays[a].priority || 0));
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
        <details class="turn-verbatim-peek">
          <summary class="muted">show verbatim</summary>
          <pre class="muted">${escapeHtml((o.metadata || {}).verbatim || "")}</pre>
        </details>
      </div>` : "";
    const templateVal = (o.metadata || {}).template || "";
    card.innerHTML = `
      <summary>
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <span class="chevron">▸</span>
        <span class="name">${escapeHtml(name)}${isTurn ? ` <span class="turn-badge" title="iteration turn overlay">turn</span>` : ""}${runtimeBadge} <small class="muted overlay-priority-badge">·p${o.priority}</small></span>
        <span class="text">${escapeHtml(o.text)}</span>
        <button class="remove" type="button" title="remove">×</button>
      </summary>
      <div class="overlay-body">
        <input type="hidden" class="edit-priority" value="${o.priority}" />
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
        <div class="runtime-fields" ${runtimeMode ? "" : "hidden"}>
          <label class="overlay-edit-field" title="Wrap the runtime value in surrounding text. Use {} where the value goes.">
            <span>template</span>
            <input class="edit-template" type="text" placeholder="e.g. The topic is {}" value="${escapeHtml(templateVal)}" />
          </label>
          <label class="overlay-edit-field" title="Test value used in studio pre-generate — not persisted to the model.">
            <span>test value <small class="muted">(studio only)</small></span>
            <input class="edit-test-value" type="text" placeholder="value for testing in pre-generate…" />
          </label>
        </div>
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
    const runtimeFields = card.querySelector(".runtime-fields");
    const templateEl = card.querySelector(".edit-template");
    priorityEl.addEventListener("input", markDirty);
    textEl.addEventListener("input", markDirty);
    if (templateEl) {
      templateEl.addEventListener("input", markDirty);
      templateEl.addEventListener("change", () => saveOverlayCard(card));
      templateEl.addEventListener("blur", () => saveOverlayCard(card));
    }
    if (runtimeEl) runtimeEl.addEventListener("change", () => {
      const isRuntime = runtimeEl.value === "optional" || runtimeEl.value === "required";
      if (runtimeFields) runtimeFields.hidden = !isRuntime;
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
      markSnapshotDirty();
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
    // Drag-and-drop reordering — track whether mousedown started on handle
    const handle = card.querySelector(".drag-handle");
    let handleGrabbed = false;
    handle.addEventListener("mousedown", () => { handleGrabbed = true; });
    document.addEventListener("mouseup", () => { handleGrabbed = false; }, { passive: true });
    // Prevent details toggle when clicking the drag handle
    handle.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      if (!handleGrabbed) { e.preventDefault(); return; }
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
    });
    card.addEventListener("dragend", () => {
      handleGrabbed = false;
      card.classList.remove("dragging");
      els.overlayList.querySelectorAll(".overlay-card").forEach(c => c.classList.remove("drag-over"));
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const dragging = els.overlayList.querySelector(".dragging");
      if (dragging && dragging !== card) {
        card.classList.add("drag-over");
      }
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      const dragging = els.overlayList.querySelector(".dragging");
      if (!dragging || dragging === card) return;
      // Insert dragged card before this one
      els.overlayList.insertBefore(dragging, card);
      dragging.classList.remove("dragging");
      recalcOverlayPriorities();
    });

    els.overlayList.appendChild(card);
  }
  // Restore test values preserved before re-render
  for (const card of els.overlayList.querySelectorAll(".overlay-card")) {
    const prev = prevTestValues[card.dataset.name];
    if (prev) {
      const tv = card.querySelector(".edit-test-value");
      if (tv) tv.value = prev;
    }
  }
}

// Recalculate priorities based on DOM order (first = highest priority)
async function recalcOverlayPriorities() {
  const cards = [...els.overlayList.querySelectorAll(".overlay-card")];
  const total = cards.length;
  const promises = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const newPriority = (total - i) * 10;
    const prioInput = card.querySelector(".edit-priority");
    const badge = card.querySelector(".overlay-priority-badge");
    if (prioInput) prioInput.value = newPriority;
    if (badge) badge.textContent = `·p${newPriority}`;
    // Save to server
    const name = card.dataset.name;
    const text = card.querySelector(".edit-text")?.value ?? "";
    let metadata = {};
    try { metadata = JSON.parse(card.dataset.metadata || "{}"); } catch { /* ignore */ }
    const runtimeSel = card.querySelector(".edit-runtime");
    if (runtimeSel) {
      const v = runtimeSel.value;
      metadata = { ...(metadata || {}) };
      if (v === "optional" || v === "required") metadata.runtime = v;
      else delete metadata.runtime;
    }
    const templateInput = card.querySelector(".edit-template");
    if (templateInput) {
      metadata = { ...(metadata || {}) };
      const tmpl = templateInput.value.trim();
      if (tmpl) metadata.template = tmpl;
      else delete metadata.template;
    }
    promises.push(
      api("PUT", `/api/context/overlay/${encodeURIComponent(name)}`, {
        text, priority: newPriority, expires_at: null, metadata,
      })
    );
  }
  await Promise.all(promises);
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
  const templateInput = card.querySelector(".edit-template");
  if (templateInput) {
    metadata = { ...(metadata || {}) };
    const tmpl = templateInput.value.trim();
    if (tmpl) metadata.template = tmpl;
    else delete metadata.template;
  }
  // Persist updated metadata back to the card's data attribute
  card.dataset.metadata = JSON.stringify(metadata);
  const p = api("PUT", `/api/context/overlay/${encodeURIComponent(name)}`, {
    text, priority, expires_at: null, metadata,
  }).then(() => {
    card.classList.remove("dirty");
    if (statusEl) statusEl.textContent = "saved";
    markSnapshotDirty();
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
  renderRoutes(state);
  renderInjections(state);
  renderBase(state);
  renderOverlays(state);
  renderConfigInputs(state);
}

// Last turn context — what we sent and what came back. Used to give the
// compaction LLM the surrounding context for the user's follow-up.
const lastTurnContext = { user_prompt: "", assistant_output: "" };

async function saveResponseAsOverlay() {
  // Use edited raw text if the user modified it, otherwise fall back to original
  const rawEdited = (els.outputRaw.value || "").trim();
  const text = rawEdited || (lastTurnContext.assistant_output || "").trim();
  if (!text) return;
  const btn = els.saveResponseOverlay;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "saving…";
  try {
    await flushOverlayEdits();
    await api("POST", "/api/iterate", {
      user_prompt: lastTurnContext.user_prompt,
      assistant_output: text,
      user_response: text,
      mode: "verbatim",
    });
    await refresh();
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    btn.textContent = orig;
    syncSaveResponseButton();
  }
}

function syncSaveResponseButton() {
  if (!els.saveResponseOverlay) return;
  const hasOutput = !!((lastTurnContext.assistant_output || "").trim());
  const hasEdited = !!((els.outputRaw.value || "").trim());
  els.saveResponseOverlay.disabled = !(hasOutput || hasEdited);
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
  els.outputRaw.value = display;
  if (text && text.length) {
    els.outputRendered.innerHTML = renderMarkdown(text);
  } else {
    els.outputRendered.textContent = display;
  }
}

function setOutputEditable(editable) {
  els.outputRaw.readOnly = !editable;
}

function renderOutput(result) {
  setOutputText(result.text, "(empty response)");
  els.outRoute.textContent = `route: ${result.route}`;
  els.outAccepted.textContent = result.accepted ? "accepted" : "rejected";
  els.outAccepted.className = "pill " + (result.accepted ? "ok" : "bad");

  // Rejection feedback banner
  const banner = document.getElementById("reject-banner");
  if (!result.accepted) {
    const t2 = result.trace || {};
    const meta = t2.metadata || {};
    const attempts = t2.attempts || [];
    const reasons = attempts
      .filter(a => !a.accepted && a.reject_reason)
      .map((a, i) => `Attempt #${i + 1}: ${a.reject_reason}`);
    const topReason = meta.reject_reason || (reasons.length ? reasons[reasons.length - 1].replace(/^Attempt #\d+: /, "") : "output policy validation failed");
    const retryCount = attempts.length;
    banner.innerHTML = `<div class="reject-title">Output rejected</div>`
      + `<div>${escapeHtml(topReason)}</div>`
      + (retryCount > 1 ? `<div class="reject-detail">${retryCount} attempt${retryCount > 1 ? "s" : ""} made — all failed validation. ${reasons.length ? reasons.map(escapeHtml).join("; ") : ""}</div>` : "")
      + `<div class="reject-detail">Adjust the output policy or prompt to fix. Enable Debug Trace for full attempt details.</div>`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
    banner.innerHTML = "";
  }

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

let pendingExportData = null;

function setExportData(data) {
  pendingExportData = data;
  const text = data ? JSON.stringify(data, null, 2) : "";
  els.exportCode.dataset.raw = text;
  els.exportCode.classList.remove("py-hl");
  els.exportCode.textContent = text;
}

function setExportError(msg) {
  pendingExportData = null;
  els.exportCode.dataset.raw = msg;
  els.exportCode.classList.remove("py-hl");
  els.exportCode.textContent = msg;
}

function suggestExportName() {
  if (currentSnapshotName) return currentSnapshotName;
  const route = els.routeSelect.value || "";
  return route ? `${route}_export` : "export";
}

async function exportJson() {
  const route = els.routeSelect.value || null;
  const injections = selectedInjections();
  els.exportBtn.disabled = true;
  try {
    const sectionOverrides = { ...(pendingSectionOverrides || {}) };
    if (stagedSections) {
      const sep = stagedSections.separator || "\n\n";
      sectionOverrides.system = stagedSections.system.join(sep);
      sectionOverrides.user = stagedSections.user.join(sep);
    }
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route,
        injections,
        include_overlays: true,
        section_overrides: sectionOverrides,
        injection_text_overrides: injectionTextOverrides,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      setExportError(`// export failed (${res.status})\n${detail}`);
    } else {
      const { data, dir } = await res.json();
      setExportData(data);
      if (dir && els.exportDir) els.exportDir.textContent = dir;
    }
    if (!els.exportName.value.trim()) els.exportName.value = suggestExportName();
    els.exportModal.hidden = false;
    refreshSavedExports();
  } catch (err) {
    setExportError(`// export failed\n${err}`);
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
  if (!pendingExportData) return;
  const name = (els.exportName.value.trim() || suggestExportName()).replace(/[^A-Za-z0-9_.-]+/g, "_") || "export";
  const blob = new Blob([JSON.stringify(pendingExportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function saveExport() {
  const name = els.exportName.value.trim();
  if (!name) { els.exportName.focus(); return; }
  if (!pendingExportData) return;
  els.exportSave.disabled = true;
  try {
    const snapshot = (typeof captureSnapshotState === "function")
      ? captureSnapshotState()
      : null;
    await api("PUT", `/api/exports/${encodeURIComponent(name)}`, { data: pendingExportData, snapshot });
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
      const snapshotBtn = row.has_snapshot
        ? `<button type="button" class="ghost small" data-act="load-snapshot" title="Restore the studio state captured when this export was saved">Load snapshot</button>`
        : "";
      card.innerHTML = `
        <div class="item-head">
          <span class="item-name">${escapeHtml(row.name)}${row.has_snapshot ? ` <small class="muted">· snapshot</small>` : ""}</span>
          <span class="item-date">${escapeHtml(saved.toLocaleString())}</span>
        </div>
        <div class="item-actions">
          <button type="button" class="primary small" data-act="load">Load</button>
          ${snapshotBtn}
          <button type="button" class="ghost small" data-act="delete">Delete</button>
        </div>`;
      card.querySelector("[data-act='load']").addEventListener("click", async () => {
        try {
          const entry = await api("GET", `/api/exports/${encodeURIComponent(row.name)}`);
          setExportData(entry.data || null);
          els.exportName.value = row.name;
        } catch (err) { alert("Load failed: " + err.message); }
      });
      const scEl = card.querySelector("[data-act='load-snapshot']");
      if (scEl) scEl.addEventListener("click", async () => {
        try {
          const entry = await api("GET", `/api/snapshots/${encodeURIComponent(row.name)}`);
          await applySnapshotState(entry.state || {});
          currentSnapshotName = row.name;
          snapshotDirty = false;
          syncSnapshotIndicator();
          els.exportModal.hidden = true;
        } catch (err) { alert("Snapshot load failed: " + err.message); }
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
  setOutputEditable(false);
  try {
    await flushOverlayEdits();
    const request = {
      mode: els.routeSelect.value || null,
      inputs: { input: els.inputText.value },
      injections: selectedInjections(),
      debug: els.debug.checked,
      config_overrides: readConfigOverrides(),
      injection_text_overrides: injectionTextOverrides,
    };
    if (pendingSectionOverrides) request.section_overrides = pendingSectionOverrides;
    if (stagedSections) {
      const sep = stagedSections.separator || "\n\n";
      const slotValues = readRuntimeSlotValues();
      const resolveSlots = (sections) => {
        const out = [];
        for (const text of sections) {
          const slot = (stagedSections.runtimeSlots || {})[text];
          if (slot) {
            const val = (slotValues[slot.name] || "").trim();
            if (!val && slot.mode === "optional") continue; // drop empty optional
            if (!val && slot.mode === "required") {
              throw new Error(`Runtime slot "${slot.name}" is required`);
            }
            // Apply template if set, otherwise use raw value
            const tmpl = slot.template || "{}";
            out.push(tmpl.replace("{}", val));
          } else {
            out.push(text);
          }
        }
        return out;
      };
      const system = resolveSlots(stagedSections.system);
      const user = resolveSlots(stagedSections.user);
      request.section_overrides = {
        ...(request.section_overrides || {}),
        system: system.join(sep),
        user: user.join(sep),
      };
    }
    activateOutputTab("output");
    const conn = getConnection();
    const useBrowserDirect = !!conn.model;
    if (els.stream.checked) {
      var result = useBrowserDirect
        ? await generateBrowserDirect(request, conn, { stream: true })
        : await generateStream(request);
    } else if (useBrowserDirect) {
      var result = await generateBrowserDirect(request, conn, { stream: false });
    } else {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15_000);
      try {
        var result = await apiWithSignal("POST", "/api/generate", request, abort.signal);
      } catch (err) {
        if (err.name === "AbortError") throw new Error("Generation timed out (15 s)");
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    if (stagedSections) clearStage();
    lastTurnContext.user_prompt = els.inputText.value || "";
    lastTurnContext.assistant_output = result.text || "";
    syncSaveResponseButton();
    renderOutput(result);
    setOutputEditable(true);
    els.exportBtn.hidden = false;
    await refresh();
  } catch (err) {
    setOutputText("", `ERROR: ${err.message}`);
  } finally {
    els.generate.disabled = false;
  }
}

// Browser-direct path: server resolves the prompt, the browser calls the
// user's local LLM, then the server cleans/validates the output. Retries
// (from route config) loop here; streaming forwards deltas straight to the UI.
async function generateBrowserDirect(request, conn, { stream }) {
  const resolved = await api("POST", "/api/resolve", request);
  const providerReq = {
    ...resolved.provider_request,
    model: conn.model || resolved.provider_request.model,
  };
  let attempts = [];
  const retries = Math.max(0, resolved.retries || 0);
  let lastProcess = null;

  for (let i = 0; i <= retries; i++) {
    let llm;
    if (stream) {
      let buf = "";
      llm = await ollamaStream(conn, providerReq, (piece) => {
        buf += piece;
        setOutputText(buf, "Generating…");
      });
    } else {
      llm = await ollamaGenerate(conn, providerReq);
    }
    lastProcess = await api("POST", "/api/process", {
      raw_text: llm.text,
      output_policy: resolved.output_policy,
      route: resolved.route,
      usage: llm.usage || null,
      timing: llm.timing || null,
      trace_scaffolding: resolved.trace_scaffolding,
      debug: request.debug,
      attempt_history: attempts,
    });
    attempts = lastProcess.attempts || attempts;
    if (lastProcess.accepted) break;
  }
  return {
    text: lastProcess.text,
    accepted: lastProcess.accepted,
    route: resolved.route,
    usage: lastProcess.usage,
    timing: lastProcess.timing,
    trace: lastProcess.trace,
  };
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
// Re-enable save button when user edits raw output
els.outputRaw.addEventListener("input", syncSaveResponseButton);

function syncDebugPanel() {
  document.querySelector("main.grid").classList.toggle("no-debug", !els.debug.checked);
}
els.debug.addEventListener("change", syncDebugPanel);
syncDebugPanel();

async function saveBase() {
  await flushOverlayEdits();
  await api("PUT", "/api/context/base", { base: els.baseText.value, fields: {} });
  markSnapshotDirty();
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

// --- snapshots (full app-state save/load) ---------------------------
// A snapshot is everything the user can set up: base context + overlays +
// route + injections + draft prompt + generation overrides.
// Captured as an opaque blob and rehydrated on load.

function captureSnapshotState() {
  const overlays = [];
  for (const card of els.overlayList.querySelectorAll(".overlay-card")) {
    const name = card.dataset.name;
    const text = (card.querySelector(".edit-text") || {}).value || "";
    const priority = parseInt(
      (card.querySelector(".edit-priority") || {}).value || "0", 10
    ) || 0;
    let metadata = {};
    try { metadata = JSON.parse(card.dataset.metadata || "{}"); } catch { /* ignore */ }
    if (name) overlays.push({ name, text, priority, metadata });
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
    injection_text_overrides: { ...injectionTextOverrides },
    input: els.inputText.value,
    config_overrides: cfg,
  };
}

let currentSnapshotName = "";
let snapshotDirty = false;
let pendingSectionOverrides = null;

function syncSnapshotIndicator() {
  const indicator = $("snapshot-indicator");
  const nameEl = $("snapshot-name");
  const dirtyEl = $("snapshot-dirty");
  const saveBtn = $("snapshot-quick-save");
  if (!indicator) return;
  if (currentSnapshotName) {
    nameEl.textContent = currentSnapshotName;
    nameEl.title = currentSnapshotName;
    indicator.hidden = false;
    dirtyEl.hidden = !snapshotDirty;
    saveBtn.hidden = !snapshotDirty;
  } else {
    indicator.hidden = true;
  }
}

function markSnapshotDirty() {
  if (!currentSnapshotName) return;
  if (snapshotDirty) return;
  snapshotDirty = true;
  syncSnapshotIndicator();
}

async function quickSaveSnapshot() {
  if (!currentSnapshotName) return;
  const btn = $("snapshot-quick-save");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    await flushOverlayEdits();
    const state = captureSnapshotState();
    await api("PUT", `/api/snapshots/${encodeURIComponent(currentSnapshotName)}`, { state });
    snapshotDirty = false;
    syncSnapshotIndicator();
  } catch (err) {
    alert("Save failed: " + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

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
      injection_text_overrides: injectionTextOverrides,
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

async function applySnapshotState(state) {
  if (!state || typeof state !== "object") return;
  await api("DELETE", "/api/context/overlays");
  await api("PUT", "/api/context/base", { base: state.base || "", fields: {} });
  for (const o of state.overlays || []) {
    if (!o || !o.name) continue;
    await api("PUT", `/api/context/overlay/${encodeURIComponent(o.name)}`, {
      text: o.text || "",
      priority: typeof o.priority === "number" ? o.priority : 0,
      expires_at: null,
      metadata: o.metadata || {},
    });
  }
  await refresh();
  if (state.route !== undefined) {
    els.routeSelect.value = state.route || "";
    syncRouteDescription();
  }
  if (Array.isArray(state.injections)) setSelectedInjections(state.injections);
  // Restore injection text overrides from snapshot
  injectionTextOverrides = { ...(state.injection_text_overrides || {}) };
  if (state.input !== undefined) els.inputText.value = state.input;
  for (const k of Object.keys(els.cfg)) els.cfg[k].value = "";
  for (const [k, v] of Object.entries(state.config_overrides || {})) {
    if (els.cfg[k]) els.cfg[k].value = v;
  }
  // Reset output view from previous runs
  setOutputText("", "(no generation yet)");
  setOutputEditable(false);
  const rejectBanner = document.getElementById("reject-banner");
  if (rejectBanner) { rejectBanner.hidden = true; rejectBanner.innerHTML = ""; }
  els.outRoute.textContent = "route: —";
  els.outAccepted.textContent = "—";
  els.outAccepted.className = "pill";
  els.outTiming.textContent = "—";
  els.outUsage.textContent = "—";
  els.exportBtn.hidden = true;
  lastTurnContext.user_prompt = "";
  lastTurnContext.assistant_output = "";
  syncSaveResponseButton();
  setView("rendered");
  // Clear debug trace
  if (els.traceSystem) els.traceSystem.textContent = "";
  if (els.traceUser) els.traceUser.textContent = "";
  if (els.traceActive) els.traceActive.textContent = "";
  if (els.traceAttempts) els.traceAttempts.innerHTML = "";
}

function openSnapshotsDialog() {
  const node = document.createElement("div");
  node.className = "dialog-form";
  node.innerHTML = `
    <label>Save current state as
      <input type="text" id="dlg-scn-title" placeholder="e.g. Working setup for billing triage" autocomplete="off" />
    </label>
    <div class="dialog-actions">
      <button type="button" class="primary" data-act="save">Save</button>
    </div>
    <div class="subhead" style="margin-top:14px"><span>Saved snapshots</span></div>
    <div class="library-list" data-role="list"><div class="library-empty">Loading…</div></div>
  `;
  openModal("Snapshots", node);
  const title = node.querySelector("#dlg-scn-title");
  title.focus();
  const list = node.querySelector("[data-role='list']");
  const refreshList = async () => {
    try {
      const res = await api("GET", "/api/snapshots");
      renderSnapshotList(list, res.snapshots || []);
    } catch (err) {
      list.innerHTML = `<div class="library-empty">Failed to load: ${escapeHtml(err.message)}</div>`;
    }
  };
  const submit = async () => {
    const name = title.value.trim();
    if (!name) { title.focus(); return; }
    try {
      await flushOverlayEdits();
      const state = captureSnapshotState();
      await api("PUT", `/api/snapshots/${encodeURIComponent(name)}`, { state });
      currentSnapshotName = name;
      snapshotDirty = false;
      syncSnapshotIndicator();
      title.value = "";
      await refreshList();
    } catch (err) { alert("Save failed: " + err.message); }
  };
  node.querySelector("[data-act='save']").addEventListener("click", submit);
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  refreshList();
}

function renderSnapshotList(host, items) {
  host.innerHTML = "";
  if (!items.length) {
    host.innerHTML = `<div class="library-empty">No saved snapshots yet.</div>`;
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
        const row = await api("GET", `/api/snapshots/${encodeURIComponent(item.name)}`);
        await applySnapshotState(row.state || {});
        currentSnapshotName = item.name;
        snapshotDirty = false;
        syncSnapshotIndicator();
        closeModal();
      } catch (err) { alert("Load failed: " + err.message); }
    });
    card.querySelector("[data-act='delete']").addEventListener("click", async () => {
      if (!confirm(`Delete snapshot "${item.name}"?`)) return;
      try {
        await api("DELETE", `/api/snapshots/${encodeURIComponent(item.name)}`);
        card.remove();
        if (!host.querySelector(".library-item")) {
          host.innerHTML = `<div class="library-empty">No saved snapshots yet.</div>`;
        }
      } catch (err) { alert("Delete failed: " + err.message); }
    });
    host.appendChild(card);
  }
}

async function addOverlay() {
  const name = els.overlayName.value.trim();
  if (!name) return alert("overlay needs a name");
  const runtimeMode = els.overlayRuntime ? els.overlayRuntime.value : "";
  const isRuntime = runtimeMode === "optional" || runtimeMode === "required";
  const text = els.overlayText.value.trim();
  if (!text && !isRuntime) return alert("overlay needs text");
  // Auto-calculate priority: new overlay gets highest priority (top of list)
  const existingCards = els.overlayList.querySelectorAll(".overlay-card");
  const maxPriority = [...existingCards].reduce((max, c) => {
    const p = parseInt(c.querySelector(".edit-priority")?.value || "0", 10);
    return Math.max(max, p);
  }, 0);
  const priority = maxPriority + 10;
  const metadata = isRuntime ? { runtime: runtimeMode } : {};
  if (isRuntime && els.overlayTemplate) {
    const tmpl = els.overlayTemplate.value.trim();
    if (tmpl) metadata.template = tmpl;
  }
  await flushOverlayEdits();
  await api("PUT", `/api/context/overlay/${encodeURIComponent(name)}`, {
    text, priority, expires_at: null, metadata,
  });
  els.overlayName.value = "";
  els.overlayText.value = "";
  if (els.overlayRuntime) els.overlayRuntime.value = "";
  if (els.overlayTemplate) { els.overlayTemplate.value = ""; els.overlayTemplate.hidden = true; }
  markSnapshotDirty();
  await refresh();
}

async function clearOverlays() {
  // No point flushing — we're about to wipe them all.
  overlayPendingSaves.clear();
  await api("DELETE", "/api/context/overlays");
  markSnapshotDirty();
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
  if (!aboutModal.hidden) {
    if (e.key === "Escape") closeAbout();
    if (e.key === "ArrowRight" && aboutIdx < aboutSlides.length - 1) goToSlide(aboutIdx + 1);
    if (e.key === "ArrowLeft" && aboutIdx > 0) goToSlide(aboutIdx - 1);
  }
});

// ── About / Tour slideshow ──────────────────────────────────────
const aboutModal = document.getElementById("about-modal");
const aboutSlides = aboutModal.querySelectorAll(".about-slide");
const aboutDiagram = aboutModal.querySelector(".slide-diagram");
const aboutDiagramEls = aboutDiagram.querySelectorAll("[data-step]");
const aboutDots = aboutModal.querySelector(".about-dots");
const aboutPrev = document.getElementById("about-prev");
const aboutNext = document.getElementById("about-next");
const tourBlocks = aboutModal.querySelectorAll(".tour-block, .tour-block-divider");
const tourEmpty = aboutModal.querySelector(".tour-prompt-empty");
const tourScroll = aboutModal.querySelector(".tour-prompt-scroll");
let aboutIdx = 0;
let prevTourStep = -1;

// Slide index → which diagram step to highlight up to
// 0 = overview (all), 1 = base+overlays, 2 = route, 3 = injections,
// 4 = generation/output, 5 = export, 6 = ensemble
const slideToStep = [0, 1, 2, 3, 4, 5, 6];

// Build dot indicators
for (let i = 0; i < aboutSlides.length; i++) {
  const dot = document.createElement("button");
  dot.className = "about-dot" + (i === 0 ? " active" : "");
  dot.type = "button";
  dot.addEventListener("click", () => goToSlide(i));
  aboutDots.appendChild(dot);
}

function updateDiagram(step) {
  aboutDiagram.classList.toggle("step-all", step === 0);
  for (const el of aboutDiagramEls) {
    const s = parseInt(el.dataset.step, 10);
    el.classList.toggle("lit", step > 0 && s <= step);
    el.classList.toggle("lit-active", step > 0 && s === step);
  }
}

function updateTourPrompt(step) {
  const advancing = step > prevTourStep;
  // Show/hide empty state
  if (tourEmpty) tourEmpty.hidden = step >= 1;
  // Show/hide blocks based on their data-show-at threshold
  for (const block of tourBlocks) {
    const showAt = parseInt(block.dataset.showAt, 10);
    const shouldShow = step >= showAt;
    const wasVisible = block.classList.contains("visible");
    block.classList.toggle("visible", shouldShow);
    // Flash newly appearing blocks
    if (shouldShow && !wasVisible && advancing) {
      block.classList.remove("just-added");
      void block.offsetWidth; // reflow to restart animation
      block.classList.add("just-added");
    }
    if (!shouldShow) {
      block.classList.remove("just-added");
    }
  }
  // Auto-scroll to bottom when new blocks appear
  if (advancing && tourScroll) {
    requestAnimationFrame(() => {
      tourScroll.scrollTop = tourScroll.scrollHeight;
    });
  }
  prevTourStep = step;
}

function goToSlide(idx) {
  aboutSlides[aboutIdx].classList.remove("active");
  aboutDots.children[aboutIdx].classList.remove("active");
  aboutIdx = idx;
  aboutSlides[aboutIdx].classList.add("active");
  aboutDots.children[aboutIdx].classList.add("active");
  aboutPrev.disabled = aboutIdx === 0;
  aboutNext.disabled = aboutIdx === aboutSlides.length - 1;
  const step = slideToStep[aboutIdx] ?? 4;
  updateDiagram(step);
  updateTourPrompt(step);
}

aboutPrev.addEventListener("click", () => { if (aboutIdx > 0) goToSlide(aboutIdx - 1); });
aboutNext.addEventListener("click", () => { if (aboutIdx < aboutSlides.length - 1) goToSlide(aboutIdx + 1); });

function openAbout() {
  prevTourStep = -1;
  goToSlide(0);
  aboutModal.hidden = false;
}
function closeAbout() {
  aboutModal.hidden = true;
}

aboutModal.addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close-about")) closeAbout();
});
document.getElementById("about-btn").addEventListener("click", openAbout);

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
  openModal("Load Example Snapshot", node);
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
    injectionTextOverrides = {};
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
    btn.textContent = "View Examples";
    currentSnapshotName = "";
    snapshotDirty = false;
    syncSnapshotIndicator();
  }
}

$("example-btn").addEventListener("click", openExamplePicker);
$("snapshots-btn").addEventListener("click", openSnapshotsDialog);
$("snapshot-quick-save").addEventListener("click", quickSaveSnapshot);
els.saveResponseOverlay.addEventListener("click", saveResponseAsOverlay);

// Dirty-tracking: mark snapshot dirty when user changes key inputs
for (const el of [els.baseText, els.inputText]) {
  el.addEventListener("input", markSnapshotDirty);
}
els.routeSelect.addEventListener("change", markSnapshotDirty);
for (const el of Object.values(els.cfg)) {
  el.addEventListener("input", markSnapshotDirty);
}

// --- pre-generate staging ------------------------------------------
// Pre-generate resolves the prompt into per-section cards the user can
// drag to reorder. Clicking Generate while staged sends the reordered
// concatenation via `section_overrides` (one-shot, not persisted).
let stagedSections = null;   // { system: string[], user: string[], separator: string }

function activateOutputTab(name) {
  document.querySelectorAll(".output-tab").forEach((t) => {
    t.setAttribute("aria-selected", t.dataset.outputTab === name ? "true" : "false");
  });
  document.querySelectorAll(".output-panel-body").forEach((p) => {
    p.hidden = p.dataset.outputTab !== name;
  });
}

function clearStage() {
  stagedSections = null;
  const badge = $("stage-tab-badge");
  if (badge) badge.hidden = true;
  // Empty-root hint shown when the stage tab has no staged sections.
  const emptyRoot = document.querySelector(".stage-empty-root");
  if (emptyRoot) emptyRoot.hidden = false;
  document.querySelectorAll(".stage-group").forEach((g) => (g.style.display = "none"));
}

function renderStage() {
  if (!els.promptStage || !stagedSections) return;
  const emptyRoot = document.querySelector(".stage-empty-root");
  if (emptyRoot) emptyRoot.hidden = true;
  document.querySelectorAll(".stage-group").forEach((g) => (g.style.display = ""));
  const badge = $("stage-tab-badge");
  if (badge) badge.hidden = false;

  const slots = stagedSections.runtimeSlots || {};

  for (const group of ["system", "user"]) {
    const list = els.promptStage.querySelector(`[data-list='${group}']`);
    const empty = els.promptStage.querySelector(`[data-empty='${group}']`);
    if (!list || !empty) continue;
    list.innerHTML = "";
    const items = stagedSections[group] || [];
    empty.hidden = items.length > 0;
    items.forEach((text, idx) => {
      const card = document.createElement("div");
      card.draggable = true;
      card.dataset.group = group;
      card.dataset.index = String(idx);

      const slot = slots[text];
      if (slot) {
        // Runtime slot — render with an input field
        card.className = "stage-card stage-slot";
        card.dataset.slotName = slot.name;
        card.dataset.slotMode = slot.mode;
        const modeLabel = slot.mode === "required" ? "required" : "optional";
        // Pre-fill from overlay card's test value if available
        const overlayCard = els.overlayList.querySelector(`.overlay-card[data-name="${slot.name}"]`);
        const testVal = overlayCard ? (overlayCard.querySelector(".edit-test-value") || {}).value || "" : "";
        card.innerHTML =
          `<span class="handle">⋮⋮</span>` +
          `<span class="stage-slot-body">` +
            `<span class="stage-slot-header">` +
              `<span class="stage-slot-name">{${escapeHtml(slot.name)}}</span>` +
              `<span class="stage-slot-mode ${slot.mode}">${modeLabel}</span>` +
            `</span>` +
            `<input class="stage-slot-input" type="text" placeholder="${modeLabel} runtime value…" value="${escapeHtml(testVal)}" />` +
          `</span>`;
      } else {
        // Regular section — plain text card
        card.className = "stage-card";
        card.innerHTML = `<span class="handle">⋮⋮</span><span class="body"></span>`;
        card.querySelector(".body").textContent = text;
      }
      list.appendChild(card);
    });
  }
  wireStageDrag();
}

function readRuntimeSlotValues() {
  const values = {};
  if (!els.promptStage) return values;
  for (const card of els.promptStage.querySelectorAll(".stage-slot")) {
    const name = card.dataset.slotName;
    const input = card.querySelector(".stage-slot-input");
    if (name && input) values[name] = input.value;
  }
  return values;
}

function wireStageDrag() {
  const cards = els.promptStage.querySelectorAll(".stage-card");
  let draggedEl = null;
  cards.forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggedEl = card;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      cards.forEach((c) => c.classList.remove("drop-before", "drop-after"));
      draggedEl = null;
    });
    card.addEventListener("dragover", (e) => {
      if (!draggedEl) return;
      if (draggedEl.dataset.group !== card.dataset.group) return; // only reorder within same group
      if (draggedEl === card) return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      card.classList.toggle("drop-before", before);
      card.classList.toggle("drop-after", !before);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", (e) => {
      if (!draggedEl || draggedEl === card) return;
      if (draggedEl.dataset.group !== card.dataset.group) return;
      e.preventDefault();
      const group = card.dataset.group;
      const arr = stagedSections[group];
      const from = parseInt(draggedEl.dataset.index, 10);
      let to = parseInt(card.dataset.index, 10);
      const [item] = arr.splice(from, 1);
      if (card.classList.contains("drop-after")) to = to + (from < to ? 0 : 1);
      else to = to + (from < to ? -1 : 0);
      arr.splice(to, 0, item);
      renderStage();
    });
  });
}

async function preGenerate() {
  const btn = $("pregenerate-btn");
  btn.disabled = true;
  try {
    await flushOverlayEdits();
    const body = {
      mode: els.routeSelect.value || null,
      inputs: { input: els.inputText.value },
      injections: selectedInjections(),
      section_overrides: pendingSectionOverrides || {},
      injection_text_overrides: injectionTextOverrides,
    };
    const res = await api("POST", "/api/prompt/resolve", body);
    // Build a lookup of runtime slot info keyed by placeholder pattern
    const runtimeSlotMap = {};
    for (const slot of res.runtime_slots || []) {
      runtimeSlotMap[`{${slot.name}}`] = slot;
    }
    stagedSections = {
      system: Array.isArray(res.system_sections) ? [...res.system_sections] : [],
      user: Array.isArray(res.user_sections) ? [...res.user_sections] : [],
      separator: res.separator || "\n\n",
      runtimeSlots: runtimeSlotMap,
    };
    renderStage();
    activateOutputTab("stage");
    // Reveal generation controls after pre-generate
    els.stream.closest("label").hidden = false;
    els.debug.closest("label").hidden = false;
    document.querySelector(".gen-controls-sep").hidden = false;
  } catch (err) {
    alert("Pre-generate failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

$("pregenerate-btn").addEventListener("click", preGenerate);
els.generate.addEventListener("click", generate);
if (els.stageReset) els.stageReset.addEventListener("click", clearStage);
document.querySelectorAll(".output-tab").forEach((t) => {
  t.addEventListener("click", () => activateOutputTab(t.dataset.outputTab));
});
// Initial state: no staged sections -> show hint in pre-generate tab.
document.querySelectorAll(".stage-group").forEach((g) => (g.style.display = "none"));
els.editPromptBtn.addEventListener("click", openEditPrompt);
els.editApply.addEventListener("click", applyEditPrompt);
els.editClear.addEventListener("click", () => { clearSectionOverride(); closeEditPrompt(); });
els.editReset.addEventListener("click", resetEditPrompt);
els.editPromptModal.querySelectorAll("[data-close-edit-prompt]").forEach((el) =>
  el.addEventListener("click", closeEditPrompt)
);
els.clearSectionOverride.addEventListener("click", (e) => { e.preventDefault(); clearSectionOverride(); });
els.exportBtn.addEventListener("click", exportJson);
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
if (els.overlayRuntime) {
  els.overlayRuntime.addEventListener("change", () => {
    const isRuntime = els.overlayRuntime.value === "optional" || els.overlayRuntime.value === "required";
    els.overlayTemplate.hidden = !isRuntime;
    if (!isRuntime) els.overlayTemplate.value = "";
  });
}
els.clearOverlays.addEventListener("click", clearOverlays);
$("suggest-overlays").addEventListener("click", suggestOverlays);
els.routeSelect.addEventListener("change", syncRouteDescription);
els.inputText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    if (stagedSections) generate();
    else preGenerate();
  }
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

// --- custom routes --------------------------------------------------

let editingCustomRoute = null;

function openCustomRouteModal(spec) {
  editingCustomRoute = spec ? spec.name : null;
  const title = document.getElementById("custom-route-title");
  if (title) title.textContent = spec ? `Edit custom route: ${spec.name}` : "New custom route";
  els.crName.value = spec?.name || "";
  els.crName.disabled = !!spec;
  els.crDescription.value = spec?.description || "";
  els.crSystem.value = spec?.system || "";
  els.crUserTemplate.value = spec?.user_template || "{input}";
  els.crPriority.value = spec?.priority ?? 0;
  els.crOverrides.value = spec?.generation_overrides && Object.keys(spec.generation_overrides).length
    ? JSON.stringify(spec.generation_overrides) : "";
  populatePolicyEditor(spec?.output_policy || {});
  els.crError.hidden = true;
  els.crError.textContent = "";
  els.crDelete.hidden = !spec;
  els.customRouteModal.hidden = false;
  setTimeout(() => (spec ? els.crSystem : els.crName).focus(), 0);
}

function closeCustomRouteModal() {
  els.customRouteModal.hidden = true;
  editingCustomRoute = null;
}

function showCustomRouteError(msg) {
  els.crError.textContent = msg;
  els.crError.hidden = false;
}

function parseJsonField(text, label) {
  const trimmed = (text || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw new Error("must be a JSON object");
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

// --- interactive policy editor helpers --------------------------------

function populatePolicyEditor(policy) {
  const p = policy || {};
  $("pol-min-length").value = p.min_length != null ? p.min_length : "";
  $("pol-max-length").value = p.max_length != null ? p.max_length : "";
  $("pol-collapse-ws").checked = p.collapse_whitespace !== false; // default true
  $("pol-append-suffix").value = p.append_suffix || "";
  $("pol-strip-prefixes").value = (p.strip_prefixes || []).join("\n");
  $("pol-strip-patterns").value = (p.strip_patterns || []).join("\n");
  $("pol-require-patterns").value = (p.require_patterns || []).join("\n");
  $("pol-forbidden-subs").value = (p.forbidden_substrings || []).join("\n");
  $("pol-forbidden-pats").value = (p.forbidden_patterns || []).join("\n");
}

function readPolicyEditor() {
  const out = {};
  const minLen = $("pol-min-length").value.trim();
  const maxLen = $("pol-max-length").value.trim();
  if (minLen !== "") out.min_length = parseInt(minLen, 10);
  if (maxLen !== "") out.max_length = parseInt(maxLen, 10);
  if (!$("pol-collapse-ws").checked) out.collapse_whitespace = false;
  const suffix = $("pol-append-suffix").value.trim();
  if (suffix) out.append_suffix = suffix;
  const lines = (id) => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const stripPrefixes = lines("pol-strip-prefixes");
  const stripPatterns = lines("pol-strip-patterns");
  const requirePatterns = lines("pol-require-patterns");
  const forbiddenSubs = lines("pol-forbidden-subs");
  const forbiddenPats = lines("pol-forbidden-pats");
  if (stripPrefixes.length) out.strip_prefixes = stripPrefixes;
  if (stripPatterns.length) out.strip_patterns = stripPatterns;
  if (requirePatterns.length) out.require_patterns = requirePatterns;
  if (forbiddenSubs.length) out.forbidden_substrings = forbiddenSubs;
  if (forbiddenPats.length) out.forbidden_patterns = forbiddenPats;
  return out;
}

async function saveCustomRoute() {
  const name = (els.crName.value || "").trim();
  if (!name) { showCustomRouteError("name required"); return; }
  let overrides;
  try {
    overrides = parseJsonField(els.crOverrides.value, "sampling overrides");
  } catch (e) {
    showCustomRouteError(e.message);
    return;
  }
  const policy = readPolicyEditor();
  const body = {
    description: els.crDescription.value || "",
    system: els.crSystem.value || "",
    user_template: els.crUserTemplate.value || "{input}",
    priority: parseInt(els.crPriority.value || "0", 10) || 0,
    generation_overrides: overrides,
    output_policy: policy,
  };
  try {
    await api("PUT", `/api/routes/custom/${encodeURIComponent(name)}`, body);
  } catch (e) {
    showCustomRouteError(e.message);
    return;
  }
  closeCustomRouteModal();
  const state = await api("GET", "/api/state");
  renderRoutes(state);
  els.routeSelect.value = name;
  syncRouteDescription();
}

async function deleteCustomRoute() {
  const name = editingCustomRoute || els.routeSelect.value;
  if (!name || !routeIsCustom[name]) return;
  if (!confirm(`Delete custom route "${name}"?`)) return;
  try {
    await api("DELETE", `/api/routes/custom/${encodeURIComponent(name)}`);
  } catch (e) {
    showCustomRouteError(e.message);
    return;
  }
  closeCustomRouteModal();
  const state = await api("GET", "/api/state");
  renderRoutes(state);
  els.routeSelect.value = "";
  syncRouteDescription();
}

async function openEditSelectedCustomRoute() {
  const name = els.routeSelect.value;
  if (!name || !routeIsCustom[name]) return;
  try {
    const row = await api("GET", `/api/routes/custom/${encodeURIComponent(name)}`);
    openCustomRouteModal(row.spec);
  } catch (e) {
    alert(`Failed to load route: ${e.message}`);
  }
}

if (els.newCustomRouteBtn) els.newCustomRouteBtn.addEventListener("click", () => openCustomRouteModal(null));
if (els.editCustomRouteBtn) els.editCustomRouteBtn.addEventListener("click", openEditSelectedCustomRoute);
if (els.deleteCustomRouteBtn) els.deleteCustomRouteBtn.addEventListener("click", deleteCustomRoute);
if (els.crSave) els.crSave.addEventListener("click", saveCustomRoute);
if (els.crDelete) els.crDelete.addEventListener("click", deleteCustomRoute);
if (els.customRouteModal) {
  els.customRouteModal.querySelectorAll("[data-close-custom-route]").forEach((el) =>
    el.addEventListener("click", closeCustomRouteModal)
  );
}

refresh().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<div style="background:#5b1c1c;color:#fff;padding:10px">Failed to load state: ${err.message}</div>`);
});
