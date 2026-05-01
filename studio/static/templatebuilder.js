const SECTION_KEYS = [
  "base_context",
  "personas",
  "sentiment",
  "static_injections",
  "runtime_injections",
  "output_prompt_directions",
  "examples",
  "prompt_endings",
];

const SECTION_LABELS = {
  base_context: "Base Context",
  personas: "Personas",
  sentiment: "Sentiment Contexts",
  static_injections: "Static Injections",
  runtime_injections: "Runtime Injections",
  output_prompt_directions: "Output Directions",
  examples: "Examples",
  prompt_endings: "Prompt Endings",
};

const STUDIO_INBOX_KEY = "pl-studio-handoff-v1";
const BUILDER_INBOX_KEY = "pl-builder-handoff-v1";
const GEN_FIELDS = [
  ["temperature", "gen-temperature", parseFloat],
  ["top_p", "gen-top-p", parseFloat],
  ["top_k", "gen-top-k", parseInt],
  ["max_tokens", "gen-max-tokens", parseInt],
  ["repeat_penalty", "gen-repeat-penalty", parseFloat],
  ["retries", "gen-retries", parseInt],
  ["max_prompt_chars", "gen-max-prompt-chars", parseInt],
];
const POLICY_LIST_FIELDS = [
  ["strip_prefixes", "policy-strip-prefixes"],
  ["strip_patterns", "policy-strip-patterns"],
  ["require_patterns", "policy-required-patterns"],
  ["forbidden_substrings", "policy-forbidden-substrings"],
  ["forbidden_patterns", "policy-forbidden-patterns"],
];
const DEFAULT_ASSEMBLY_ORDER = [
  "output_prompt_directions",
  "sentiment.context",
  "persona.text",
  "persona.base_directives",
  "sentiment.nudges",
  "injections",
  "examples.normal_examples",
  "examples[sentiment.example_pool]",
  "examples.prompt_endings",
];

let registryState = createEmptyRegistryState();
let currentModalContext = null;
let activeBuilderTab = "sections";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function createEmptyRegistryState() {
  const state = {
    version: 22,
    title: "Twitch Chatter",
    description: "v2.2 Declarative Model",
    assembly_order: [],
    generation: {},
    generationExtras: {},
    output_policy: {},
    outputPolicyExtras: {},
    extraTopLevel: {},
    sections: {},
    memory_rules: [],
    memory_config: {},
  };

  SECTION_KEYS.forEach((key) => {
    state.sections[key] = {
      required: key !== "static_injections" && key !== "runtime_injections" && key !== "examples",
      template_vars: [],
      items: [],
      extras: {},
    };
  });

  return state;
}

function safeParseJson(label, text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed;
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  }
}

