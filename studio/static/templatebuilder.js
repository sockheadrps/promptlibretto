const SECTION_KEYS = [
  "base_context",
  "personas",
  "sentiment",
  "static_injections",
  "runtime_injections",
  "output_prompt_directions",
  "memory_recall",
  "user_message",
  "prompt_endings",
];

const SECTION_LABELS = {
  base_context: "Base Context",
  personas: "Personas",
  sentiment: "Sentiment Contexts",
  static_injections: "Static Injections",
  runtime_injections: "Runtime Injections",
  output_prompt_directions: "Output Directions",
  memory_recall: "Memory Recall",
  user_message: "User Message",
  prompt_endings: "Prompt Endings",
  groups: "Groups",
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
  "base_context.text",
  "personas.context",
  "personas.groups",
  "sentiment.context",
  "sentiment.groups",
  "sentiment.scale",
  "memory_recall.text",
  "prompt_endings.endings",
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
    version: 2,
    title: "New Registry",
    description: "",
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

  const optional = new Set(["static_injections", "runtime_injections", "memory_recall", "user_message", "groups"]);
  SECTION_KEYS.forEach((key) => {
    state.sections[key] = {
      required: !optional.has(key),
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

  const rawOrder = [...registryState.assembly_order];
  const nonEnding = rawOrder.filter((t) => !isPromptEndingsToken(t));
  const endings = rawOrder.filter((t) => isPromptEndingsToken(t));
  const registry = {
    version: registryState.version,
    title: registryState.title,
    description: registryState.description,
    assembly_order: [...nonEnding, ...endings],
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
    const items = sectionData.items.map(({ _ui_id, template_var_defaults, ...rest }) => {
      const out = { ...rest };
      // Strip empty scale fields to keep JSON clean
      if (out.scale) {
        if (!out.scale.scale_descriptor && !out.scale.template) delete out.scale;
      }
      // Strip empty pre_context on groups items
      if (key === "groups" && !out.pre_context) delete out.pre_context;
      // Strip empty groups arrays on personas/sentiment
      if ((key === "personas" || key === "sentiment") && Array.isArray(out.groups) && !out.groups.length) {
        delete out.groups;
      }
      // Strip empty template_vars arrays and legacy fields on runtime_injections
      if (key === "runtime_injections") {
        if (Array.isArray(out.template_vars) && !out.template_vars.length) delete out.template_vars;
        delete out.memory_tag;
        delete out.include_sections;
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
    if (activePreviewTab === "prompt") renderExamplePrompt();
    if (activePreviewTab === "flow") renderFlowView();
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
  const flowPanel = document.getElementById("preview-flow-panel");
  const jsonTab = document.getElementById("preview-tab-json");
  const promptTab = document.getElementById("preview-tab-prompt");
  const flowTab = document.getElementById("preview-tab-flow");
  const copyBtn = document.getElementById("preview-action-copy");
  const validateBtn = document.getElementById("preview-action-validate");
  if (!jsonPanel || !promptPanel || !flowPanel) return;
  jsonPanel.hidden = tab !== "json";
  promptPanel.hidden = tab !== "prompt";
  flowPanel.hidden = tab !== "flow";
  if (jsonTab) jsonTab.classList.toggle("active", tab === "json");
  if (promptTab) promptTab.classList.toggle("active", tab === "prompt");
  if (flowTab) flowTab.classList.toggle("active", tab === "flow");
  if (copyBtn) copyBtn.hidden = tab !== "json";
  if (validateBtn) validateBtn.hidden = tab !== "json";
  if (tab === "prompt") renderExamplePrompt();
  if (tab === "flow") renderFlowView();
}

function renderFlowView() {
  const container = document.getElementById("preview-flow-list");
  if (!container) return;

  if (!registryState.assembly_order.length) {
    container.innerHTML = `<div class="flow-empty">No assembly order defined yet — add tokens in the Finalize tab.</div>`;
    return;
  }

  const blocks = registryState.assembly_order.map((token) => {
    const text = resolvePreviewToken(token).trim();
    const isEmpty = !text;
    return (
      `<div class="flow-block${isEmpty ? " flow-block--empty" : ""}">` +
      `<div class="flow-block-token">${escapeHtml(token)}</div>` +
      (isEmpty
        ? `<div class="flow-block-body flow-block-body--empty">(empty)</div>`
        : `<div class="flow-block-body">${escapeHtml(text)}</div>`) +
      `</div>`
    );
  });

  container.innerHTML = blocks.join("");
}

function resolvePreviewToken(token) {
  const ALIAS = {};

  // groups[id] — look up directly in groups section
  const bracketMatch = token.match(/^groups\[([^\]]+)\]$/);
  if (bracketMatch) {
    const gid = bracketMatch[1];
    const group = (registryState.sections.groups?.items || []).find((it) => (it.id || it.name) === gid);
    if (!group) return `[${token}]`;
    const header = group.pre_context ? group.pre_context + "\n" : "";
    return Array.isArray(group.items) && group.items.length
      ? header + group.items.map((x) => `- ${x}`).join("\n")
      : "";
  }

  // injections — runtime injection items (preview shows all items' text)
  if (token === "injections" || token === "runtime_injections") {
    const items = registryState.sections.runtime_injections?.items || [];
    return items.map((it) => it.text || "").filter(Boolean).join("\n\n") || "[runtime injections]";
  }

  // sentiment.scale — per-item scale object
  if (token === "sentiment.scale") {
    const sec = registryState.sections.sentiment;
    const idx = previewSelections["sentiment"] ?? 0;
    const item = sec?.items[idx];
    const scale = item?.scale || {};
    const desc = Array.isArray(scale.scale_descriptor)
      ? (scale.scale_descriptor[0] || item?.id || "feeling")
      : (scale.scale_descriptor || item?.id || "feeling");
    const tmpl = scale.template || "{value}/10 — {scale_descriptor}.";
    return tmpl.replace("{value}", String(scale.default_value ?? 5)).replace("{scale_descriptor}", desc);
  }

  // personas.groups / sentiment.groups — render group items for selected item
  if (token === "personas.groups" || token === "sentiment.groups") {
    const secKey = token.split(".")[0];
    const sec = registryState.sections[secKey];
    const idx = previewSelections[secKey] ?? 0;
    const item = sec?.items[idx];
    if (!item || !Array.isArray(item.groups) || !item.groups.length) return "";
    return item.groups.map((gOrId) => {
      const group = typeof gOrId === "string"
        ? { id: gOrId, pre_context: "", items: [] }
        : gOrId;
      if (!group) return "";
      const header = group.pre_context ? group.pre_context + "\n" : "";
      return Array.isArray(group.items) && group.items.length
        ? header + group.items.map((x) => `- ${x}`).join("\n")
        : "";
    }).filter(Boolean).join("\n\n");
  }

  const parts = token.split(".");
  const rawSec = parts[0];
  const secKey = ALIAS[rawSec] || rawSec;
  const sec = registryState.sections[secKey];
  if (!sec) return "";

  const idx = previewSelections[secKey] ?? 0;
  const item = sec.items[idx];
  if (!item) return "";

  if (parts.length === 1) {
    if (Array.isArray(item.items) && item.items.length) {
      return item.items.map((x) => `- ${x}`).join("\n");
    }
    return item.text || item.context || "";
  }

  const sub = parts.slice(1).join(".");

  // Named item lookup (e.g. prompt_endings.endings, base_context.stream_context)
  const namedItem = sec.items.find((it) => (it.id || it.name) === sub);
  const resolveItem = namedItem || (secKey === "prompt_endings" ? sec.items[0] : null);
  if (resolveItem) {
    const hasSubItems = Array.isArray(resolveItem.items) && resolveItem.items.length;
    const itemText = typeof resolveItem.text === "string" && resolveItem.text.trim() ? resolveItem.text : "";
    if (hasSubItems) {
      const header = resolveItem.pre_context ? resolveItem.pre_context + "\n" : "";
      const labelPart = header + resolveItem.items[0];
      return itemText ? itemText + "\n\n" + labelPart : labelPart;
    }
    return itemText || resolveItem.context || "";
  }

  // Field on selected item (e.g. personas.context, sentiment.context)
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
  const ALIAS = { persona: "personas", injections: "runtime_injections" };
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

function isPromptEndingsToken(token) {
  return token === "prompt_endings" || token.startsWith("prompt_endings.");
}

function moveAssemblyToken(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= registryState.assembly_order.length) return;
  const arr = registryState.assembly_order;
  // prompt_endings tokens must stay after all non-prompt_endings tokens
  if (delta < 0 && isPromptEndingsToken(arr[index]) && !isPromptEndingsToken(arr[next])) return;
  if (delta > 0 && !isPromptEndingsToken(arr[index]) && isPromptEndingsToken(arr[next])) return;
  [arr[index], arr[next]] = [arr[next], arr[index]];
  renderAssemblyOrderEditor();
  exportFullModel();
}

function dynamicAssemblyVariants() {
  const namedItems = (secKey, alias = secKey, prefix = SECTION_LABELS[secKey]) =>
    (registryState.sections[secKey]?.items || [])
      .map((item) => item.id || item.name)
      .filter(Boolean)
      .map((id) => ({
        token: `${alias}.${id}`,
        label: `${prefix}: ${id}`,
      }));

  return {
    base_context: namedItems("base_context", "base_context", "Base Context"),
    output_prompt_directions: namedItems("output_prompt_directions", "output_prompt_directions", "Output Direction"),
    prompt_endings: namedItems("prompt_endings", "prompt_endings", "Prompt Ending"),
    injections: namedItems("static_injections", "static_injections", "Static Injection"),
  };
}

function describeAssemblyToken(token) {
  if (token === "base_context" || token === "base_context.text") {
    return { title: "Base Context", detail: "Adds the scene or task framing." };
  }
  if (token.startsWith("base_context.")) {
    return { title: `Base Context: ${token.split(".").slice(1).join(".")}`, detail: "Adds one named base context item." };
  }
  if (token === "output_prompt_directions") {
    return { title: "Output Directions", detail: "Adds all output direction items." };
  }
  if (token.startsWith("output_prompt_directions.")) {
    return { title: `Output Direction: ${token.split(".").slice(1).join(".")}`, detail: "Adds one named output-direction item." };
  }
  if (token === "personas.context") {
    return { title: "Personas — context", detail: "Adds the chosen persona's context text." };
  }
  if (token === "personas.groups") {
    return { title: "Personas — groups", detail: "Adds directive/example groups attached to the chosen persona." };
  }
  if (token === "sentiment.context") {
    return { title: "Sentiment — context", detail: "Adds the chosen sentiment's context text." };
  }
  if (token === "sentiment.groups") {
    return { title: "Sentiment — groups", detail: "Adds nudge/example groups attached to the chosen sentiment." };
  }
  if (token === "sentiment.scale") {
    return { title: "Sentiment — scale", detail: "Adds the sentiment slider value and descriptor line." };
  }
  if (token.startsWith("groups[")) {
    const id = token.slice(7, -1);
    return { title: `Group: ${id}`, detail: `Adds the "${id}" group's items directly (ignores persona/sentiment selection).` };
  }
  if (token === "static_injections") {
    return { title: "Static Injections", detail: "Adds all selected static injection content." };
  }
  if (token.startsWith("static_injections.")) {
    return { title: `Static Injection: ${token.slice("static_injections.".length)}`, detail: "Adds one named static injection entry." };
  }
  if (token === "injections" || token === "runtime_injections") {
    return { title: "Runtime Injections", detail: "Adds active runtime injection content." };
  }
  if (token === "memory_recall.text" || token === "memory_recall") {
    return { title: "Memory Recall", detail: "Inserts retrieved memory context." };
  }
  if (token === "user_message.text" || token === "user_message") {
    return { title: "User Message", detail: "Inserts the user's message, optionally prefixed with their name." };
  }
  if (token === "prompt_endings" || token.startsWith("prompt_endings.")) {
    const name = token.startsWith("prompt_endings.") ? token.slice("prompt_endings.".length) : null;
    const item = name
      ? (registryState.sections.prompt_endings?.items || []).find((it) => (it.id || it.name) === name)
      : (registryState.sections.prompt_endings?.items || [])[0];
    const hasText = item && typeof item.text === "string" && item.text.trim();
    const hasLabel = item && Array.isArray(item.items) && item.items.length;
    const detail = hasText && hasLabel
      ? `Preamble text + "${item.items[0]}"`
      : hasLabel
        ? `Ending label: "${item.items[0]}"`
        : hasText
          ? "Preamble text only (no ending label yet)"
          : "Prompt Endings — add items in the Sections tab.";
    return { title: "Prompt Endings", detail };
  }
  return { title: "Custom Token", detail: "Advanced token — preserved exactly as typed." };
}

function assemblyGroups() {
  const dynamic = dynamicAssemblyVariants();

  return [
    {
      title: "Common Tokens",
      items: [
        { token: "output_prompt_directions", label: "Output Directions" },
        { token: "base_context.text", label: "Base Context — text" },
        { token: "personas.context", label: "Personas — context" },
        { token: "personas.groups", label: "Personas — groups" },
        { token: "sentiment.context", label: "Sentiment — context" },
        { token: "sentiment.groups", label: "Sentiment — groups" },
        { token: "sentiment.scale", label: "Sentiment — scale" },
        { token: "memory_recall.text", label: "Memory Recall" },
        { token: "static_injections", label: "Static Injections" },
        { token: "injections", label: "Runtime Injections" },
        { token: "prompt_endings.endings", label: "Prompt Endings" },
      ],
    },
    {
      title: "Named Items",
      items: [
        ...dynamic.base_context,
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
    const order = registryState.assembly_order;
    host.innerHTML = order
      .map((token, i) => {
        const meta = describeAssemblyToken(token);
        const isEnding = isPromptEndingsToken(token);
        const prevIsNonEnding = i > 0 && !isPromptEndingsToken(order[i - 1]);
        const upDisabled = i === 0 || (isEnding && prevIsNonEnding) ? " disabled" : "";
        const downDisabled = i === order.length - 1 ? " disabled" : "";
        const endingBadge = isEnding ? `<span class="assembly-step-badge">last</span>` : "";
        return `<div class="assembly-step-card">` +
          `<div class="assembly-step-number">${i + 1}</div>` +
          `<div class="assembly-step-copy">` +
          `<div class="assembly-step-title">${escapeHtml(meta.title)}${endingBadge}</div>` +
          `<div class="assembly-step-detail">${escapeHtml(meta.detail)}</div>` +
          `<div class="assembly-step-token">${escapeHtml(token)}</div>` +
          `</div>` +
          `<span class="assembly-chip-controls">` +
          `<button type="button" class="assembly-chip-btn"${upDisabled} onclick="moveAssemblyToken(${i}, -1)" title="Move up">Up</button>` +
          `<button type="button" class="assembly-chip-btn"${downDisabled} onclick="moveAssemblyToken(${i}, 1)" title="Move down">Down</button>` +
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

function addEntryVar(type, uiId, rawVal) {
  const varName = (rawVal || "").trim().replace(/^\{|\}$/g, "");
  if (!varName) return;
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (!Array.isArray(entry.template_vars)) entry.template_vars = [];
  if (!entry.template_vars.includes(varName)) {
    entry.template_vars.push(varName);
    renderItems(type);
    exportFullModel();
  }
}

function removeEntryVar(type, uiId, varName) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry || !Array.isArray(entry.template_vars)) return;
  entry.template_vars = entry.template_vars.filter((v) => v !== varName);
  renderItems(type);
  exportFullModel();
}

function updateSectionStatus(key, isRequired) {
  registryState.sections[key].required = isRequired;
  exportFullModel();
}


function addEntry(type) {
  const entry = { _ui_id: Date.now() + Math.random() };
  if (type === "runtime_injections") {
    entry.id = "new_injection";
    entry.required = false;
    entry.text = "";
    entry.template_vars = [];
  } else if (type === "personas") {
    entry.id = "";
    entry.context = "";
    entry.groups = [];
  } else if (type === "sentiment") {
    entry.id = "";
    entry.context = "";
    entry.scale = { scale_descriptor: "", template: "{value}/10 — {scale_descriptor}.", default_value: 5 };
    entry.groups = [];
  } else if (type === "groups") {
    entry.id = "";
    entry.pre_context = "";
    entry.items = [];
  } else if (type === "memory_recall") {
    entry.name = "recall";
    entry.text = "{memory_recall}";
  } else if (type === "user_message") {
    entry.name = "incoming";
    entry.text = "{user_input}";
  } else if (type === "prompt_endings") {
    entry.name = "endings";
    entry.text = "";
    entry.items = [];
  } else {
    // base_context, static_injections, output_prompt_directions
    entry.id = "";
    entry.text = "";
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

// ── Inline group editors (for personas / sentiment items) ────────────

function renderInlineGroups(type, uiId, groups) {
  const rows = groups.map((g, gIdx) => {
    if (typeof g === "string") {
      // String ID reference — show as a read-only badge with option to expand inline
      return `<div class="inline-group-ref">
        <span class="inline-group-ref-id">${escapeHtml(g)}</span>
        <span class="label-hint"> (top-level reference)</span>
        <button type="button" class="list-item-remove" onclick="removeInlineGroup('${type}',${uiId},${gIdx})" title="Remove">×</button>
      </div>`;
    }
    const itemRows = (g.items || []).map((val, iIdx) =>
      `<div class="list-item-row">
        <input type="text" value="${escapeHtml(val)}"
          oninput="updateInlineGroupItem('${type}',${uiId},${gIdx},${iIdx},this.value)"
          placeholder="item ${iIdx + 1}">
        <button type="button" class="list-item-remove"
          onclick="removeInlineGroupItem('${type}',${uiId},${gIdx},${iIdx})" title="Remove">×</button>
      </div>`
    ).join("");
    return `<details class="inline-group-card" open>
      <summary class="inline-group-summary">
        <span class="inline-group-id">${escapeHtml(g.id || "(unnamed)")}</span>
        <button type="button" class="list-item-remove" style="margin-left:auto"
          onclick="event.preventDefault();removeInlineGroup('${type}',${uiId},${gIdx})" title="Remove group">×</button>
      </summary>
      <div class="inline-group-body">
        <label>ID</label>
        <input type="text" value="${escapeHtml(g.id || "")}"
          oninput="updateInlineGroupField('${type}',${uiId},${gIdx},'id',this.value,this)" class="mb-2">
        <label>Pre-context <span class="label-hint">header line before the list</span></label>
        <input type="text" value="${escapeHtml(g.pre_context || "")}"
          placeholder="e.g. You should: or Example phrases:"
          oninput="updateInlineGroupField('${type}',${uiId},${gIdx},'pre_context',this.value)" class="mb-2">
        <label>Items</label>
        <div class="list-field">
          ${itemRows}
          <button type="button" class="list-item-add"
            onclick="addInlineGroupItem('${type}',${uiId},${gIdx})">+ Add Item</button>
        </div>
      </div>
    </details>`;
  }).join("");

  return `<div class="inline-groups-list">${rows}</div>
    <button type="button" class="list-item-add mt-1"
      onclick="addInlineGroup('${type}',${uiId})">+ Add Group</button>`;
}

function _getEntry(type, uiId) {
  return registryState.sections[type].items.find((e) => e._ui_id === uiId);
}

function addInlineGroup(type, uiId) {
  const entry = _getEntry(type, uiId);
  if (!entry) return;
  if (!Array.isArray(entry.groups)) entry.groups = [];
  entry.groups.push({ id: "", pre_context: "", items: [] });
  renderItems(type);
  exportFullModel();
}

function removeInlineGroup(type, uiId, gIdx) {
  const entry = _getEntry(type, uiId);
  if (!entry || !Array.isArray(entry.groups)) return;
  entry.groups.splice(gIdx, 1);
  renderItems(type);
  exportFullModel();
}

function updateInlineGroupField(type, uiId, gIdx, field, value, el) {
  const entry = _getEntry(type, uiId);
  if (!entry || !entry.groups || !entry.groups[gIdx]) return;
  entry.groups[gIdx][field] = value;
  if (field === "id" && el) {
    const card = el.closest(".inline-group-card");
    if (card) {
      const span = card.querySelector(".inline-group-id");
      if (span) span.textContent = value || "(unnamed)";
    }
  }
  exportFullModel();
}

function addInlineGroupItem(type, uiId, gIdx) {
  const entry = _getEntry(type, uiId);
  if (!entry || !entry.groups || !entry.groups[gIdx]) return;
  if (!Array.isArray(entry.groups[gIdx].items)) entry.groups[gIdx].items = [];
  entry.groups[gIdx].items.push("");
  renderItems(type);
  exportFullModel();
}

function removeInlineGroupItem(type, uiId, gIdx, iIdx) {
  const entry = _getEntry(type, uiId);
  if (!entry || !entry.groups?.[gIdx]) return;
  entry.groups[gIdx].items.splice(iIdx, 1);
  renderItems(type);
  exportFullModel();
}

function updateInlineGroupItem(type, uiId, gIdx, iIdx, value) {
  const entry = _getEntry(type, uiId);
  if (!entry || !entry.groups?.[gIdx]) return;
  entry.groups[gIdx].items[iIdx] = value;
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
      const tvars = entry.template_vars || [];
      const varBadges = tvars.map((v) =>
        `<span class="var-badge" title="Click to remove" onclick="removeEntryVar('runtime_injections', ${entry._ui_id}, '${escapeHtml(v)}')">{${escapeHtml(v)}}</span>`
      ).join(" ");
      const varHint = tvars.length
        ? `use ${tvars.map((v) => `<code>{${escapeHtml(v)}}</code>`).join(", ")} in the text`
        : "add template vars above to reference them as <code>{var_name}</code>";
      html = `
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label>Injection ID</label>
            <input type="text" value="${escapeHtml(entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)">
          </div>
          <div>
            <label>Usage</label>
            <select onchange="updateField('${type}', ${entry._ui_id}, 'required', this.value === 'true')">
              <option value="false" ${!entry.required ? "selected" : ""}>Optional</option>
              <option value="true" ${entry.required ? "selected" : ""}>Required</option>
            </select>
          </div>
        </div>
        <div class="mb-3">
          <label>Template Vars <span class="label-hint">declared vars can be used as <code>{var_name}</code> in the text below</span></label>
          <div class="entry-var-badges">${varBadges || '<span class="label-hint">none — add one below</span>'}</div>
          <div class="entry-var-add-row">
            <input type="text" id="entry-var-input-${entry._ui_id}" class="entry-var-input" placeholder="var_name"
              onkeydown="if(event.key==='Enter'){addEntryVar('runtime_injections',${entry._ui_id},this.value);this.value='';event.preventDefault();}">
            <button type="button" class="btn-add-inline"
              onclick="addEntryVar('runtime_injections',${entry._ui_id},document.getElementById('entry-var-input-${entry._ui_id}').value);document.getElementById('entry-var-input-${entry._ui_id}').value=''">+ Var</button>
          </div>
        </div>
        <div>
          <label>Text <span class="label-hint">${varHint}</span></label>
          <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${escapeHtml(entry.text || "")}</textarea>
        </div>
      `;
    } else if (type === "personas") {
      html = `
        <label>ID</label>
        <input type="text" value="${escapeHtml(entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Context</label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'context', this.value)">${escapeHtml(entry.context || "")}</textarea>
        <label class="mt-2">Groups</label>
        ${renderInlineGroups(type, entry._ui_id, entry.groups || [])}
      `;
    } else if (type === "sentiment") {
      const scale = entry.scale || {};
      const descRaw = scale.scale_descriptor;
      const descVal = Array.isArray(descRaw) ? descRaw.join("\n") : (descRaw || "");
      html = `
        <label>ID</label>
        <input type="text" value="${escapeHtml(entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Context</label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'context', this.value)">${escapeHtml(entry.context || "")}</textarea>
        <label class="mt-2">Groups</label>
        ${renderInlineGroups(type, entry._ui_id, entry.groups || [])}
        <details class="mt-2">
          <summary class="label" style="cursor:pointer">Scale settings</summary>
          <div class="mt-2">
            <label>Scale Descriptor <span class="label-hint">string or multiple lines → becomes a random-pick array</span></label>
            <textarea rows="3" oninput="updateScaleField('${type}', ${entry._ui_id}, 'scale_descriptor', this.value)">${escapeHtml(descVal)}</textarea>
            <label class="mt-2">Template <span class="label-hint">use <code>{value}</code> and <code>{scale_descriptor}</code></span></label>
            <input type="text" value="${escapeHtml(scale.template || "")}"
              placeholder="{value}/10 — {scale_descriptor}."
              oninput="updateScaleField('${type}', ${entry._ui_id}, 'template', this.value)">
            <div class="grid grid-cols-3 gap-3 mt-2">
              <div>
                <label>Default</label>
                <input type="number" step="0.5" value="${scale.default_value ?? 5}"
                  oninput="updateScaleField('${type}', ${entry._ui_id}, 'default_value', +this.value)">
              </div>
              <div>
                <label>Min</label>
                <input type="number" step="0.5" value="${scale.min_value ?? 1}"
                  oninput="updateScaleField('${type}', ${entry._ui_id}, 'min_value', +this.value)">
              </div>
              <div>
                <label>Max</label>
                <input type="number" step="0.5" value="${scale.max_value ?? 10}"
                  oninput="updateScaleField('${type}', ${entry._ui_id}, 'max_value', +this.value)">
              </div>
            </div>
          </div>
        </details>
      `;
    } else if (type === "groups") {
      html = `
        <label>ID</label>
        <input type="text" value="${escapeHtml(entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Pre-context <span class="label-hint">header line printed before the list (e.g. "You should:" or "Example phrases:")</span></label>
        <input type="text" value="${escapeHtml(entry.pre_context || "")}"
          oninput="updateField('${type}', ${entry._ui_id}, 'pre_context', this.value)" class="mb-2">
        <label>Items</label>
        ${renderListField(type, entry._ui_id, 'items', entry.items)}
      `;
    } else if (type === "prompt_endings") {
      html = `
        <label>Name <span class="label-hint">used as the assembly token suffix — e.g. "endings" → <code>prompt_endings.endings</code></span></label>
        <input type="text" value="${escapeHtml(entry.name || entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'name', this.value)" class="mb-2">
        <label>Preamble text <span class="label-hint">rendered before the ending label — supports template vars declared on this section</span></label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)" class="mb-2">${escapeHtml(entry.text || "")}</textarea>
        <label>Ending labels <span class="label-hint">one label per line — one is picked randomly at runtime (e.g. "Support reply:")</span></label>
        ${renderListField(type, entry._ui_id, 'items', entry.items)}
      `;
    } else if (type === "memory_recall") {
      html = `
        <label>Name/ID</label>
        <input type="text" value="${escapeHtml(entry.name || entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'name', this.value)" class="mb-2">
        <label>Text <span class="label-hint">use <code>{memory_recall}</code> as the placeholder</span></label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${escapeHtml(entry.text || "")}</textarea>
      `;
    } else if (type === "user_message") {
      html = `
        <label>Name/ID</label>
        <input type="text" value="${escapeHtml(entry.name || entry.id || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'name', this.value)" class="mb-2">
        <label>Text <span class="label-hint">use <code>{user_input}</code> for the message; add <code>{other_name}</code> or other vars as needed</span></label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${escapeHtml(entry.text || "")}</textarea>
      `;
    } else {
      const memTagRow = "";
      html = `
        <label>ID</label>
        <input type="text" value="${escapeHtml(entry.id || entry.name || "")}" oninput="updateField('${type}', ${entry._ui_id}, 'id', this.value)" class="mb-2">
        <label>Text</label>
        <textarea oninput="updateField('${type}', ${entry._ui_id}, 'text', this.value)">${escapeHtml(entry.text || "")}</textarea>
        ${memTagRow}
      `;
    }

    card.innerHTML = `<button onclick="removeEntry('${type}', ${entry._ui_id})" class="btn-delete">REMOVE</button>${html}`;
    container.appendChild(card);
  });

}


function updateField(type, uiId, field, value) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (field === "groups" || field === "items") {
    // groups and items are always arrays — split on newlines
    entry[field] = String(value).split("\n").map((s) => s.trim()).filter(Boolean);
  } else {
    entry[field] = value;
  }
  if (field === "id") renderAssemblyOrderEditor();
  exportFullModel();
}

function updateScaleField(type, uiId, field, value) {
  const entry = registryState.sections[type].items.find((e) => e._ui_id === uiId);
  if (!entry) return;
  if (!entry.scale) entry.scale = {};
  if (field === "scale_descriptor") {
    const lines = String(value).split("\n").map((s) => s.trim()).filter(Boolean);
    entry.scale.scale_descriptor = lines.length > 1 ? lines : (lines[0] || "");
  } else {
    entry.scale[field] = value;
  }
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
  // default_state and any other unrecognised top-level keys round-trip via extraTopLevel
  for (const [k, v] of Object.entries(reg)) {
    if (!knownTopLevel.has(k)) next.extraTopLevel[k] = v;
  }

  // Build a lookup from any top-level groups section so string ID refs can be inlined.
  const topLevelGroupIndex = {};
  for (const g of (reg.groups?.items || [])) {
    const id = g.id || g.name;
    if (id) topLevelGroupIndex[id] = g;
  }

  function inlineGroupRefs(groups) {
    if (!Array.isArray(groups)) return [];
    return groups.map((g) => {
      if (typeof g !== "string") return g;
      const found = topLevelGroupIndex[g];
      return found
        ? { id: found.id || found.name || g, pre_context: found.pre_context || "", items: [...(found.items || [])] }
        : { id: g, pre_context: "", items: [] };
    });
  }

  SECTION_KEYS.forEach((key) => {
    const importedSection = reg[key] || {};
    const { required, template_vars, template_var_defaults, items, ...extras } = importedSection;
    next.sections[key] = {
      required: required !== undefined ? required : next.sections[key].required,
      template_vars: Array.isArray(template_vars) ? [...template_vars] : [],
      extras,
      items: (items || []).map((item) => {
        const entry = { ...item, _ui_id: Date.now() + Math.random() };
        if (key === "runtime_injections" && !Array.isArray(entry.template_vars)) entry.template_vars = [];
        if ((key === "personas" || key === "sentiment") && Array.isArray(entry.groups)) {
          entry.groups = inlineGroupRefs(entry.groups);
        }
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

function checkMemoryConfigErrors() {
  const rules = registryState.memory_rules;
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const cfg = { ...( registryState.memory_config || {}), ...readMemoryConfig() };
  if (!cfg.embed_model) return "embed_model is required in memory_config when memory rules are defined.";
  return null;
}

async function validateRegistry() {
  const memErr = checkMemoryConfigErrors();
  if (memErr) { setValidationStatus(`Validation failed: ${memErr}`, false); return; }
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
  const memErr = checkMemoryConfigErrors();
  if (memErr) { alert(`Cannot open in Studio: ${memErr}`); return; }
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
    // user_message is now handled by prompt_endings — hide from the sections list
    if (key === "user_message") return;
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
    body: "The foundational framing for the prompt — describes the task, scene, or system role. Template variables like {location} let the runtime slot in specific values. Supports optional fragments: conditional text blocks that only render when a template variable is non-empty.",
    fields: ["id — identifier", "text — the main framing text", "fragments — optional conditional text blocks (each has id, condition, text)"],
  },
  personas: {
    title: "Personas",
    body: "Named character or role configurations. Studio selects one at runtime. Each persona references one or more groups from the Groups section — these provide the behavioural directives specific to that persona.",
    fields: ["id — identifier used for selection", "context — who this persona is", "groups — list of group IDs from the Groups section"],
  },
  sentiment: {
    title: "Sentiment Contexts",
    body: "Tone or mood overlays. Each sentiment item has a context description, optional groups (nudges/examples), and a scale object that renders the slider value into a descriptive line in the prompt.",
    fields: ["id — identifier", "context — tone framing", "groups — group IDs for nudges/examples", "scale — {scale_descriptor, template, default_value, min_value, max_value}"],
  },
  static_injections: {
    title: "Static Injections",
    body: "Fixed text blocks inserted in assembly order. Useful for boilerplate rules or safety content. Each injection is optional — include it in the assembly order to activate it, leave it out to skip it.",
    fields: ["id — identifier", "text — the injected content"],
  },
  runtime_injections: {
    title: "Runtime Injections",
    body: "Named text blocks placed in the assembly order via the Finalize tab. Each injection can declare its own template vars — use {var_name} in the text and the runtime will substitute values at generation time.",
    fields: ["id — identifier used in the assembly order", "required — whether the injection must fire", "text — the injected content (use {var_name} for template vars)", "template_vars — vars declared for use in this injection's text"],
  },
  output_prompt_directions: {
    title: "Output Directions",
    body: "Formatting and behaviour rules for the model's response. Rendered early in the prompt so the model sees them before the context. Multiple named items let you swap direction sets per scenario.",
    fields: ["id — identifier", "text — the directions text"],
  },
  memory_recall: {
    title: "Memory Recall",
    body: "Placeholder section for injecting retrieved memory context at runtime. Typically a single item whose text is just '{memory_recall}'. The memory engine fills this template var before hydration.",
    fields: ["name — identifier (usually 'recall')", "text — usually just {memory_recall}"],
  },
  prompt_endings: {
    title: "Prompt Endings",
    body: "Closing cue lines appended after all other content — e.g. 'Your message:' or 'Answer:'. One item is picked randomly per request. Keeps the prompt's final line consistent.",
    fields: ["id — identifier for the pool", "items — list of ending strings to choose from"],
  },
  groups: {
    title: "Groups",
    body: "Reusable lists of strings referenced by personas and sentiment items via their 'groups' field. Keeps directives and examples decoupled from the items that use them. Each group can have an optional pre_context heading.",
    fields: ["id — identifier (e.g. 'broadcasting_directives', 'positive_examples')", "pre_context — optional header line printed before the list", "items — list of strings"],
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

function getEmbedHelpHTML() { return `
<p>The embedding layer converts conversation text into vectors for semantic memory search. When a new message arrives, it's embedded and compared against stored conversation history to surface the most relevant past context — this becomes the <code>{memory_recall}</code> variable in your prompt.</p>
<p>Embedding calls are made directly from your browser to your local model — the server never touches your data. On memory-enabled runs the server opens a lightweight WebSocket to your browser and delegates embed requests to it; your text goes from browser to local model and back, not through the server.</p>
<h4>Do I need a separate embed URL?</h4>
<p>No. If unchecked, embedding runs against the same server as your classifier (<code>classifier_url</code>). Ollama serves both chat and embedding models on the same port, so one server is usually sufficient.</p>
<p>Enable this only if you want a dedicated embedding server — e.g. a different machine, a specialized service, or a separate Ollama instance.</p>
<h4>Getting an embedding model (Ollama)</h4>
<pre style="background:#1a1610;padding:8px 12px;border-radius:6px;font-size:12px;margin:8px 0">ollama pull nomic-embed-text</pre>
<p>Then run <code>ollama serve</code>. Default Ollama port is <strong>11434</strong>.</p>
<h4>Common embedding models</h4>
<ul>
  <li><code>nomic-embed-text</code> — fast, good general-purpose embeddings</li>
  <li><code>mxbai-embed-large</code> — higher quality, larger model</li>
  <li><code>all-minilm</code> — very small and quick</li>
</ul>
<h4>CORS</h4>
<p>Your Ollama / llama.cpp server needs to allow the Studio origin. Without it the browser's CORS check silently blocks the request and you'll see a "Can't reach server" failure that isn't actually a network problem.</p>
<div class="cors-tab-bar">
  <button type="button" id="cors-btn-win" class="cors-tab-btn cors-tab-active" onclick="switchCorsTab('win')">Windows (PowerShell)</button>
  <button type="button" id="cors-btn-nix" class="cors-tab-btn" onclick="switchCorsTab('nix')">Linux / macOS</button>
</div>
<pre id="cors-tab-win" class="cors-pre">$env:OLLAMA_ORIGINS="${window.location.origin}"
ollama serve</pre>
<pre id="cors-tab-nix" class="cors-pre" hidden>OLLAMA_ORIGINS=${window.location.origin} ollama serve</pre>`; }

function openEmbedHelp() {
  const modal = document.getElementById("info-modal");
  if (!modal) return;
  document.getElementById("info-modal-title").textContent = "Embedding Layer";
  document.getElementById("info-modal-body").innerHTML = getEmbedHelpHTML();
  modal.hidden = false;
}

function closeInfoModal() {
  const modal = document.getElementById("info-modal");
  if (modal) modal.hidden = true;
}

function switchCorsTab(which) {
  const win = document.getElementById("cors-tab-win");
  const nix = document.getElementById("cors-tab-nix");
  const btnWin = document.getElementById("cors-btn-win");
  const btnNix = document.getElementById("cors-btn-nix");
  if (win) win.hidden = which !== "win";
  if (nix) nix.hidden = which !== "nix";
  if (btnWin) btnWin.classList.toggle("cors-tab-active", which === "win");
  if (btnNix) btnNix.classList.toggle("cors-tab-active", which === "nix");
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

function toggleEmbedUrlSection() {
  const cb = document.getElementById("mem-use-embed-url");
  const sec = document.getElementById("mem-embed-url-section");
  if (sec) sec.hidden = !cb?.checked;
}

function readMemoryConfig() {
  const classifierUrl  = document.getElementById("mem-classifier-url")?.value?.trim();
  const classifierModel = document.getElementById("mem-classifier-model")?.value?.trim();
  const useEmbedUrl    = document.getElementById("mem-use-embed-url")?.checked;
  const embedUrl       = useEmbedUrl ? document.getElementById("mem-embed-url")?.value?.trim() : undefined;
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
  if (!window.STUDIO_CONFIG?.multi_tenant) {
    if (storePath) out.store_path = storePath;
    if (file)      out.personality_file = file;
  }
  const useClf = document.getElementById("mem-use-classifier");
  if (useClf && !useClf.checked) out.use_classifier = false;
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
  const resultEl = document.getElementById("mem-classifier-test-result");
  const urlEl = document.getElementById("mem-classifier-url");
  const conn = getStudioConnection();
  const base = (urlEl?.value?.trim() || conn.baseUrl || conn.base_url || "").replace(/\/+$/, "");
  if (!base) {
    if (resultEl) { resultEl.textContent = "⚠ no URL"; resultEl.className = "mem-test-result mem-test-warn"; }
    return;
  }
  const sel = document.getElementById("mem-classifier-model");
  if (sel) { sel.innerHTML = `<option value="">Loading…</option>`; }
  if (resultEl) { resultEl.textContent = "…"; resultEl.className = "mem-test-result"; }
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    let models = [];
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
    if (models.length) {
      _setClassifierModelSelect(models, registryState.memory_config?.classifier_model);
      if (resultEl) { resultEl.textContent = `✓ ${models.length} model${models.length === 1 ? "" : "s"}`; resultEl.className = "mem-test-result mem-test-ok"; }
    } else {
      if (sel) sel.innerHTML = `<option value="">— no models —</option>`;
      if (resultEl) { resultEl.textContent = "✗ no models"; resultEl.className = "mem-test-result mem-test-fail"; }
    }
    exportFullModel();
  } catch (err) {
    if (sel) sel.innerHTML = `<option value="">— fetch failed —</option>`;
    if (resultEl) { resultEl.textContent = "✗ failed"; resultEl.className = "mem-test-result mem-test-fail"; }
  }
}

async function testEmbedModel() {
  const resultEl = document.getElementById("mem-embed-test-result");
  const model = document.getElementById("mem-embed-model")?.value?.trim() || "nomic-embed-text";
  const useEmbed = document.getElementById("mem-use-embed-url")?.checked;
  const embedUrlEl = document.getElementById("mem-embed-url");
  const classifierUrlEl = document.getElementById("mem-classifier-url");
  const base = ((useEmbed ? embedUrlEl?.value?.trim() : null) || classifierUrlEl?.value?.trim() || "").replace(/\/+$/, "");
  if (!base) {
    if (resultEl) { resultEl.textContent = "⚠ no URL"; resultEl.className = "mem-test-result mem-test-warn"; }
    return;
  }
  if (resultEl) { resultEl.textContent = "…"; resultEl.className = "mem-test-result"; }
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8000);
    let dims = null;
    for (const [path, body] of [
      ["/api/embed",      { model, input: "test" }],
      ["/v1/embeddings",  { model, input: "test" }],
    ]) {
      try {
        const resp = await fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const vec = data.embeddings?.[0] ?? data.data?.[0]?.embedding ?? data.embedding;
        if (Array.isArray(vec) && vec.length) { dims = vec.length; break; }
      } catch {}
    }
    clearTimeout(timer);
    if (dims !== null) {
      if (resultEl) { resultEl.textContent = `✓ ${dims} dims`; resultEl.className = "mem-test-result mem-test-ok"; }
    } else {
      if (resultEl) { resultEl.textContent = "✗ no vectors"; resultEl.className = "mem-test-result mem-test-fail"; }
    }
  } catch {
    if (resultEl) { resultEl.textContent = "✗ failed"; resultEl.className = "mem-test-result mem-test-fail"; }
  }
}

function populateMemoryConfigInputs() {
  const cfg = registryState.memory_config || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
  set("mem-classifier-url",   cfg.classifier_url);
  const hasEmbedUrl = !!cfg.embed_url;
  const embedCb = document.getElementById("mem-use-embed-url");
  if (embedCb) embedCb.checked = hasEmbedUrl;
  const embedSec = document.getElementById("mem-embed-url-section");
  if (embedSec) embedSec.hidden = !hasEmbedUrl;
  set("mem-embed-url",        cfg.embed_url);
  set("mem-embed-model",      cfg.embed_model);
  set("mem-top-k",            cfg.top_k);
  set("mem-prune-keep",       cfg.prune_keep);
  set("mem-store-path",       cfg.store_path);
  set("mem-personality-file", cfg.personality_file);
  if (cfg.classifier_model) {
    _setClassifierModelSelect([cfg.classifier_model], cfg.classifier_model);
  }
  const useClf = document.getElementById("mem-use-classifier");
  if (useClf) useClf.checked = cfg.use_classifier !== false;
}

function addMemoryRule() {
  registryState.memory_rules.push({ tag: "", description: "", ending_text: "" });
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

function updateMemoryRuleDescription(idx, value) {
  registryState.memory_rules[idx].description = value;
  exportFullModel();
}

function updateMemoryRuleEndingText(idx, value) {
  registryState.memory_rules[idx].ending_text = value;
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
    host.innerHTML = `<div class="mem-empty">No rules yet. Add a rule to define a classifier tag.</div>`;
    return;
  }

  host.innerHTML = registryState.memory_rules.map((rule, rIdx) => {
    return `<div class="mem-rule-card">
      <div class="mem-rule-header">
        <input type="text" class="mem-rule-tag" value="${escapeHtml(rule.tag)}"
          placeholder="tag name (e.g. past_conflict)"
          oninput="updateMemoryRuleTag(${rIdx}, this.value)">
        <button type="button" class="mem-rule-remove" onclick="removeMemoryRule(${rIdx})">Remove Rule</button>
      </div>
      <textarea class="mem-rule-description" rows="2"
        placeholder="Classifier directions — describe when this tag applies so the classifier knows when to fire this rule."
        oninput="updateMemoryRuleDescription(${rIdx}, this.value)">${escapeHtml(rule.description || "")}</textarea>
      <label class="mem-rule-ending-label">Prompt ending injection <span class="label-hint">injected as <code>{rule_ending}</code> — appears after memory summary, before user message</span></label>
      <textarea class="mem-rule-ending" rows="2"
        placeholder="Optional: text added to the prompt ending when this rule fires."
        oninput="updateMemoryRuleEndingText(${rIdx}, this.value)">${escapeHtml(rule.ending_text || "")}</textarea>
    </div>`;
  }).join("");
}

const SNAP_KEY = "pl-registry-snapshots-v1";

function loadSavedRegistries() {
  try {
    return JSON.parse(localStorage.getItem(SNAP_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistSavedRegistries(arr) {
  localStorage.setItem(SNAP_KEY, JSON.stringify(arr));
}

function saveRegistry() {
  const payload = exportFullModel();
  if (!payload) return;
  const defaultName = registryState.title || "Untitled Registry";
  const name = prompt("Save registry as:", defaultName);
  if (!name) return;
  const snaps = loadSavedRegistries();
  const existing = snaps.findIndex((s) => s.name === name);
  const snap = { name, savedAt: new Date().toISOString(), registry: payload.registry };
  if (existing >= 0) {
    snaps[existing] = snap;
  } else {
    snaps.push(snap);
  }
  persistSavedRegistries(snaps);
  populateExamplePicker();
  setValidationStatus(`Saved as "${name}".`, true);
}

function loadSavedRegistry(name) {
  const snaps = loadSavedRegistries();
  const snap = snaps.find((s) => s.name === name);
  if (!snap) { alert(`Saved registry "${name}" not found.`); return; }
  applyRegistryJson({ registry: snap.registry });
  setValidationStatus(`Loaded "${name}".`, true);
}

function deleteSavedRegistry(name) {
  if (!confirm(`Delete saved registry "${name}"?`)) return;
  const snaps = loadSavedRegistries().filter((s) => s.name !== name);
  persistSavedRegistries(snaps);
  populateExamplePicker();
  setValidationStatus(`Deleted "${name}".`, false);
}

function handlePickerChange(value) {
  if (!value) return;
  if (value.startsWith("__saved__:")) {
    loadSavedRegistry(value.slice("__saved__:".length));
  } else {
    loadBuilderExample(value);
  }
}

async function populateExamplePicker() {
  const sel = document.getElementById("example-picker");
  if (!sel) return;

  let exampleOptions = "";
  try {
    const res = await fetch("/static/builder-examples/index.json", { cache: "no-cache" });
    if (res.ok) {
      const data = await res.json();
      const examples = data.examples || [];
      if (examples.length) {
        exampleOptions = `<optgroup label="Examples">` +
          examples.map((ex) => {
            const val = (ex.file || "").replace(/\.json$/, "");
            return `<option value="${escapeHtml(val)}">${escapeHtml(ex.name || val)}</option>`;
          }).join("") +
          `</optgroup>`;
      }
    }
  } catch (e) {
    console.warn("Could not load example index:", e);
  }

  const snaps = loadSavedRegistries();
  let savedOptions = "";
  if (snaps.length) {
    savedOptions = `<optgroup label="Saved">` +
      snaps.map((s) => {
        return `<option value="__saved__:${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`;
      }).join("") +
      `</optgroup>`;
  }

  sel.innerHTML = `<option value="">Load…</option>` + exampleOptions + savedOptions;
}

consumeStudioHandoff();
initApp();
populateExamplePicker();

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    window.STUDIO_CONFIG = cfg;
    if (cfg.multi_tenant) {
      const el = document.getElementById("mem-server-managed-paths");
      if (el) el.hidden = true;
    }
  })
  .catch(() => {});

window.toggleSection = toggleSection;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveModal = saveModal;
window.removeVar = removeVar;
window.updateSectionStatus = updateSectionStatus;
window.updateScaleField = updateScaleField;
window.addEntry = addEntry;
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
window.openEmbedHelp = openEmbedHelp;
window.closeInfoModal = closeInfoModal;
window.switchCorsTab = switchCorsTab;
window.switchPreviewTab = switchPreviewTab;
window.renderFlowView = renderFlowView;
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
window.updateMemoryRuleDescription = updateMemoryRuleDescription;
window.updateMemoryRuleEndingText = updateMemoryRuleEndingText;
window.populateExamplePicker = populateExamplePicker;
window.saveRegistry = saveRegistry;
window.loadSavedRegistry = loadSavedRegistry;
window.deleteSavedRegistry = deleteSavedRegistry;
window.handlePickerChange = handlePickerChange;