function setValidationStatus(message, ok = false) {
  const el = document.getElementById("validation-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("error", !ok);
}

function readListField(id) {
  const el = document.getElementById(id);
  if (!el) return [];
  return String(el.value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readGenerationFields() {
  const out = { ...registryState.generationExtras };
  for (const [key, id, parse] of GEN_FIELDS) {
    const el = document.getElementById(id);
    if (!el || el.value === "" || el.value == null) continue;
    const n = parse(el.value, 10);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

function readPolicyFields() {
  const out = { ...registryState.outputPolicyExtras };
  const minLength = document.getElementById("policy-min-length")?.value;
  const maxLength = document.getElementById("policy-max-length")?.value;
  const appendSuffix = document.getElementById("policy-append-suffix")?.value || "";
  const collapseWhitespace = !!document.getElementById("policy-collapse-whitespace")?.checked;

  if (minLength !== "") out.min_length = parseInt(minLength, 10);
  if (maxLength !== "") out.max_length = parseInt(maxLength, 10);
  if (collapseWhitespace) out.collapse_whitespace = true;
  else delete out.collapse_whitespace;
  if (appendSuffix.trim()) out.append_suffix = appendSuffix;

  for (const [key, id] of POLICY_LIST_FIELDS) {
    const vals = readListField(id);
    if (vals.length) out[key] = vals;
    else delete out[key];
  }
  return out;
}

function syncTopLevelStateFromInputs() {
  registryState.version = parseInt(document.getElementById("model-version").value, 10) || 0;
  registryState.title = document.getElementById("model-title-input").value;
  registryState.description = document.getElementById("model-desc-input").value;
  document.getElementById("assembly-order-input").value = registryState.assembly_order.join(", ");
  registryState.generation = readGenerationFields();
  registryState.output_policy = readPolicyFields();
}

function buildExportPayload() {
  syncTopLevelStateFromInputs();

  const registry = {
    version: registryState.version,
    title: registryState.title,
    description: registryState.description,
    assembly_order: [...registryState.assembly_order],
    ...registryState.extraTopLevel,
  };

  if (Object.keys(registryState.generation).length) {
    registry.generation = JSON.parse(JSON.stringify(registryState.generation));
  }
  if (Object.keys(registryState.output_policy).length) {
    registry.output_policy = JSON.parse(JSON.stringify(registryState.output_policy));
  }
  if (registryState.memory_rules.length) {
    registry.memory_rules = JSON.parse(JSON.stringify(registryState.memory_rules));
  }
  const memCfg = readMemoryConfig();
  if (Object.keys(memCfg).length) {
    registry.memory_config = memCfg;
  }

  SECTION_KEYS.forEach((key) => {
    const sectionData = registryState.sections[key];
    const items = sectionData.items.map(({ _ui_id, ...rest }) => {
      const out = { ...rest };
      if (key === "personas" && out.text) {
        out.context = out.text;
        delete out.text;
      }
      return out;
    });

    registry[key] = {
      required: sectionData.required,
      template_vars: [...sectionData.template_vars],
      items,
      ...sectionData.extras,
    };
  });

  return { registry };
}

function exportFullModel() {
  try {
    const output = buildExportPayload();
    document.getElementById("output-json").textContent = JSON.stringify(output, null, 2);
    setValidationStatus("Ready to validate or open in Studio.");
    renderExamplePrompt();
    return output;
  } catch (err) {
    document.getElementById("output-json").textContent = `ERROR: ${err.message}`;
    setValidationStatus(err.message, false);
    return null;
  }
}

// ── Preview tab ───────────────────────────────────────────────────────

let activePreviewTab = "json";
const previewSelections = {}; // secKey → index into items array

function switchPreviewTab(tab) {
  activePreviewTab = tab;
  const jsonPanel = document.getElementById("preview-json-panel");
  const promptPanel = document.getElementById("preview-prompt-panel");
  const jsonTab = document.getElementById("preview-tab-json");
  const promptTab = document.getElementById("preview-tab-prompt");
  const copyBtn = document.getElementById("preview-action-copy");
  const validateBtn = document.getElementById("preview-action-validate");
  if (!jsonPanel || !promptPanel) return;
  const onJson = tab === "json";
  jsonPanel.hidden = !onJson;
  promptPanel.hidden = onJson;
  jsonTab.classList.toggle("active", onJson);
  promptTab.classList.toggle("active", !onJson);
  if (copyBtn) copyBtn.hidden = !onJson;
  if (validateBtn) validateBtn.hidden = !onJson;
  if (!onJson) renderExamplePrompt();
}

function resolvePreviewToken(token) {
  const ALIAS = { persona: "personas", injections: "static_injections" };

  // sentiment.scale — synthetic token using scale_template + scale_emotion
  if (token === "sentiment.scale") {
    const sec = registryState.sections.sentiment;
    const idx = previewSelections["sentiment"] ?? 0;
    const item = sec?.items[idx];
    const template = sec?.extras?.scale_template ||
      "On a scale of 1-10, intensity is {value} on {emotion}.";
    const emotion = item?.scale_emotion || item?.id || "feeling";
    return template.replace("{value}", "5").replace("{emotion}", emotion);
  }

  // bracket expression — skip, too dynamic for a static preview
  if (/\[[^\]]+\]/.test(token)) return `[${token}]`;

  const parts = token.split(".");
  const rawSec = parts[0];
  const secKey = ALIAS[rawSec] || rawSec;
  const sec = registryState.sections[secKey];
  if (!sec) return "";

  const idx = previewSelections[secKey] ?? 0;
  const item = sec.items[idx];
  if (!item) return "";

  if (parts.length === 1) {
    // Bare section token — render primary text field
    if (Array.isArray(item.items) && item.items.length) {
      return item.items.map((x) => `- ${x}`).join("\n");
    }
    return item.text || item.context || "";
  }

  const sub = parts.slice(1).join(".");

  // Named pool lookup (e.g. examples.normal_examples)
  const poolItem = sec.items.find((it) => (it.name || it.id) === sub);
  if (poolItem) {
    if (Array.isArray(poolItem.items) && poolItem.items.length) {
      const header = poolItem.pre_context ? poolItem.pre_context + "\n" : "";
      return header + poolItem.items.map((x) => `- ${x}`).join("\n");
    }
    return poolItem.text || poolItem.context || "";
  }

  // Field on selected item (e.g. persona.base_directives, sentiment.nudges)
  const val = item[sub];
  if (Array.isArray(val)) return val.map((x) => `- ${x}`).join("\n");
  if (typeof val === "string") return val;
  return "";
}

function renderExamplePrompt() {
  const output = document.getElementById("example-prompt-output");
  const selectionsEl = document.getElementById("example-prompt-selections");
  if (!output || !selectionsEl) return;

  // Build per-section dropdowns for sections that have multiple items
  // and are referenced in the current assembly order.
  const referencedSecs = new Set();
  const ALIAS = { persona: "personas", injections: "static_injections" };
  for (const token of registryState.assembly_order) {
    const rawSec = token.split(".")[0].replace(/\[.*/, "");
    referencedSecs.add(ALIAS[rawSec] || rawSec);
  }

  const selectionsHtml = [...referencedSecs]
    .map((secKey) => {
      const sec = registryState.sections[secKey];
      if (!sec || sec.items.length <= 1) return "";
      const label = SECTION_LABELS[secKey] || secKey;
      const opts = sec.items
        .map((it, i) => {
          const name = it.name || it.id || `Item ${i + 1}`;
          const sel = (previewSelections[secKey] ?? 0) === i ? " selected" : "";
          return `<option value="${i}"${sel}>${escapeHtml(name)}</option>`;
        })
        .join("");
      return `<label class="preview-sel-row"><span>${escapeHtml(label)}</span>` +
        `<select onchange="setPreviewSelection('${secKey}', +this.value)">${opts}</select></label>`;
    })
    .join("");

  selectionsEl.innerHTML = selectionsHtml || "";
  selectionsEl.hidden = !selectionsHtml;

  if (!registryState.assembly_order.length) {
    output.textContent = "(no assembly order defined yet)";
    return;
  }

  const blocks = [];
  for (const token of registryState.assembly_order) {
    const text = resolvePreviewToken(token).trim();
    if (text) blocks.push(text);
  }

  output.textContent = blocks.join("\n\n") || "(nothing resolved — add items to your sections)";
}

function setPreviewSelection(secKey, index) {
  previewSelections[secKey] = index;
  renderExamplePrompt();
}

function toggleSection(el) {
  el.classList.toggle("collapsed");
}

function toggleBuilderCollapse(btn) {
  const panel = btn.closest("[data-builder-collapse]");
  if (!panel) return;
  panel.classList.toggle("collapsed");
  btn.textContent = panel.classList.contains("collapsed") ? "Expand" : "Collapse";
}

function switchBuilderTab(tab) {
  activeBuilderTab = ["finalize", "memory"].includes(tab) ? tab : "sections";
  const tabs = ["sections", "finalize", "memory"];
  for (const t of tabs) {
    const btn = document.getElementById(`tab-${t}`);
    const panel = document.getElementById(`builder-tab-${t}-panel`);
    const active = activeBuilderTab === t;
    if (btn) { btn.classList.toggle("active", active); btn.setAttribute("aria-selected", active ? "true" : "false"); }
    if (panel) panel.classList.toggle("active", active);
  }
}


function removeAssemblyToken(index) {
  registryState.assembly_order.splice(index, 1);
  renderAssemblyOrderEditor();
  exportFullModel();
}

function moveAssemblyToken(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= registryState.assembly_order.length) return;
  const arr = registryState.assembly_order;
  [arr[index], arr[next]] = [arr[next], arr[index]];
  renderAssemblyOrderEditor();
  exportFullModel();
}

function dynamicAssemblyVariants() {
  const namedItems = (secKey, alias = secKey, prefix = SECTION_LABELS[secKey]) =>
    (registryState.sections[secKey]?.items || [])
      .map((item) => item.name || item.id)
      .filter(Boolean)
      .map((name) => ({
        token: `${alias}.${name}`,
        label: `${prefix}: ${name}`,
      }));

  return {
    base_context: namedItems("base_context", "base_context", "Base Context"),
    examples: namedItems("examples", "examples", "Examples"),
    prompt_endings: namedItems("prompt_endings", "prompt_endings", "Prompt Ending"),
    injections: namedItems("static_injections", "injections", "Static Injection"),
    output_prompt_directions: namedItems("output_prompt_directions", "output_prompt_directions", "Output Direction"),
  };
}

function describeAssemblyToken(token) {
  if (token === "base_context" || token === "base_context.text") {
    return { title: "Base Context", detail: "Adds the scene or task framing." };
  }
  if (token === "output_prompt_directions") {
    return { title: "Output Directions", detail: "Adds all output rules for how the model should answer." };
  }
  if (token.startsWith("output_prompt_directions.")) {
    return { title: `Output Direction: ${token.split(".").slice(1).join(".")}`, detail: "Adds one named output-direction block." };
  }
  if (token === "persona.context" || token === "persona.text") {
    return { title: "Persona Context", detail: "Adds the chosen persona's voice or identity." };
  }
  if (token === "persona.base_directives") {
    return { title: "Persona Directives", detail: "Adds the persona's explicit instruction bullets." };
  }
  if (token === "sentiment.context") {
    return { title: "Sentiment Context", detail: "Adds high-level tone framing." };
  }
  if (token === "sentiment.nudges") {
    return { title: "Sentiment Nudges", detail: "Adds short nudges that shape the tone." };
  }
  if (token === "sentiment.examples") {
    return { title: "Sentiment Examples", detail: "Adds examples associated with the sentiment." };
  }
  if (token === "sentiment.scale") {
    return { title: "Sentiment Scale", detail: "Adds sentiment-scale guidance." };
  }
  if (token === "injections") {
    return { title: "Static Injections", detail: "Adds all selected static injection content." };
  }
  if (token.startsWith("injections.")) {
    return { title: `Static Injection: ${token.slice("injections.".length)}`, detail: "Adds one named static injection entry." };
  }
  if (token === "runtime_injections") {
    return { title: "Runtime Injections", detail: "Runs the special runtime injection layer." };
  }
  if (token === "prompt_endings") {
    return { title: "Prompt Endings", detail: "Adds all prompt-ending entries." };
  }
  if (token.startsWith("prompt_endings.")) {
    return { title: `Prompt Ending: ${token.slice("prompt_endings.".length)}`, detail: "Adds one named ending pool." };
  }
  if (token.startsWith("examples[")) {
    return { title: "Dynamic Examples Pool", detail: "Resolves an examples pool from a runtime variable." };
  }
  if (token.startsWith("examples.")) {
    return { title: `Examples: ${token.slice("examples.".length)}`, detail: "Adds one named examples pool." };
  }
  return { title: "Custom Token", detail: "Advanced token preserved exactly as typed." };
}

function assemblyGroups() {
  const dynamic = dynamicAssemblyVariants();

  return [
    {
      title: "Common Tokens",
      items: [
        { token: "base_context", label: "Base Context (all)" },
        { token: "base_context.text", label: "Base Context — text only" },
        { token: "output_prompt_directions", label: "Output Directions" },
        { token: "persona.context", label: "Persona — context" },
        { token: "persona.base_directives", label: "Persona — base directives" },
        { token: "sentiment.context", label: "Sentiment — context" },
        { token: "sentiment.nudges", label: "Sentiment — nudges" },
        { token: "injections", label: "Static Injections" },
        { token: "runtime_injections", label: "Runtime Injections" },
        { token: "prompt_endings", label: "Prompt Endings" },
      ],
    },
    {
      title: "Named Pools",
      items: [
        ...dynamic.base_context,
        ...dynamic.examples,
        ...dynamic.output_prompt_directions,
        ...dynamic.injections,
        ...dynamic.prompt_endings,
      ],
    },
  ].filter((g) => g.items.length);
}

function addAssemblyToken(token) {
  if (!token) return;
  registryState.assembly_order.push(token);
  renderAssemblyOrderEditor();
  exportFullModel();
}

function addAssemblyTokenFromEncoded(token) {
  addAssemblyToken(decodeURIComponent(token));
}

function renderAssemblyOrderEditor() {
  const host = document.getElementById("assembly-order-list");
  const palette = document.getElementById("assembly-token-groups");
  const hidden = document.getElementById("assembly-order-input");
  if (!host || !palette || !hidden) return;

  hidden.value = registryState.assembly_order.join(", ");

  if (!registryState.assembly_order.length) {
    host.innerHTML = `<div class="assembly-order-empty">No steps yet. Click a token to build the prompt flow.</div>`;
  } else {
    host.innerHTML = registryState.assembly_order
      .map((token, i) => {
        const meta = describeAssemblyToken(token);
        return `<div class="assembly-step-card">` +
          `<div class="assembly-step-number">${i + 1}</div>` +
          `<div class="assembly-step-copy">` +
          `<div class="assembly-step-title">${escapeHtml(meta.title)}</div>` +
          `<div class="assembly-step-detail">${escapeHtml(meta.detail)}</div>` +
          `<div class="assembly-step-token">${escapeHtml(token)}</div>` +
          `</div>` +
          `<span class="assembly-chip-controls">` +
          `<button type="button" class="assembly-chip-btn" onclick="moveAssemblyToken(${i}, -1)" title="Move up">Up</button>` +
          `<button type="button" class="assembly-chip-btn" onclick="moveAssemblyToken(${i}, 1)" title="Move down">Down</button>` +
          `<button type="button" class="assembly-chip-btn" onclick="removeAssemblyToken(${i})" title="Remove">Remove</button>` +
          `</span></div>`;
      })
      .join("");
  }

  renderExamplePrompt();

  palette.innerHTML = assemblyGroups()
    .map(
      (group) =>
        `<div class="assembly-group">` +
        `<div class="assembly-group-title">${escapeHtml(group.title)}</div>` +
        `<div class="assembly-group-items">` +
        group.items
          .map(
            (item) =>
              `<button type="button" class="assembly-palette-btn" onclick="addAssemblyTokenFromEncoded('${encodeURIComponent(item.token)}')">${escapeHtml(item.label)}</button>`
          )
          .join("") +
        `</div></div>`
    )
    .join("");
}

function openModal(key) {
  currentModalContext = key;
  document.getElementById("modal-input").value = "";
  document.getElementById("modal-title").textContent = `${SECTION_LABELS[key]} Variables`;
  document.getElementById("modal-overlay").style.display = "flex";
  setTimeout(() => document.getElementById("modal-input").focus(), 50);
}

function closeModal() {
  document.getElementById("modal-overlay").style.display = "none";
  currentModalContext = null;
}

function saveModal() {
  if (!currentModalContext) return;
  const key = currentModalContext;
  const val = document.getElementById("modal-input").value.trim();
  if (val && !registryState.sections[key].template_vars.includes(val)) {
    registryState.sections[key].template_vars.push(val);
  }
  initApp();
  closeModal();
}

function removeVar(key, varName) {
  registryState.sections[key].template_vars = registryState.sections[key].template_vars.filter((v) => v !== varName);
  initApp();
}

function updateSectionStatus(key, isRequired) {
  registryState.sections[key].required = isRequired;
  exportFullModel();
}

function updateSentimentScaleTemplate(value) {
  if (value.trim()) {
    registryState.sections.sentiment.extras.scale_template = value;
  } else {
    delete registryState.sections.sentiment.extras.scale_template;
  }
  exportFullModel();
}

let scaleBlockExpanded = false;

function toggleScaleBlock() {
  scaleBlockExpanded = !scaleBlockExpanded;
  renderSentimentScaleBlock();
}

function renderSentimentScaleBlock() {
  const host = document.getElementById("sentiment-scale-block");
  if (!host) return;
  const sec = registryState.sections.sentiment;
  const items = sec.items;
  const template = sec.extras.scale_template || "";

  const emotionRows = items.length
    ? items.map((it) => `
        <div class="scale-emotion-row">
          <span class="scale-emotion-label">${escapeHtml(it.id || "(unnamed)")}</span>
          <input type="text" value="${escapeHtml(it.scale_emotion || "")}"
            placeholder="emotion noun"
            oninput="updateField('sentiment', ${it._ui_id}, 'scale_emotion', this.value)">
        </div>`).join("")
    : `<div class="scale-emotion-empty">Add sentiment items above to set per-item emotions.</div>`;

  host.innerHTML = `
    <div class="scale-block">
      <button type="button" class="scale-block-toggle" onclick="toggleScaleBlock()">
        <span class="scale-block-chevron ${scaleBlockExpanded ? "open" : ""}">▸</span>
        Scale Settings
        <span class="scale-block-hint">configures the <code>sentiment.scale</code> assembly token</span>
      </button>
      ${scaleBlockExpanded ? `
      <div class="scale-block-body">
        <div class="scale-block-field">
          <label>Scale Template <span class="label-hint">use <code>{value}</code> and <code>{emotion}</code></span></label>
          <input type="text" id="sentiment-scale-template"
            value="${escapeHtml(template)}"
            placeholder="On a scale of 1-10, intensity is {value} on {emotion}."
            oninput="updateSentimentScaleTemplate(this.value)">
        </div>
        <div class="scale-block-field">
          <label>Emotion per item <span class="label-hint">overrides the default emotion noun when that item is selected</span></label>
          <div class="scale-emotions-list">${emotionRows}</div>
        </div>
      </div>` : ""}
    </div>`;
}

function addEntry(type) {
  const entry = { _ui_id: Date.now() + Math.random() };
  if (type === "runtime_injections") {
    entry.id = "new_injection";
    entry.required = true;
    entry.include_sections = SECTION_KEYS.filter((k) => k !== "runtime_injections");
  } else if (type === "personas") {
    entry.id = "";
    entry.text = "";
    entry.base_directives = [];
  } else if (type === "sentiment") {
    entry.id = "";
    entry.context = "";
    entry.nudges = [];
    entry.examples = [];
  } else if (
    type === "static_injections" ||
    type === "output_prompt_directions" ||
    type === "base_context"
  ) {
    entry.name = "";
    entry.text = "";
  } else {
    entry.name = "";
    entry.items = [];
  }
  registryState.sections[type].items.push(entry);
  renderItems(type);
  renderAssemblyOrderEditor();
  exportFullModel();
}

function renderListField(type, uiId, field, values) {
  const rows = (values || []).map((val, i) => `
    <div class="list-item-row">
      <input type="text" value="${escapeHtml(val)}"
        oninput="updateListItem('${type}', ${uiId}, '${field}', ${i}, this.value)"
        placeholder="item ${i + 1}">
      <button type="button" class="list-item-remove" onclick="removeListItem('${type}', ${uiId}, '${field}', ${i})" title="Remove">×</button>
    </div>
  `).join("");
  return `<div class="list-field">${rows}<button type="button" class="list-item-add" onclick="addListItem('${type}', ${uiId}, '${field}')">+ Add</button></div>`;
}

function updateListItem(type, uiId, field, index, value) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (!Array.isArray(entry[field])) entry[field] = [];
  entry[field][index] = value;
  exportFullModel();
}

function addListItem(type, uiId, field) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (!Array.isArray(entry[field])) entry[field] = [];
  entry[field].push("");
  renderItems(type);
  exportFullModel();
}

function removeListItem(type, uiId, field, index) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  entry[field].splice(index, 1);
  renderItems(type);
  exportFullModel();
}

function renderItems(type) {
  const container = document.getElementById(`${type}-container`);
  container.innerHTML = "";

  registryState.sections[type].items.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    let html = "";

    if (type === "runtime_injections") {
      html = `
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label>Injection ID</label>
            <input type="text" value="${entry.id || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)">
          </div>
          <div>
            <label>Strict Requirement</label>
            <select onchange="updateField('${type}', ${entry._ui_id}, 'required', this.value === 'true')">
              <option value="true" ${entry.required ? "selected" : ""}>True</option>
              <option value="false" ${!entry.required ? "selected" : ""}>False</option>
            </select>
          </div>
        </div>
        <div class="mb-3">
          <label>Memory Tag <span class="label-hint">tag that activates this injection (from Memory Rules)</span></label>
          <input type="text" value="${escapeHtml(entry.memory_tag || "")}"
            placeholder="e.g. past_conflict"
            oninput="updateField('${type}', ${entry._ui_id}, 'memory_tag', this.value)">
        </div>
        <div>
          <label>Apply to Sections</label>
          <div class="checkbox-grid">
            ${SECTION_KEYS.filter((k) => k !== "runtime_injections")
              .map(
                (secKey) => `
              <label class="checkbox-item">
                <input type="checkbox" ${(entry.include_sections || []).includes(secKey) ? "checked" : ""}
                  onchange="toggleIncludeSection(${entry._ui_id}, '${secKey}', this.checked)">
                ${SECTION_LABELS[secKey]}
              </label>`
              )
              .join("")}
          </div>
        </div>
      `;
    } else if (type === "personas") {
      html = `
        <label>ID</label>
        <input type="text" value="${entry.id || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Context</label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${entry.text || ""}</textarea>
        <label class="mt-2">Base Directives</label>
        ${renderListField(type, entry._ui_id, 'base_directives', entry.base_directives)}
      `;
    } else if (type === "sentiment") {
      html = `
        <label>ID</label>
        <input type="text" value="${entry.id || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Context</label>
        <input type="text" value="${entry.context || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'context', this.value)" class="mb-2">
        <div class="grid grid-cols-2 gap-3 mt-2">
          <div>
            <label>Nudges</label>
            ${renderListField(type, entry._ui_id, 'nudges', entry.nudges)}
          </div>
          <div>
            <label>Examples</label>
            ${renderListField(type, entry._ui_id, 'examples', entry.examples)}
          </div>
        </div>
      `;
    } else if (type === "examples" || type === "prompt_endings") {
      html = `
        <label>Name</label>
        <input type="text" value="${entry.name || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'name', this.value)" class="mb-2">
        <label>Items</label>
        ${renderListField(type, entry._ui_id, 'items', entry.items)}
      `;
    } else {
      const memTagRow = (type === "static_injections")
        ? `<label class="mt-2">Memory Tag <span class="label-hint">tag that activates this injection (from Memory Rules)</span></label>
           <input type="text" value="${escapeHtml(entry.memory_tag || "")}"
             placeholder="e.g. past_conflict"
             oninput="updateField('${type}', ${entry._ui_id}, 'memory_tag', this.value)" class="mb-2">`
        : "";
      html = `
        <label>Name/ID</label>
        <input type="text" value="${entry.name || entry.id || ""}" oninput="updateField('${type}', ${entry._ui_id}, 'name', this.value)" class="mb-2">
        <label>Text</label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${entry.text || ""}</textarea>
        ${memTagRow}
        <label class="mt-2">Pool Items <span class="label-hint">optional — if set, assembly token <code>${type}.name</code> renders this list instead of text</span></label>
        ${renderListField(type, entry._ui_id, 'items', entry.items)}
      `;
    }

    card.innerHTML = `<button onclick="removeEntry('${type}', ${entry._ui_id})" class="btn-delete">REMOVE</button>${html}`;
    container.appendChild(card);
  });

  if (type === "sentiment") renderSentimentScaleBlock();
}

function toggleIncludeSection(uiId, secKey, isChecked) {
  const entry = registryState.sections.runtime_injections.items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  entry.include_sections = entry.include_sections || [];
  if (isChecked) {
    if (!entry.include_sections.includes(secKey)) entry.include_sections.push(secKey);
  } else {
    entry.include_sections = entry.include_sections.filter((k) => k !== secKey);
  }
  exportFullModel();
}

function updateField(type, uiId, field, value) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (["base_directives", "nudges", "items", "examples"].includes(field)) {
    entry[field] = String(value)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    entry[field] = value;
  }
  if (field === "name" || field === "id") renderAssemblyOrderEditor();
  exportFullModel();
}

function removeEntry(type, uiId) {
  registryState.sections[type].items = registryState.sections[type].items.filter((e) => e._ui_id !== uiId);
  renderItems(type);
  renderAssemblyOrderEditor();
  exportFullModel();
}

function applyRegistryJson(json) {
  const reg = json.registry || json || {};
  const next = createEmptyRegistryState();

  next.version = reg.version || 22;
  next.title = reg.title || "Twitch Chatter";
  next.description = reg.description || "";
  next.assembly_order = Array.isArray(reg.assembly_order) ? [...reg.assembly_order] : [];
  next.generation = reg.generation && typeof reg.generation === "object" ? reg.generation : {};
  next.output_policy = reg.output_policy && typeof reg.output_policy === "object" ? reg.output_policy : {};
  if (
    next.output_policy &&
    Array.isArray(next.output_policy.required_patterns) &&
    !Array.isArray(next.output_policy.require_patterns)
  ) {
    next.output_policy.require_patterns = [...next.output_policy.required_patterns];
  }
  next.generationExtras = { ...next.generation };
  next.outputPolicyExtras = { ...next.output_policy };

  for (const [key] of GEN_FIELDS) delete next.generationExtras[key];
  delete next.outputPolicyExtras.min_length;
  delete next.outputPolicyExtras.max_length;
  delete next.outputPolicyExtras.collapse_whitespace;
  delete next.outputPolicyExtras.append_suffix;
  delete next.outputPolicyExtras.required_patterns;
  for (const [key] of POLICY_LIST_FIELDS) delete next.outputPolicyExtras[key];

  next.memory_rules = Array.isArray(reg.memory_rules)
    ? JSON.parse(JSON.stringify(reg.memory_rules))
    : [];
  next.memory_config = reg.memory_config && typeof reg.memory_config === "object"
    ? { ...reg.memory_config }
    : {};

  const knownTopLevel = new Set([
    "version",
    "title",
    "description",
    "assembly_order",
    "generation",
    "output_policy",
    "memory_rules",
    "memory_config",
    ...SECTION_KEYS,
  ]);
  for (const [k, v] of Object.entries(reg)) {
    if (!knownTopLevel.has(k)) next.extraTopLevel[k] = v;
  }

  SECTION_KEYS.forEach((key) => {
    const importedSection = reg[key] || {};
    const { required, template_vars, items, ...extras } = importedSection;
    next.sections[key] = {
      required: required !== undefined ? required : next.sections[key].required,
      template_vars: Array.isArray(template_vars) ? [...template_vars] : [],
      extras,
      items: (items || []).map((item) => {
        const entry = { ...item, _ui_id: Date.now() + Math.random() };
        if (key === "personas" && entry.context) entry.text = entry.context;
        if (key === "runtime_injections" && !entry.include_sections) entry.include_sections = [];
        return entry;
      }),
    };
  });

  registryState = next;
  populateMemoryConfigInputs();

  document.getElementById("model-version").value = registryState.version;
  document.getElementById("model-title-input").value = registryState.title;
  document.getElementById("model-desc-input").value = registryState.description;
  for (const [key, id] of GEN_FIELDS) {
    const el = document.getElementById(id);
    if (el) el.value = registryState.generation[key] ?? "";
  }
  document.getElementById("policy-min-length").value = registryState.output_policy.min_length ?? "";
  document.getElementById("policy-max-length").value = registryState.output_policy.max_length ?? "";
  document.getElementById("policy-collapse-whitespace").checked = !!registryState.output_policy.collapse_whitespace;
  document.getElementById("policy-append-suffix").value = registryState.output_policy.append_suffix ?? "";
  for (const [key, id] of POLICY_LIST_FIELDS) {
    const el = document.getElementById(id);
    if (el) el.value = Array.isArray(registryState.output_policy[key]) ? registryState.output_policy[key].join("\n") : "";
  }

  initApp();
}

async function loadBuilderExample(name) {
  if (!name) return;
  try {
    const res = await fetch(`/static/builder-examples/${name}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyRegistryJson(await res.json());
    setValidationStatus(`Example "${name}" loaded.`, true);
  } catch (e) {
    console.error(e);
    alert("Failed to load example. Check console for details.");
  }
}

function importModel() {
  const raw = prompt("Paste Registry JSON:");
  if (!raw) return;
  try {
    applyRegistryJson(JSON.parse(raw));
  } catch (e) {
    console.error(e);
    alert("Import failed. Check console for details.");
  }
}

async function validateRegistry() {
  const payload = exportFullModel();
  if (!payload) return;
  try {
    const res = await fetch("/api/registry/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry: payload.registry }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    setValidationStatus("Validated by promptlibretto.", true);
  } catch (err) {
    setValidationStatus(`Validation failed: ${err.message}`, false);
  }
}

function consumeStudioHandoff() {
  try {
    const raw = localStorage.getItem(BUILDER_INBOX_KEY);
    if (!raw) return false;
    localStorage.removeItem(BUILDER_INBOX_KEY);
    applyRegistryJson(JSON.parse(raw));
    setValidationStatus("Loaded registry from Studio.", true);
    return true;
  } catch (err) {
    console.warn("Failed to load Studio handoff:", err);
    return false;
  }
}

function openInStudio() {
  const payload = exportFullModel();
  if (!payload) return;
  try {
    localStorage.setItem(STUDIO_INBOX_KEY, JSON.stringify(payload));
    window.location.href = "/";
  } catch (err) {
    alert(`Failed to pass registry to Studio: ${err.message}`);
  }
}

async function copyToClipboard() {
  const text = document.getElementById("output-json").textContent;
  try {
    await navigator.clipboard.writeText(text);
    document.getElementById("copy-btn").textContent = "COPIED!";
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    document.getElementById("copy-btn").textContent = "COPIED!";
  }
  setTimeout(() => {
    document.getElementById("copy-btn").textContent = "Copy JSON";
  }, 1000);
}

function initApp() {
  const list = document.getElementById("section-list");
  list.innerHTML = "";

  SECTION_KEYS.forEach((key) => {
    const config = registryState.sections[key];
    const section = document.createElement("div");
    section.className = "glass rounded-xl overflow-hidden border border-white/10 collapsed";
    section.id = `section-${key}`;

    const varBadges = (config.template_vars || [])
      .map(
        (v) =>
          `<span class="var-badge" title="Click to remove" onclick="event.stopPropagation(); removeVar('${key}', '${v}')">${v}</span>`
      )
      .join(" ");

    section.innerHTML = `
      <div class="section-header font-bold" onclick="toggleSection(this.parentElement)">
        <div class="flex items-center gap-3">
          <svg class="chevron w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          <div class="flex flex-col">
            <span class="text-sm">${SECTION_LABELS[key]}</span>
            <div id="vars-display-${key}" class="flex gap-1 mt-1">${varBadges}</div>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <button onclick="event.stopPropagation(); openModal('${key}')" class="text-[10px] text-purple-400 hover:underline">+ Add Var</button>
          <button onclick="event.stopPropagation(); openSectionInfo('${key}')" class="section-info-btn" title="What is this section?">?</button>
          <span class="text-[10px] text-slate-500 uppercase tracking-widest px-2">${config.items.length} Items</span>
        </div>
      </div>
      <div class="collapsible-content">
        <div class="section-settings">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-4">
              <div class="w-32">
                <label>Section Usage</label>
                <select onchange="updateSectionStatus('${key}', this.value === 'true')">
                  <option value="true" ${config.required ? "selected" : ""}>Mandatory</option>
                  <option value="false" ${!config.required ? "selected" : ""}>Optional</option>
                </select>
              </div>
              <div class="text-[10px] text-slate-500 pt-4 italic">
                Stored within registry.${key}
              </div>
            </div>
          </div>
        </div>
        ${key === "sentiment" ? `<div id="sentiment-scale-block"></div>` : ""}
        <div id="${key}-container" class="p-4"></div>
        <div class="p-4 pt-0">
          <button onclick="addEntry('${key}')" class="btn-add">+ Add ${SECTION_LABELS[key]} Entry</button>
        </div>
      </div>
    `;
    list.appendChild(section);
    renderItems(key);
  });

  renderAssemblyOrderEditor();
  renderMemoryRulesPanel();
  switchBuilderTab(activeBuilderTab);
  exportFullModel();
}

const SECTION_INFO = {
  base_context: {
    title: "Base Context",
    body: "The foundational framing for the prompt — describes the task, scene, or system role. Usually a single item. Template variables like {product} let the runtime slot in specific values. Every prompt needs at least one base context item.",
    fields: ["text — the main framing paragraph", "template_vars — variable names available in the text"],
  },
  personas: {
    title: "Personas",
    body: "Named character or role configurations. The Studio lets users select one persona at runtime. Use personas when the same prompt needs to behave differently depending on who is 'speaking' — a friendly agent vs. a terse expert, for example.",
    fields: ["name — identifier used for selection", "context — who this persona is", "base_directives — specific rules for this persona"],
  },
  sentiment: {
    title: "Sentiment Contexts",
    body: "Tone or mood overlays applied on top of the selected persona. Good for adjusting formality, energy, or style without changing the core persona. Optional section — leave it empty if tone is always fixed.",
    fields: ["name — identifier", "context — tone description", "nudges — short phrasing cues the model should follow"],
  },
  static_injections: {
    title: "Static Injections",
    body: "Fixed text blocks inserted at a specific point in the assembled prompt. Useful for boilerplate rules, safety disclaimers, or any content that never changes at runtime. Unlike base context, injections are designed to be composable — you can include many.",
    fields: ["id — identifier", "text — the injected content", "required — whether Studio must include it"],
  },
  runtime_injections: {
    title: "Runtime Injections",
    body: "Dynamic text blocks that are conditionally included depending on which other sections are active. Use them for context that only makes sense when a certain persona or sentiment is selected (e.g. extra instructions that apply only to a 'formal' sentiment).",
    fields: ["id — identifier", "text — the injected content", "include_sections — sections that trigger this injection"],
  },
  output_prompt_directions: {
    title: "Output Directions",
    body: "Formatting and structure rules for the model's response — JSON schema, bullet style, length constraints, language requirements. Rendered at the top of the assembly order by default so the model sees constraints early.",
    fields: ["name — identifier", "text — the directions text"],
  },
  examples: {
    title: "Examples",
    body: "Pools of few-shot examples the model can learn from. Items belong to named pools (e.g. 'normal_examples', 'edge_cases'). The assembly order token picks which pool to render. Supports random selection so the model sees varied examples across requests.",
    fields: ["name — pool the example belongs to", "items — list of example strings"],
  },
  prompt_endings: {
    title: "Prompt Endings",
    body: "Closing lines appended after all other content — a final instruction, a cue like 'Answer:', or a sign-off. Keeps the prompt's last line consistent regardless of which persona or sentiment was chosen.",
    fields: ["name — identifier", "items — one or more closing lines"],
  },
};

function openSectionInfo(key) {
  const info = SECTION_INFO[key];
  if (!info) return;
  const modal = document.getElementById("section-info-modal");
  if (!modal) return;
  document.getElementById("section-info-title").textContent = info.title;
  document.getElementById("section-info-body").textContent = info.body;
  const fieldsList = document.getElementById("section-info-fields");
  fieldsList.innerHTML = info.fields.map((f) => `<li>${f}</li>`).join("");
  modal.hidden = false;
}

function closeSectionInfo() {
  const modal = document.getElementById("section-info-modal");
  if (modal) modal.hidden = true;
}

// ── Memory Rules ──────────────────────────────────────────────────

const CONN_KEY = "promptlibretto.connection.v1";

function getStudioConnection() {
  try { return JSON.parse(localStorage.getItem(CONN_KEY) || "{}"); }
  catch { return {}; }
}

function refreshMemConnChip() {
  const chip = document.getElementById("mem-conn-chip");
  if (!chip) return;
  const conn = getStudioConnection();
  const url = conn.baseUrl || conn.base_url || "";
  if (url) {
    const model = conn.model ? ` · ${conn.model}` : "";
    chip.textContent = url + model;
    chip.classList.remove("mem-conn-chip--warn");
  } else {
    chip.textContent = "not set — configure in Studio";
    chip.classList.add("mem-conn-chip--warn");
  }
}

function readMemoryConfig() {
  const classifierUrl  = document.getElementById("mem-classifier-url")?.value?.trim();
  const classifierModel = document.getElementById("mem-classifier-model")?.value?.trim();
  const embedUrl       = document.getElementById("mem-embed-url")?.value?.trim();
  const embedModel     = document.getElementById("mem-embed-model")?.value?.trim();
  const topK           = document.getElementById("mem-top-k")?.value;
  const pruneKeep      = document.getElementById("mem-prune-keep")?.value;
  const storePath      = document.getElementById("mem-store-path")?.value?.trim();
  const file           = document.getElementById("mem-personality-file")?.value?.trim();
  const out = {};
  if (classifierUrl)   out.classifier_url   = classifierUrl;
  if (classifierModel) out.classifier_model = classifierModel;
  if (embedUrl)        out.embed_url        = embedUrl;
  if (embedModel)      out.embed_model      = embedModel;
  const k = parseInt(topK, 10);
  if (Number.isFinite(k) && k > 0) out.top_k = k;
  const p = parseInt(pruneKeep, 10);
  if (Number.isFinite(p) && p > 0) out.prune_keep = p;
  if (storePath) out.store_path = storePath;
  if (file)      out.personality_file = file;
  return out;
}

function _setClassifierModelSelect(models, currentValue) {
  const sel = document.getElementById("mem-classifier-model");
  if (!sel) return;
  const prev = currentValue ?? sel.value;
  sel.innerHTML = models.length
    ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === prev ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")
    : `<option value="">— no models found —</option>`;
  if (prev && models.includes(prev)) sel.value = prev;
}

async function fetchClassifierModels() {
  const urlEl = document.getElementById("mem-classifier-url");
  const conn = getStudioConnection();
  const base = (urlEl?.value?.trim() || conn.baseUrl || conn.base_url || "").replace(/\/+$/, "");
  if (!base) {
    alert("Set a classifier_url or configure your Studio connection first.");
    return;
  }
  const sel = document.getElementById("mem-classifier-model");
  if (sel) { sel.innerHTML = `<option value="">Loading…</option>`; }
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    let models = [];
    // Try Ollama /api/tags first, fall back to OpenAI /v1/models
    for (const path of ["/api/tags", "/v1/models"]) {
      try {
        const resp = await fetch(base + path, { signal: abort.signal });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (Array.isArray(data.models)) { models = data.models.map((m) => m.name).filter(Boolean); break; }
        if (Array.isArray(data.data))   { models = data.data.map((m) => m.id).filter(Boolean); break; }
      } catch {}
    }
    clearTimeout(timer);
    _setClassifierModelSelect(models, registryState.memory_config?.classifier_model);
    exportFullModel();
  } catch (err) {
    if (sel) sel.innerHTML = `<option value="">— fetch failed —</option>`;
  }
}

function populateMemoryConfigInputs() {
  const cfg = registryState.memory_config || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
  set("mem-classifier-url",   cfg.classifier_url);
  set("mem-embed-url",        cfg.embed_url);
  set("mem-embed-model",      cfg.embed_model);
  set("mem-top-k",            cfg.top_k);
  set("mem-prune-keep",       cfg.prune_keep);
  set("mem-store-path",       cfg.store_path);
  set("mem-personality-file", cfg.personality_file);
  if (cfg.classifier_model) {
    _setClassifierModelSelect([cfg.classifier_model], cfg.classifier_model);
  }
}

function addMemoryRule() {
  registryState.memory_rules.push({ tag: "", actions: [] });
  renderMemoryRulesPanel();
  exportFullModel();
}

function removeMemoryRule(idx) {
  registryState.memory_rules.splice(idx, 1);
  renderMemoryRulesPanel();
  exportFullModel();
}

function updateMemoryRuleTag(idx, value) {
  registryState.memory_rules[idx].tag = value;
  exportFullModel();
}

function addMemoryAction(ruleIdx) {
  if (!registryState.memory_rules[ruleIdx]) return;
  registryState.memory_rules[ruleIdx].actions.push({ type: "inject", section: "runtime_injections", item: "" });
  renderMemoryRulesPanel();
  exportFullModel();
}

function removeMemoryAction(ruleIdx, actionIdx) {
  registryState.memory_rules[ruleIdx]?.actions.splice(actionIdx, 1);
  renderMemoryRulesPanel();
  exportFullModel();
}

function updateMemoryAction(ruleIdx, actionIdx, field, value) {
  const action = registryState.memory_rules[ruleIdx]?.actions[actionIdx];
  if (!action) return;
  action[field] = value;
  if (field === "type") {
    // reset type-specific fields when type changes
    delete action.section; delete action.item;
    delete action.value; delete action.key;
    if (value === "inject") { action.section = "runtime_injections"; action.item = ""; }
    else if (value === "persona" || value === "sentiment") { action.value = ""; }
    else if (value === "template_var") { action.key = ""; action.value = ""; }
  }
  renderMemoryRulesPanel();
  exportFullModel();
}

function _memActionEditor(ruleIdx, actionIdx, action) {
  const typeOpts = ["inject", "persona", "sentiment", "template_var"]
    .map((t) => `<option value="${t}" ${action.type === t ? "selected" : ""}>${t}</option>`)
    .join("");

  let targetHtml = "";
  if (action.type === "inject") {
    const secOpts = ["runtime_injections", "static_injections"]
      .map((s) => `<option value="${s}" ${action.section === s ? "selected" : ""}>${s}</option>`)
      .join("");
    const selectedSec = action.section || "runtime_injections";
    const secItems = (registryState.sections[selectedSec]?.items || []);
    const itemOpts = secItems.map((it) => {
      const id = it.id || it.name || "";
      return `<option value="${id}" ${action.item === id ? "selected" : ""}>${escapeHtml(id)}</option>`;
    }).join("");
    targetHtml = `
      <select class="mem-action-field" onchange="updateMemoryAction(${ruleIdx},${actionIdx},'section',this.value)">${secOpts}</select>
      <select class="mem-action-field" onchange="updateMemoryAction(${ruleIdx},${actionIdx},'item',this.value)">
        <option value="">— item id —</option>${itemOpts}
      </select>`;
  } else if (action.type === "persona") {
    const opts = (registryState.sections.personas?.items || [])
      .map((it) => { const id = it.id || ""; return `<option value="${id}" ${action.value === id ? "selected" : ""}>${escapeHtml(id)}</option>`; })
      .join("");
    targetHtml = `<select class="mem-action-field" onchange="updateMemoryAction(${ruleIdx},${actionIdx},'value',this.value)"><option value="">— persona id —</option>${opts}</select>`;
  } else if (action.type === "sentiment") {
    const opts = (registryState.sections.sentiment?.items || [])
      .map((it) => { const id = it.id || ""; return `<option value="${id}" ${action.value === id ? "selected" : ""}>${escapeHtml(id)}</option>`; })
      .join("");
    targetHtml = `<select class="mem-action-field" onchange="updateMemoryAction(${ruleIdx},${actionIdx},'value',this.value)"><option value="">— sentiment id —</option>${opts}</select>`;
  } else if (action.type === "template_var") {
    targetHtml = `
      <input class="mem-action-field" type="text" value="${escapeHtml(action.key || "")}" placeholder="var key"
        oninput="updateMemoryAction(${ruleIdx},${actionIdx},'key',this.value)">
      <input class="mem-action-field" type="text" value="${escapeHtml(action.value || "")}" placeholder="var value"
        oninput="updateMemoryAction(${ruleIdx},${actionIdx},'value',this.value)">`;
  }

  return `<div class="mem-action-row">
    <select class="mem-action-type" onchange="updateMemoryAction(${ruleIdx},${actionIdx},'type',this.value)">${typeOpts}</select>
    ${targetHtml}
    <button type="button" class="mem-action-remove" onclick="removeMemoryAction(${ruleIdx},${actionIdx})" title="Remove action">×</button>
  </div>`;
}

function renderMemoryRulesPanel() {
  const host = document.getElementById("memory-rules-list");
  if (!host) return;

  if (!registryState.memory_rules.length) {
    host.innerHTML = `<div class="mem-empty">No rules yet. Add a rule to map memory tags to prompt mutations.</div>`;
    return;
  }

  host.innerHTML = registryState.memory_rules.map((rule, rIdx) => {
    const actionsHtml = rule.actions.length
      ? rule.actions.map((a, aIdx) => _memActionEditor(rIdx, aIdx, a)).join("")
      : `<div class="mem-empty-actions">No actions — add one below.</div>`;
    return `<div class="mem-rule-card">
      <div class="mem-rule-header">
        <input type="text" class="mem-rule-tag" value="${escapeHtml(rule.tag)}"
          placeholder="tag name (e.g. past_conflict)"
          oninput="updateMemoryRuleTag(${rIdx}, this.value)">
        <button type="button" class="mem-rule-remove" onclick="removeMemoryRule(${rIdx})">Remove Rule</button>
      </div>
      <div class="mem-actions-list">${actionsHtml}</div>
      <button type="button" class="mem-action-add" onclick="addMemoryAction(${rIdx})">+ Add Action</button>
    </div>`;
  }).join("");
}

consumeStudioHandoff();
initApp();

window.toggleSection = toggleSection;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveModal = saveModal;
window.removeVar = removeVar;
window.updateSectionStatus = updateSectionStatus;
window.updateSentimentScaleTemplate = updateSentimentScaleTemplate;
window.toggleScaleBlock = toggleScaleBlock;
window.addEntry = addEntry;
window.toggleIncludeSection = toggleIncludeSection;
window.updateField = updateField;
window.removeEntry = removeEntry;
window.exportFullModel = exportFullModel;
window.importModel = importModel;
window.loadBuilderExample = loadBuilderExample;
window.updateListItem = updateListItem;
window.addListItem = addListItem;
window.removeListItem = removeListItem;
window.copyToClipboard = copyToClipboard;
window.validateRegistry = validateRegistry;
window.openInStudio = openInStudio;
window.toggleBuilderCollapse = toggleBuilderCollapse;
window.openSectionInfo = openSectionInfo;
window.closeSectionInfo = closeSectionInfo;
window.switchPreviewTab = switchPreviewTab;
window.setPreviewSelection = setPreviewSelection;
window.switchBuilderTab = switchBuilderTab;
window.addAssemblyToken = addAssemblyToken;
window.addAssemblyTokenFromEncoded = addAssemblyTokenFromEncoded;
window.removeAssemblyToken = removeAssemblyToken;
window.moveAssemblyToken = moveAssemblyToken;
window.refreshMemConnChip = refreshMemConnChip;
window.fetchClassifierModels = fetchClassifierModels;
window.addMemoryRule = addMemoryRule;
window.removeMemoryRule = removeMemoryRule;
window.updateMemoryRuleTag = updateMemoryRuleTag;
window.addMemoryAction = addMemoryAction;
window.removeMemoryAction = removeMemoryAction;
window.updateMemoryAction = updateMemoryAction;
