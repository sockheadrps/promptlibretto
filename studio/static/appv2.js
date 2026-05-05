// promptlibretto studio — registry client.
//
// Reads/writes the registry JSON entirely client-side: import a registry,
// pick selections, set runtime modes, hydrate, and call the LLM via the
// user's local Ollama (browser-direct). Server is only used as a thin
// proxy through `/api/registry/*` if needed.

import { mountWorkspaceChip } from "/static/session.js";
import { mountConnectionChip, getConnection } from "/static/connection.js";
import { generate as ollamaGenerate, streamGenerate } from "/static/ollama_client.js";

const $ = (id) => document.getElementById(id);
const STUDIO_INBOX_KEY = "pl-studio-handoff-v1";
const BUILDER_INBOX_KEY = "pl-builder-handoff-v1";

// Mount header chips (workspace + connection indicator).
mountWorkspaceChip($("connection-slot"));
mountConnectionChip($("connection-slot"));

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Collect text fragments that came from sections whose content is randomly
// rotated per generation — either `section_random: true` (whole item gets
// rolled) or an `array_modes[field] = "random:N"` (specific list field
// rolls each turn). Used to mark these spans with a dashed underline so
// the user can see "this part will change next time."
function collectRandomMarkers(reg, sectionRandom, arrayModes) {
  const out = [];
  if (!reg) return out;
  for (const [secKey, sec] of Object.entries(reg)) {
    if (!sec || typeof sec !== "object" || !Array.isArray(sec.items)) continue;
    const wholeRandom = !!(sectionRandom && sectionRandom[secKey]);
    const modes = (arrayModes && arrayModes[secKey]) || {};
    const randomFields = Object.entries(modes)
      .filter(([, mode]) => typeof mode === "string" && mode.startsWith("random:"))
      .map(([f]) => f);

    for (const item of sec.items) {
      // When the WHOLE section is random-rolled, every candidate item is in
      // play for the next generation — mark all of their text content.
      if (wholeRandom) {
        for (const field of ["text", "context"]) {
          const v = item[field];
          if (typeof v === "string" && v.trim().length >= 4) {
            out.push({ key: `${secKey}::${field} (random item)`, value: v, kind: "random" });
          }
        }
      }
      // For random-array fields, every list element is a possible next pick.
      for (const f of randomFields) {
        const arr = item[f];
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
          if (typeof entry === "string" && entry.trim().length >= 4) {
            out.push({ key: `${secKey}.${f} (random:1)`, value: entry, kind: "random" });
          }
        }
      }
    }
  }
  return out;
}

// Build a list of fragment outcomes (which fired, which were skipped) for
// the footer summary. Returns: [{section, item, fragments: [{text, fired, var}]}]
function describeFragments(reg, tvarMap) {
  const out = [];
  if (!reg) return out;
  for (const [secKey, sec] of Object.entries(reg)) {
    if (!sec || typeof sec !== "object" || !Array.isArray(sec.items)) continue;
    for (const item of sec.items) {
      if (!Array.isArray(item.fragments) || !item.fragments.length) continue;
      const frags = item.fragments.map((f) => {
        const v = f.condition || f.if_var || f.var || "";
        const val = v ? String(tvarMap[`${secKey}::${v}`] || "").trim() : "";
        return {
          var: v,
          fired: !v || !!val,
          text: String(f.text || ""),
        };
      });
      out.push({ section: secKey, item: item.name || item.id || "(unnamed)", fragments: frags });
    }
  }
  return out;
}

function refreshTvarPreviews() {
  // Collect all current tvar input values from the DOM.
  const tvarMap = {};
  document.querySelectorAll("input[data-tvar]").forEach((inp) => {
    tvarMap[inp.dataset.tvar] = inp.value || "";
  });

  document.querySelectorAll(".tvar-preview[data-preview-section]").forEach((el) => {
    const secKey = el.dataset.previewSection;
    // Read the current textarea value from the sibling in the same label.
    const textarea = el.closest("label")?.querySelector("textarea");
    if (!textarea) { el.textContent = ""; el.style.display = "none"; return; }
    const text = textarea.value || "";
    // Substitute all {var} patterns found in this section's tvar namespace.
    let resolved = text;
    let anySubstituted = false;
    for (const [key, val] of Object.entries(tvarMap)) {
      if (!key.startsWith(`${secKey}::`)) continue;
      const varName = key.slice(secKey.length + 2);
      const placeholder = `{${varName}}`;
      if (resolved.includes(placeholder) && val.trim()) {
        resolved = resolved.replaceAll(placeholder, val.trim());
        anySubstituted = true;
      }
    }
    if (!anySubstituted || resolved === text) {
      el.textContent = "";
      el.style.display = "none";
    } else {
      el.textContent = resolved;
      el.style.display = "";
    }
  });
}

// Walk `text`, longest-match-wins over the combined `markers` list, and
// emit HTML wrapping each match in a kind-specific span.
function _decorateText(text, markers) {
  if (!markers.length) return escapeHtml(text);
  // Sort longest first so subsumed matches don't shadow.
  markers = [...markers].sort((a, b) => b.value.length - a.value.length);
  let out = "";
  let i = 0;
  while (i < text.length) {
    let best = null;
    for (const m of markers) {
      if (text.startsWith(m.value, i) &&
          (!best || m.value.length > best.value.length)) {
        best = m;
      }
    }
    if (best) {
      const cls = best.kind === "random" ? "random-injection" : "tvar-injection";
      out += `<span class="${cls}" title="${escapeHtml(best.key)}">${escapeHtml(best.value)}</span>`;
      i += best.value.length;
    } else {
      const ch = text[i];
      out += (ch === "&" || ch === "<" || ch === ">" || ch === '"' || ch === "'")
        ? escapeHtml(ch)
        : ch;
      i++;
    }
  }
  return out;
}

// Flatten v2 state (sections dict) into legacy flat maps for decorators.
function _flattenV2State(state) {
  if (!state || typeof state !== "object") return { tvarMap: {}, secRandom: {}, arrayModes: {}, sliderRandom: {} };
  const tvarMap = {}, secRandom = {}, arrayModes = {}, sliderRandom = {};
  for (const [key, sec] of Object.entries(state)) {
    if (!sec || typeof sec !== "object") continue;
    if (sec.template_vars) Object.assign(tvarMap, sec.template_vars);
    if (sec.section_random) secRandom[key] = true;
    if (sec.slider_random) sliderRandom[key] = true;
    if (sec.array_modes && typeof sec.array_modes === "object") {
      arrayModes[key] = { ...sec.array_modes };
    }
  }
  return { tvarMap, secRandom, arrayModes, sliderRandom };
}

// Combined decorator used by Pre-generate: highlight tvar injections AND
// mark spans coming from random-rotated sections, plus return a summary
// note about fragments and randomization.
// state is v2 format: { secKey: { selected, slider, array_modes, template_vars, ... } }
function decoratePromptOutput(text, registry, state) {
  const { tvarMap, secRandom, arrayModes, sliderRandom } = _flattenV2State(state);
  const reg = registry?.registry || registry || {};
  const tvars = Object.entries(tvarMap)
    .map(([k, v]) => ({ key: k, value: String(v == null ? "" : v), kind: "tvar" }))
    .filter((e) => e.value.trim().length >= 2);
  const randoms = collectRandomMarkers(reg, secRandom, arrayModes);
  const html = _decorateText(text, [...tvars, ...randoms]);

  // Fragment summary
  const fragInfo = describeFragments(reg, tvarMap);
  const noteLines = [];
  for (const e of fragInfo) {
    const fired = e.fragments.filter((f) => f.fired);
    const skipped = e.fragments.filter((f) => !f.fired);
    if (skipped.length) {
      noteLines.push(
        `<div class="pregen-note-line">` +
        `<span class="muted">${escapeHtml(e.section)}.${escapeHtml(e.item)}:</span> ` +
        `${fired.length} fragment${fired.length === 1 ? "" : "s"} fired, ` +
        `${skipped.length} skipped (vars empty: ${skipped.map((f) => `<code>${escapeHtml(f.var)}</code>`).join(", ")})` +
        `</div>`
      );
    }
  }
  const randomSliderKeys = Object.keys(sliderRandom).filter((k) => sliderRandom[k]);
  if (randomSliderKeys.length) {
    noteLines.push(`<div class="pregen-note-line"><span class="muted">random sliders:</span> ${randomSliderKeys.map(escapeHtml).join(", ")}</div>`);
  }
  const randomSecs = Object.keys(secRandom).filter((k) => secRandom[k]);
  if (randomSecs.length) {
    noteLines.push(`<div class="pregen-note-line"><span class="muted">random section items:</span> ${randomSecs.map(escapeHtml).join(", ")}</div>`);
  }
  const allModeEntries = [];
  for (const [k, modes] of Object.entries(arrayModes)) {
    for (const [field, mode] of Object.entries(modes || {})) {
      if (typeof mode === "string") {
        allModeEntries.push({ key: `${k}.${field}`, mode });
      }
    }
  }
  if (allModeEntries.length) {
    const parts = allModeEntries.map(({ key, mode }) => `${escapeHtml(key)}: <em>${escapeHtml(mode)}</em>`);
    noteLines.push(`<div class="pregen-note-line"><span class="muted">input strategies:</span> ${parts.join(", ")}</div>`);
  }

  const note = noteLines.length
    ? `<div class="pregen-note">${noteLines.join("")}</div>`
    : "";
  return { html, note };
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function renderMarkdown(text) {
  const source = String(text == null ? "" : text).replace(/\r\n/g, "\n");
  if (!source.trim()) return "";
  const blocks = source.split(/\n{2,}/);
  const html = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const fence = trimmed.match(/^```(\w+)?\n([\s\S]*?)\n?```$/);
    if (fence) {
      html.push(`<pre class="md-code"><code>${escapeHtml(fence[2])}</code></pre>`);
      continue;
    }

    const lines = trimmed.split("\n");
    if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
      html.push(
        `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.trim().replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`
      );
      continue;
    }
    if (lines.every((line) => /^\d+[.)]\s+/.test(line.trim()))) {
      html.push(
        `<ol>${lines.map((line) => `<li>${renderInlineMarkdown(line.trim().replace(/^\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    html.push(`<p>${lines.map(renderInlineMarkdown).join("<br>")}</p>`);
  }

  return html.join("");
}

// ─── Tab switching (compose / state / tuning) ──────────────────

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.dataset.tab !== name;
    });
  });
}

for (const tab of document.querySelectorAll(".output-tab")) {
  tab.addEventListener("click", () => {
    const name = tab.dataset.outputTab;
    document.querySelectorAll(".output-tab").forEach((t) => {
      const active = t.dataset.outputTab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".output-panel-body").forEach((p) => {
      p.hidden = p.dataset.outputTab !== name;
    });
  });
}

// ─── View toggle (rendered/raw) ───────────────────────────────
if ($("view-rendered") && $("view-raw")) {
  $("view-rendered").addEventListener("click", () => {
    $("view-rendered").classList.add("active");
    $("view-raw").classList.remove("active");
    $("output-rendered").hidden = false;
    $("output-raw").hidden = true;
  });
  $("view-raw").addEventListener("click", () => {
    $("view-raw").classList.add("active");
    $("view-rendered").classList.remove("active");
    $("output-raw").hidden = false;
    $("output-rendered").hidden = true;
  });
}

// Stage toggle: reveal stream/debug switches + gen-controls-sep when a
// stage exists, matching v2's UX. Low-priority polish — reveal them
// unconditionally here so users can flip while testing.
document.querySelectorAll("label.switch[hidden], .gen-controls-sep[hidden]").forEach(
  (el) => (el.hidden = false)
);

// ─── Registry import (Compose tab) ─────────────────────────────
//
// Imports a registry JSON of the shape produced by templatebuilder.html:
//   { "registry": { version, title, description, assembly_order, <section>: { required, template_vars, items, ...tool_state } }, generation?, output_policy? }
//
// Renders a select (required, single-choice) or checkboxes (optional, multi)
// for each section that has items, plus text inputs for each section's
// template_vars. Walks assembly_order to hydrate a final prompt and pushes
// it into #input-text on demand. Self-contained — does not touch the
// engine's existing route/base flow.
(() => {
  const importBtn = $("registry-import-btn");
  let exportBtn = null;
  const metaEl = $("registry-meta");
  const controlsEl = $("registry-controls");
  const tuningControlsEl = $("registry-controls-tuning");
  const emptyEl = $("registry-empty");
  const tuningEmptyEl = $("registry-tuning-empty");
  if (!importBtn || !controlsEl) return;

  // Sections that belong on the Tuning tab instead of Compose.
  const TUNING_SECTIONS = new Set([
    "static_injections",
    "runtime_injections",
    "prompt_endings",
    "examples",
  ]);

  function containerFor(key) {
    return TUNING_SECTIONS.has(key) && tuningControlsEl ? tuningControlsEl : controlsEl;
  }

  function bothContainers() {
    return tuningControlsEl ? [controlsEl, tuningControlsEl] : [controlsEl];
  }

  const SECTION_LABELS = {
    base_context: "Base Context",
    personas: "Personas",
    sentiment: "Sentiment",
    static_injections: "Static Injections",
    runtime_injections: "Runtime Injections",
    output_prompt_directions: "Output Directions",
    examples: "Examples",
    prompt_endings: "Prompt Endings",
  };

  // Strict per-section item schemas — match templatebuilder.html's output shape.
  // Field types: text | textarea | lines (\n-split array) | bool | section-checks.
  const ITEM_SCHEMA = {
    base_context: [
      { field: "text", label: "Always-shown text", type: "textarea" },
      { field: "fragments", label: "Conditional fragments", type: "fragments" },
    ],
    personas: [
      { field: "id", label: "ID", type: "text" },
      { field: "context", label: "Context", type: "textarea" },
    ],
    sentiment: [
      { field: "id", label: "ID", type: "text" },
      { field: "context", label: "Context", type: "textarea" },
    ],
    static_injections: [
      { field: "id", label: "ID", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
      { field: "items", label: "Pool items", type: "lines" },
    ],
    runtime_injections: [
      { field: "id", label: "ID", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
      { field: "required", label: "Required", type: "bool" },
    ],
    output_prompt_directions: [
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
      { field: "items", label: "Pool items", type: "lines" },
    ],
    examples: [
      { field: "name", label: "Name", type: "text" },
      { field: "items", label: "Items", type: "lines" },
    ],
    prompt_endings: [
      { field: "name", label: "Name", type: "text" },
      { field: "items", label: "Items", type: "lines" },
    ],
  };

  const RUNTIME_INJECTED_VARS = new Set([
    "memory_recall",
    "system_summary",
    "rule_ending",
  ]);

  function collectMissingTvars() {
    if (!registry) return [];
    const missing = [];
    for (const [secKey, sec] of Object.entries(registry)) {
      if (!sec || !Array.isArray(sec.template_vars)) continue;
      for (const v of sec.template_vars) {
        if (RUNTIME_INJECTED_VARS.has(v)) continue;
        const val = (tvarValues[`${secKey}::${v}`] || "").trim();
        if (!val) missing.push({ section: secKey, varName: v });
      }
    }
    return missing;
  }

  function showTvarWarning(missing) {
    const el = $("tvar-warning");
    if (!el) return;
    if (!missing.length) { el.hidden = true; el.innerHTML = ""; return; }
    const items = missing.map(({ section, varName }) =>
      `<span class="tvar-warning-item"><span class="tvar-warning-sec">${escapeHtml(section)}</span> · <code>${escapeHtml(varName)}</code></span>`
    ).join("");
    el.innerHTML = `<span class="tvar-warning-icon">⚠</span> Empty template vars: ${items}<button class="tvar-warning-dismiss" onclick="this.closest('.tvar-warning').hidden=true">×</button>`;
    el.hidden = false;
  }

  let registry = null;
  const tvarValues = {};
  // Per-section / per-array-field hydration mode: "all" | "random:K" | "index:I"
  const arrayModes = {};
  function getArrayMode(secKey, field) {
    return (arrayModes[secKey] && arrayModes[secKey][field]) || "all";
  }
  function setArrayMode(secKey, field, mode) {
    if (!arrayModes[secKey]) arrayModes[secKey] = {};
    arrayModes[secKey][field] = mode;
  }
  // Sections merged into prompt_endings — still parsed/serialized but not shown as UI controls
  const HIDDEN_SECTIONS = new Set(["user_message"]);

  function sectionKeys() {
    return Object.keys(registry).filter((k) =>
      !HIDDEN_SECTIONS.has(k) &&
      registry[k] && typeof registry[k] === "object" && Array.isArray(registry[k].items)
    );
  }

  function itemId(item, fallback = "") {
    return item?.id || item?.name || fallback;
  }

  function defaultSelectionsForRegistry() {
    const sels = {};
    if (!registry) return sels;
    for (const key of sectionKeys()) {
      const sec = registry[key];
      const items = Array.isArray(sec.items) ? sec.items : [];
      if (!items.length) continue;
      if (sec.selected !== undefined && sec.selected !== null) {
        sels[key] = sec.selected;
        continue;
      }
      if (sec.required || key === "memory_recall") {
        sels[key] = itemId(items[0], "item_0");
      } else {
        sels[key] = [];
      }
    }
    return sels;
  }

  function defaultArrayModesForSelection(sels) {
    if (!registry || !sels) return;
    for (const [key, val] of Object.entries(sels)) {
      const sec = registry[key];
      const items = Array.isArray(sec?.items) ? sec.items : [];
      const selectedItems = Array.isArray(val)
        ? items.filter((it, idx) => val.includes(itemId(it, `item_${idx}`)))
        : items.filter((it, idx) => itemId(it, `item_${idx}`) === val);
      for (const item of selectedItems) {
        for (const field of arrayFieldsOf(item)) {
          if (!arrayModes[key]?.[field]) setArrayMode(key, field, "all");
        }
      }
    }
  }


  // v2: array mode fields are qualified keys.
  // items with `groups: ["id1","id2"]` yield "groups[id1]", "groups[id2]".
  // PromptEnding items with `items: [...]` yield "items".
  function arrayFieldsOf(item) {
    if (!item || typeof item !== "object") return [];
    const fields = [];
    if (Array.isArray(item.groups)) {
      for (const gid of item.groups) {
        if (typeof gid === "string") fields.push(`groups[${gid}]`);
      }
    }
    if (Array.isArray(item.items)) fields.push("items");
    return fields;
  }

  // ── Generation overrides (Tuning tab) ──────────────────────
  // Map between #cfg-<key> inputs and the request fields ollama_client
  // accepts. Numeric coercion is per-field (top_k is int, the rest float).
  const GEN_OVERRIDE_FIELDS = [
    { id: "cfg-temperature", key: "temperature", parse: parseFloat },
    { id: "cfg-top_p", key: "top_p", parse: parseFloat },
    { id: "cfg-top_k", key: "top_k", parse: parseInt },
    { id: "cfg-max_tokens", key: "max_tokens", parse: parseInt },
    { id: "cfg-repeat_penalty", key: "repeat_penalty", parse: parseFloat },
    { id: "cfg-retries", key: "retries", parse: parseInt },
    { id: "cfg-max_prompt_chars", key: "max_prompt_chars", parse: parseInt },
  ];

  function readGenOverrides() {
    const out = {};
    for (const f of GEN_OVERRIDE_FIELDS) {
      const el = $(f.id);
      if (!el || el.value === "" || el.value == null) continue;
      const n = f.parse(el.value);
      if (Number.isFinite(n)) out[f.key] = n;
    }
    return out;
  }

  function applyGenOverridesToInputs(gen) {
    if (!gen) return;
    for (const f of GEN_OVERRIDE_FIELDS) {
      const el = $(f.id);
      if (!el) continue;
      el.value = gen[f.key] != null ? String(gen[f.key]) : "";
    }
  }

  // ── Output Policy editor (Tuning tab) ──────────────────────
  function populatePolicyEditor(policy) {
    const p = policy || {};
    const set = (id, v) => { const el = $(id); if (el) el.value = v; };
    const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
    set("op-min-length", p.min_length != null ? p.min_length : "");
    set("op-max-length", p.max_length != null ? p.max_length : "");
    setChk("op-collapse-ws", p.collapse_whitespace !== false);
    set("op-append-suffix", p.append_suffix || "");
    set("op-strip-prefixes", (p.strip_prefixes || []).join("\n"));
    set("op-strip-patterns", (p.strip_patterns || []).join("\n"));
    set("op-require-patterns", (p.require_patterns || []).join("\n"));
    set("op-forbidden-subs", (p.forbidden_substrings || []).join("\n"));
    set("op-forbidden-pats", (p.forbidden_patterns || []).join("\n"));
  }

  function readPolicyEditor() {
    const out = {};
    const minLen = ($("op-min-length") || {}).value;
    const maxLen = ($("op-max-length") || {}).value;
    if (minLen != null && String(minLen).trim() !== "") out.min_length = parseInt(minLen, 10);
    if (maxLen != null && String(maxLen).trim() !== "") out.max_length = parseInt(maxLen, 10);
    const colEl = $("op-collapse-ws");
    if (colEl && !colEl.checked) out.collapse_whitespace = false;
    const suffix = (($("op-append-suffix") || {}).value || "").trim();
    if (suffix) out.append_suffix = suffix;
    const lines = (id) => {
      const el = $(id);
      return el ? el.value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    };
    const sp = lines("op-strip-prefixes");
    const spat = lines("op-strip-patterns");
    const rp = lines("op-require-patterns");
    const fs = lines("op-forbidden-subs");
    const fp = lines("op-forbidden-pats");
    if (sp.length) out.strip_prefixes = sp;
    if (spat.length) out.strip_patterns = spat;
    if (rp.length) out.require_patterns = rp;
    if (fs.length) out.forbidden_substrings = fs;
    if (fp.length) out.forbidden_patterns = fp;
    return Object.keys(out).length ? out : null;
  }

  const sectionRandom = {};
  const sectionSliders = {};
  const sectionSliderRandom = {};
  function sectionRandomEligible(key) {
    if (!registry || !registry[key]) return false;
    return !!registry[key].required && key !== "base_context";
  }

  // What's currently chosen in the UI (no randomization). Used for the
  // editor preview so users see exactly what they picked.
  function readState() {
    const s = {};
    for (const key of sectionKeys()) {
      const sec = registry[key];
      if (!sec.items || sec.items.length === 0) {
        s[key] = sec.required ? null : [];
        continue;
      }
      const host = containerFor(key);
      if (sec.required) {
        const sel = host.querySelector(`select[data-section="${key}"]`);
        const id = sel ? sel.value : null;
        if (id === "__random__") { s[key] = null; continue; }
        s[key] = sec.items.find((it) => (it.id || it.name) === id) || null;
      } else {
        const checked = Array.from(
          host.querySelectorAll(`input[data-section="${key}"]:checked`)
        ).map((cb) => cb.value);
        s[key] = sec.items.filter((it) => checked.includes(it.id || it.name));
      }
    }
    return s;
  }

  function arrayFieldsForSelection(sel) {
    if (!sel) return [];
    if (Array.isArray(sel)) {
      const seen = new Set();
      for (const it of sel) for (const f of arrayFieldsOf(it)) seen.add(f);
      return [...seen];
    }
    return arrayFieldsOf(sel);
  }

  // Returns the array values for `field` from the current section selection.
  // For multi-select sections we return the first matching item's array.
  function getSelectionArrayValues(sel, field) {
    if (!sel) return [];
    const groupMatch = field.match(/^groups\[(.+)\]$/);
    if (groupMatch) {
      const gid = groupMatch[1];
      const groupItems = (registry && registry.groups && registry.groups.items) || [];
      const group = groupItems.find(it => (it.id || it.name) === gid);
      return group && Array.isArray(group.items) ? group.items : [];
    }
    if (Array.isArray(sel)) {
      for (const it of sel) if (Array.isArray(it[field])) return it[field];
      return [];
    }
    return Array.isArray(sel[field]) ? sel[field] : [];
  }

  function truncateForOption(s, max = 80) {
    const str = String(s);
    return str.length > max ? str.slice(0, max) + "…" : str;
  }

  // Mode UI:
  //   • Value-picker dropdown (with "(all values)" first, then each value)
  //   • Random-selection checkbox
  //   • When Random is checked the dropdown row hides and a labeled count
  //     row appears: "Pick N random of M values"
  function fieldDisplayLabel(field) {
    const groupMatch = field.match(/^groups\[(.+)\]$/);
    if (groupMatch) {
      return groupMatch[1].replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }
    return field.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function arrayModeOptionsHtml(secKey, field, values) {
    if (!values || !values.length) return "";
    const cur = getArrayMode(secKey, field);
    const isRandom = cur.startsWith("random:");
    const isSpecific = cur.startsWith("indices:");
    const isNone = cur === "none";
    const k = isRandom ? Math.max(1, parseInt(cur.slice(7), 10) || 1) : 1;
    const specificSet = isSpecific
      ? new Set(cur.slice(8).split(",").map(s => parseInt(s, 10)).filter(n => !isNaN(n)))
      : new Set();
    const label = fieldDisplayLabel(field);

    const modeType = isRandom ? "random" : isSpecific ? "specific" : isNone ? "none" : "all";

    const checkboxRows = values
      .map((v, i) =>
        `<label class="registry-mode-specific-item">` +
        `<input type="checkbox" data-mode-control="specific-item" value="${i}"${specificSet.has(i) ? " checked" : ""}> ` +
        `${escapeHtml(truncateForOption(v, 100))}` +
        `</label>`
      )
      .join("");

    return (
      `<div class="registry-mode-row" data-mode-row="${escapeHtml(secKey)}::${escapeHtml(field)}">` +
      `<div class="registry-mode-header">` +
      `<span class="registry-mode-label">${escapeHtml(label)}:</span>` +
      `<select data-mode-control="mode-type">` +
      `<option value="all"${modeType === "all" ? " selected" : ""}>(all ${values.length})</option>` +
      `<option value="none"${modeType === "none" ? " selected" : ""}>(none — skip)</option>` +
      `<option value="specific"${modeType === "specific" ? " selected" : ""}>pick specific…</option>` +
      `<option value="random"${modeType === "random" ? " selected" : ""}>random…</option>` +
      `</select>` +
      `</div>` +
      `<div class="registry-mode-specific"${!isSpecific ? " hidden" : ""}>${checkboxRows}</div>` +
      `<div class="registry-mode-pick" data-pick-mode="random"${!isRandom ? " hidden" : ""}>` +
      `<span class="registry-mode-rand-text">pick</span>` +
      `<input type="number" min="1" max="${values.length}" value="${k}" class="registry-mode-count" data-mode-control="count">` +
      `<span class="registry-mode-rand-text">random of ${values.length} at run time</span>` +
      `</div>` +
      `</div>`
    );
  }

  // Render schema-driven inputs for `item`, pre-filled with its values.
  // Edits write straight back to the underlying registry item.
  function renderItemEditor(item, sectionKey) {
    const schema = ITEM_SCHEMA[sectionKey] || [
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
    ];
    const itemId = item.id || item.name || "";
    const rows = schema.map((f) => {
      const v = item[f.field];
      const common = `data-edit-section="${escapeHtml(sectionKey)}" data-edit-item="${escapeHtml(
        itemId
      )}" data-edit-field="${escapeHtml(f.field)}" data-edit-type="${f.type}"`;
      if (f.type === "textarea") {
        const sec = registry[sectionKey];
        const hasTvars = sec && Array.isArray(sec.template_vars) && sec.template_vars.length > 0;
        const preview = hasTvars
          ? `<div class="tvar-preview" data-preview-section="${escapeHtml(sectionKey)}" data-preview-field="${escapeHtml(f.field)}"></div>`
          : "";
        return `<label class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><textarea ${common} rows="3">${escapeHtml(v ?? "")}</textarea>${preview}</label>`;
      }
      if (f.type === "lines") {
        const arr = Array.isArray(v) ? v : [];
        const rowsHtml = arr.map((val, i) =>
          `<div class="list-item-row">` +
          `<input type="text" value="${escapeHtml(val)}" placeholder="item ${i + 1}" ` +
          `data-list-section="${escapeHtml(sectionKey)}" data-list-item="${escapeHtml(itemId)}" ` +
          `data-list-field="${escapeHtml(f.field)}" data-list-index="${i}">` +
          `<button type="button" class="list-item-remove" title="Remove" ` +
          `data-list-remove data-list-section="${escapeHtml(sectionKey)}" ` +
          `data-list-item="${escapeHtml(itemId)}" data-list-field="${escapeHtml(f.field)}" ` +
          `data-list-index="${i}">×</button>` +
          `</div>`
        ).join("");
        return `<div class="registry-add-row"><span>${escapeHtml(f.label)}</span>` +
          `<div class="list-field" data-list-host="${escapeHtml(sectionKey)}:${escapeHtml(itemId)}:${escapeHtml(f.field)}">` +
          rowsHtml +
          `<button type="button" class="list-item-add" ` +
          `data-list-add="${escapeHtml(sectionKey)}:${escapeHtml(itemId)}:${escapeHtml(f.field)}">+ Add</button>` +
          `</div></div>`;
      }
      if (f.type === "bool") {
        return `<label class="registry-add-row registry-add-row--inline"><span>${escapeHtml(
          f.label
        )}</span><input type="checkbox" ${common}${v ? " checked" : ""}></label>`;
      }
      if (f.type === "section-checks") {
        const arr = Array.isArray(v) ? v : [];
        const boxes = sectionKeys()
          .filter((k) => k !== sectionKey)
          .map(
            (sk) =>
              `<label class="registry-check"><input type="checkbox" ${common} data-include="${escapeHtml(
                sk
              )}"${arr.includes(sk) ? " checked" : ""}><span>${escapeHtml(
                SECTION_LABELS[sk] || sk
              )}</span></label>`
          )
          .join("");
        return `<div class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><div class="registry-checks">${boxes}</div></div>`;
      }
      if (f.type === "fragments") {
        return fragmentsEditorHtml(sectionKey, itemId, Array.isArray(v) ? v : [], {
          editor: true,
        });
      }
      return `<label class="registry-add-row"><span>${escapeHtml(
        f.label
      )}</span><input type="text" ${common} value="${escapeHtml(v ?? "")}"></label>`;
    });
    const head = itemId
      ? `<div class="registry-editor-head">${escapeHtml(itemId)}</div>`
      : "";
    return `<div class="registry-editor-card">${head}${rows.join("")}</div>`;
  }

  // Render the fragments UI: a labeled list of conditional sentence
  // fragments. Each row picks an "if var" (always / one of the section's
  // template_vars), holds the fragment text, and has a remove button.
  // Plus a "+ fragment" button at the bottom.
  function fragmentsEditorHtml(secKey, itemId, fragments, opts = {}) {
    const sec = registry[secKey];
    const tvars = (sec && Array.isArray(sec.template_vars)) ? sec.template_vars : [];
    const ctx = opts.editor
      ? `data-frag-edit-section="${escapeHtml(secKey)}" data-frag-edit-item="${escapeHtml(
          itemId
        )}"`
      : `data-frag-form="${escapeHtml(secKey)}"`;
    const rowHtml = (frag, i) => {
      const ifVar = (frag && (frag.condition || frag.if_var || frag.var)) || "";
      const text = (frag && frag.text) || "";
      const opts = [`<option value="">always</option>`]
        .concat(
          tvars.map(
            (v) =>
              `<option value="${escapeHtml(v)}"${ifVar === v ? " selected" : ""}>if ${escapeHtml(
                v
              )}</option>`
          )
        )
        .join("");
      return (
        `<div class="registry-frag-row" data-frag-index="${i}">` +
        `<select data-frag-var>${opts}</select>` +
        `<textarea data-frag-text rows="3" placeholder="fragment text — use {var}…">${escapeHtml(text)}</textarea>` +
        `<button type="button" class="registry-tvar-remove" data-frag-remove title="Remove fragment">×</button>` +
        `</div>`
      );
    };
    return (
      `<div class="registry-add-row registry-fragments-row" ${ctx}>` +
      `<span>Conditional fragments</span>` +
      `<div class="registry-fragments-list">` +
      fragments.map(rowHtml).join("") +
      `</div>` +
      `<button type="button" class="registry-tvar-add" data-frag-add>+ fragment</button>` +
      `</div>`
    );
  }

  // Read fragments from a fragments-row container into [{condition, text}].
  function readFragmentsFromRow(rowEl) {
    if (!rowEl) return [];
    return Array.from(rowEl.querySelectorAll(".registry-frag-row"))
      .map((r) => ({
        condition: (r.querySelector("[data-frag-var]") || {}).value || "",
        text: (r.querySelector("[data-frag-text]") || {}).value || "",
      }))
      .filter((f) => f.condition || f.text);
  }

  // Wire add / remove / change handlers on every fragments-row inside
  // `host`. If `editor` is true, edits write straight back to the
  // underlying registry item; otherwise (add-form) we just maintain DOM
  // state and let the form's submit handler read it.
  function wireFragmentRows(host, editor) {
    host.querySelectorAll(".registry-fragments-row").forEach((rowHost) => {
      const list = rowHost.querySelector(".registry-fragments-list");
      const addBtn = rowHost.querySelector("[data-frag-add]");

      const writeBack = () => {
        if (!editor) return;
        const secKey = rowHost.dataset.fragEditSection;
        const itemId = rowHost.dataset.fragEditItem;
        const item = findItemById(secKey, itemId);
        if (!item) return;
        item.fragments = readFragmentsFromRow(rowHost);
      };

      const wireRow = (rowEl) => {
        rowEl.querySelector("[data-frag-var]")?.addEventListener("change", writeBack);
        rowEl.querySelector("[data-frag-text]")?.addEventListener("input", writeBack);
        rowEl.querySelector("[data-frag-remove]")?.addEventListener("click", () => {
          rowEl.remove();
          writeBack();
        });
      };

      list?.querySelectorAll(".registry-frag-row").forEach(wireRow);

      addBtn?.addEventListener("click", () => {
        const sec = rowHost.dataset.fragEditSection || rowHost.dataset.fragForm;
        const tvars =
          (registry[sec] && Array.isArray(registry[sec].template_vars))
            ? registry[sec].template_vars
            : [];
        const optsHtml =
          `<option value="">always</option>` +
          tvars.map((v) => `<option value="${escapeHtml(v)}">if ${escapeHtml(v)}</option>`).join("");
        const div = document.createElement("div");
        div.className = "registry-frag-row";
        div.innerHTML =
          `<select data-frag-var>${optsHtml}</select>` +
          `<textarea data-frag-text rows="3" placeholder="fragment text — use {var}…"></textarea>` +
          `<button type="button" class="registry-tvar-remove" data-frag-remove title="Remove fragment">×</button>`;
        list.appendChild(div);
        wireRow(div);
        writeBack();
      });
    });
  }

  function findItemById(secKey, id) {
    const sec = registry[secKey];
    if (!sec || !Array.isArray(sec.items)) return null;
    return sec.items.find((it) => (it.id || it.name) === id) || null;
  }

  function writeEditValue(el) {
    const item = findItemById(el.dataset.editSection, el.dataset.editItem);
    if (!item) return;
    const field = el.dataset.editField;
    const type = el.dataset.editType;
    if (type === "lines") {
      item[field] = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    } else if (type === "bool") {
      item[field] = !!el.checked;
    } else if (type === "section-checks") {
      const row = el.closest(".registry-add-row");
      if (!row) return;
      item[field] = Array.from(row.querySelectorAll("input[data-include]:checked")).map(
        (cb) => cb.dataset.include
      );
    } else if (type === "fragments") {
      const row = el.closest(".registry-fragments-row");
      if (!row) return;
      item[field] = readFragmentsFromRow(row);
    } else {
      item[field] = el.value;
    }
  }

  function editorsHtmlFor(key, sel) {
    if (Array.isArray(sel)) {
      if (!sel.length) return "";
      return sel.map((it) => renderItemEditor(it, key)).join("");
    }
    if (!sel) return "";
    return renderItemEditor(sel, key);
  }

  function _selectedScaleItem(key) {
    const sec = registry && registry[key];
    if (!sec || !Array.isArray(sec.items)) return null;
    const host = containerFor(key);
    const sel = host && host.querySelector(`select[data-section="${key}"]`);
    const id = sel ? sel.value : null;
    const item = (id && id !== "__random__") ? sec.items.find((it) => (it.id || it.name) === id) : sec.items[0];
    return (item && typeof item.scale === "object" && item.scale) ? item : null;
  }

  function renderScaleFields(key) {
    for (const host of bothContainers()) {
      const el = host.querySelector(`[data-scale-fields="${key}"]`);
      if (!el) continue;
      const item = _selectedScaleItem(key);
      if (!item) { el.innerHTML = ""; continue; }
      const scale = item.scale;
      const descRaw = scale.scale_descriptor;
      const descVal = Array.isArray(descRaw) ? descRaw.join("\n") : (descRaw || "");
      el.innerHTML =
        `<details class="registry-scale-detail">` +
        `<summary class="registry-scale-summary">Scale settings</summary>` +
        `<div class="registry-scale-body">` +
        `<label class="registry-scale-label">Descriptor <small class="muted">(one per line → random pick)</small></label>` +
        `<textarea rows="3" class="registry-scale-input" data-scale-key="${escapeHtml(key)}" data-scale-item="${escapeHtml(item.id || item.name || "")}" data-scale-field="scale_descriptor">${escapeHtml(descVal)}</textarea>` +
        `<label class="registry-scale-label">Template <small class="muted">{value} and {scale_descriptor}</small></label>` +
        `<input type="text" class="registry-scale-input" data-scale-key="${escapeHtml(key)}" data-scale-item="${escapeHtml(item.id || item.name || "")}" data-scale-field="template" value="${escapeHtml(scale.template || "")}">` +
        `<div class="registry-scale-nums">` +
        `<label>Default<input type="number" step="0.5" class="registry-scale-input" data-scale-key="${escapeHtml(key)}" data-scale-item="${escapeHtml(item.id || item.name || "")}" data-scale-field="default_value" value="${scale.default_value ?? 5}"></label>` +
        `<label>Min<input type="number" step="0.5" class="registry-scale-input" data-scale-key="${escapeHtml(key)}" data-scale-item="${escapeHtml(item.id || item.name || "")}" data-scale-field="min_value" value="${scale.min_value ?? 1}"></label>` +
        `<label>Max<input type="number" step="0.5" class="registry-scale-input" data-scale-key="${escapeHtml(key)}" data-scale-item="${escapeHtml(item.id || item.name || "")}" data-scale-field="max_value" value="${scale.max_value ?? 10}"></label>` +
        `</div>` +
        `</div></details>`;
      el.querySelectorAll(".registry-scale-input").forEach((input) => {
        input.addEventListener("input", () => {
          const sec = registry[input.dataset.scaleKey];
          if (!sec) return;
          const it = sec.items.find((x) => (x.id || x.name || "") === input.dataset.scaleItem);
          if (!it || !it.scale) return;
          const field = input.dataset.scaleField;
          if (field === "scale_descriptor") {
            const lines = input.value.split("\n").map((s) => s.trim()).filter(Boolean);
            it.scale.scale_descriptor = lines.length > 1 ? lines : (lines[0] || "");
          } else if (["default_value", "min_value", "max_value"].includes(field)) {
            const n = parseFloat(input.value);
            if (Number.isFinite(n)) it.scale[field] = n;
          } else {
            it.scale[field] = input.value;
          }
        });
      });
    }
  }

  function refreshSectionPreviews() {
    if (!registry) return;
    const st = readState();
    for (const key of sectionKeys()) {
      const host = containerFor(key);
      const card = host.querySelector(`.registry-section[data-key="${key}"]`);
      if (!card) continue;

      // Selected-item editor: shows values of whatever's picked in the
      // dropdown / checkboxes. Edits write through to the registry.
      const ed = card.querySelector(".registry-editors");
      if (ed) {
        ed.innerHTML = editorsHtmlFor(key, st[key]);
        ed.querySelectorAll("[data-edit-section]").forEach((el) => {
          const ev = el.type === "checkbox" ? "change" : "input";
          el.addEventListener(ev, () => {
            writeEditValue(el);
            const f = el.dataset.editField;
            if (f === "id" || f === "name") buildControls();
            if (el.tagName === "TEXTAREA") refreshTvarPreviews();
          });
        });
        ed.querySelectorAll("input[data-list-index]").forEach((inp) => {
          inp.addEventListener("input", () => {
            const item = findItemById(inp.dataset.listSection, inp.dataset.listItem);
            if (!item) return;
            const field = inp.dataset.listField;
            const index = parseInt(inp.dataset.listIndex, 10);
            if (!Array.isArray(item[field])) item[field] = [];
            item[field][index] = inp.value;
          });
        });
        ed.querySelectorAll("[data-list-remove]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const item = findItemById(btn.dataset.listSection, btn.dataset.listItem);
            if (!item) return;
            const field = btn.dataset.listField;
            const index = parseInt(btn.dataset.listIndex, 10);
            if (Array.isArray(item[field])) item[field].splice(index, 1);
            refreshSectionPreviews();
          });
        });
        ed.querySelectorAll("[data-list-add]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const [sec, id, field] = btn.dataset.listAdd.split(":");
            const item = findItemById(sec, id);
            if (!item) return;
            if (!Array.isArray(item[field])) item[field] = [];
            item[field].push("");
            refreshSectionPreviews();
          });
        });
        wireFragmentRows(ed, /* editor */ true);
      }

      // Per-array-field runtime mode selectors (nudges/examples/items only).
      const modes = card.querySelector(".registry-modes");
      if (modes) {
        const fields = arrayFieldsForSelection(st[key]);
        modes.innerHTML = fields
          .map((f) => arrayModeOptionsHtml(key, f, getSelectionArrayValues(st[key], f)))
          .join("");
        modes.querySelectorAll(".registry-mode-row").forEach((row) => {
          const [section, field] = row.dataset.modeRow.split("::");
          const modeTypeSel = row.querySelector("[data-mode-control='mode-type']");
          const specificDiv = row.querySelector(".registry-mode-specific");
          const randomDiv = row.querySelector("[data-pick-mode='random']");
          const countInp = row.querySelector("[data-mode-control='count']");

          const applyMode = () => {
            const mt = modeTypeSel.value;
            if (mt === "random") {
              const n = Math.max(1, parseInt(countInp.value, 10) || 1);
              setArrayMode(section, field, `random:${n}`);
              if (specificDiv) specificDiv.hidden = true;
              if (randomDiv) randomDiv.hidden = false;
            } else if (mt === "specific") {
              const checked = [...row.querySelectorAll("[data-mode-control='specific-item']:checked")]
                .map(cb => cb.value).join(",");
              setArrayMode(section, field, checked ? `indices:${checked}` : "none");
              if (specificDiv) specificDiv.hidden = false;
              if (randomDiv) randomDiv.hidden = true;
            } else {
              setArrayMode(section, field, mt); // "all" or "none"
              if (specificDiv) specificDiv.hidden = true;
              if (randomDiv) randomDiv.hidden = true;
            }
          };

          modeTypeSel.addEventListener("change", applyMode);
          countInp.addEventListener("input", applyMode);
          row.querySelectorAll("[data-mode-control='specific-item']").forEach(cb => {
            cb.addEventListener("change", applyMode);
          });
        });
      }

      // Refresh scale fields for the selected item whenever selections change.
      if (registry[key] && Array.isArray(registry[key].items) &&
          registry[key].items.some((it) => it && typeof it.scale === "object")) {
        renderScaleFields(key);
      }
    }
  }

  function buildControls() {
    controlsEl.innerHTML = "";
    if (tuningControlsEl) tuningControlsEl.innerHTML = "";
    if (!registry) {
      emptyEl.hidden = false;
      if (tuningEmptyEl) tuningEmptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    if (tuningEmptyEl) tuningEmptyEl.hidden = true;

    for (const key of sectionKeys()) {
      const sec = registry[key];
      const label = SECTION_LABELS[key] || key;
      const hasItems = (sec.items || []).length > 0;
      const isMulti = !sec.required;

      const card = document.createElement("div");
      card.className = "registry-section";
      card.dataset.key = key;

      let inputHtml = "";
      if (!hasItems) {
        inputHtml = `<small class="muted">No items defined.</small>`;
      } else if (key === "runtime_injections") {
        inputHtml =
          `<div class="registry-checks">` +
          sec.items
            .map((it, idx) => {
              const id = it.id || it.name || `item_${idx}`;
              const itemVars = Array.isArray(it.template_vars) ? it.template_vars : [];
              const itemVarsHtml = itemVars
                .map((v) => {
                  const k = `runtime_injections::${v}`;
                  const val = tvarValues[k] || "";
                  return (
                    `<div class="registry-tvar-row">` +
                    `<span class="registry-tvar-name">{${escapeHtml(v)}}</span>` +
                    `<input type="text" data-tvar="${escapeHtml(k)}" value="${escapeHtml(val)}" placeholder="value">` +
                    `</div>`
                  );
                })
                .join("");
              return (
                `<div class="registry-check-group">` +
                `<label class="registry-check"><input type="checkbox" data-section="${escapeHtml(key)}" value="${escapeHtml(id)}"><span>${escapeHtml(id)}</span></label>` +
                (itemVarsHtml ? `<div class="registry-rti-tvars">${itemVarsHtml}</div>` : "") +
                `</div>`
              );
            })
            .join("") +
          `</div>`;
      } else if (isMulti) {
        inputHtml =
          `<div class="registry-checks">` +
          sec.items
            .map((it, idx) => {
              const id = it.id || it.name || `item_${idx}`;
              return `<label class="registry-check"><input type="checkbox" data-section="${escapeHtml(
                key
              )}" value="${escapeHtml(id)}"><span>${escapeHtml(id)}</span></label>`;
            })
            .join("") +
          `</div>`;
      } else {
        const itemCount = Array.isArray(sec.items) ? sec.items.length : 0;
        const showRandom = sectionRandomEligible(key) && itemCount > 1;
        const randomOpt = showRandom
          ? `<option value="__random__"${sectionRandom[key] ? " selected" : ""}>— random at run time —</option>`
          : "";
        inputHtml =
          `<select data-section="${escapeHtml(key)}">` +
          randomOpt +
          sec.items
            .map((it, idx) => {
              const id = it.id || it.name || `item_${idx}`;
              return `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
            })
            .join("") +
          `</select>`;
      }

      const randomHtml = "";

      // Scale slider — shown for any section whose selected item has a `scale` field.
      // Drives the `section.scale` assembly token.
      let sliderHtml = "";
      const hasScale = Array.isArray(sec.items) && sec.items.some(
        (it) => it && typeof it.scale === "object" && it.scale !== null
      );
      if (hasScale) {
        const cur = sectionSliders[key] != null ? sectionSliders[key] : 5;
        const isRand = !!sectionSliderRandom[key];
        sliderHtml =
          `<div class="registry-slider-row">` +
          `<label>Scale: <span data-slider-value="${escapeHtml(key)}">${cur}</span> / 10</label>` +
          `<input type="range" min="1" max="10" value="${cur}" data-slider="${escapeHtml(key)}"${isRand ? " disabled" : ""}>` +
          `<label class="registry-slider-rand"><input type="checkbox" data-slider-random="${escapeHtml(key)}"${isRand ? " checked" : ""}><span>Random at run time</span></label>` +
          `</div>` +
          `<div data-scale-fields="${escapeHtml(key)}"></div>`;
      }

      // Always render the template-vars block so users can add even when
      // none exist yet. Header has a "+ var" button.
      const varsHtml =
        `<div class="registry-tvars">` +
        `<div class="registry-tvars-head">` +
        `<small class="muted">Template vars</small>` +
        `<button type="button" class="registry-tvar-add" data-tvar-add="${escapeHtml(
          key
        )}" title="Add a template variable">+ var</button>` +
        `</div>` +
        (sec.template_vars || [])
          .map((v) => {
            if (RUNTIME_INJECTED_VARS.has(v)) {
              return (
                `<div class="registry-tvar-row registry-tvar-row--runtime">` +
                `<span class="registry-tvar-name">${escapeHtml(v)}</span>` +
                `<span class="registry-tvar-runtime-badge">runtime</span>` +
                `</div>`
              );
            }
            const k = `${key}::${v}`;
            const val = tvarValues[k] || "";
            return (
              `<div class="registry-tvar-row">` +
              `<span class="registry-tvar-name">${escapeHtml(v)}</span>` +
              `<input type="text" data-tvar="${escapeHtml(k)}" value="${escapeHtml(
                val
              )}" placeholder="value">` +
              `<button type="button" class="registry-tvar-remove" data-tvar-remove="${escapeHtml(
                key
              )}::${escapeHtml(v)}" title="Remove this template var">×</button>` +
              `</div>`
            );
          })
          .join("") +
        `</div>`;

      card.innerHTML =
        `<div class="registry-section-head">` +
        `<span class="registry-section-title">${escapeHtml(label)}</span>` +
        `<span class="registry-section-actions">` +
        `<span class="registry-badge ${sec.required ? "req" : ""}">${
          sec.required ? "REQUIRED" : "OPTIONAL"
        }</span>` +
        `</span>` +
        `</div>` +
        inputHtml +
        randomHtml +
        sliderHtml +
        varsHtml +
        `<div class="registry-editors"></div>` +
        `<div class="registry-modes"></div>`;
      containerFor(key).appendChild(card);
    }

    for (const host of bothContainers()) {
      host.querySelectorAll("select[data-section], input[data-section]").forEach((el) => {
        el.addEventListener("change", () => {
          if (el.tagName === "SELECT" && el.value === "__random__") {
            sectionRandom[el.dataset.section] = true;
          } else if (el.tagName === "SELECT") {
            sectionRandom[el.dataset.section] = false;
          }
          refreshSectionPreviews();
        });
      });
      host.querySelectorAll("input[data-tvar]").forEach((el) => {
        el.addEventListener("input", () => {
          tvarValues[el.dataset.tvar] = el.value;
          refreshTvarPreviews();
          showTvarWarning(collectMissingTvars());
        });
      });
      host.querySelectorAll("[data-tvar-add]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.dataset.tvarAdd;
          const sec = registry[k];
          if (!sec) return;
          const raw = prompt("Template variable name (e.g. location):");
          if (!raw) return;
          const name = raw.trim().replace(/^\{|\}$/g, "");
          if (!name) return;
          if (!Array.isArray(sec.template_vars)) sec.template_vars = [];
          if (!sec.template_vars.includes(name)) sec.template_vars.push(name);
          buildControls();
        });
      });
      host.querySelectorAll("[data-tvar-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const [k, v] = btn.dataset.tvarRemove.split("::");
          const sec = registry[k];
          if (!sec || !Array.isArray(sec.template_vars)) return;
          sec.template_vars = sec.template_vars.filter((x) => x !== v);
          delete tvarValues[`${k}::${v}`];
          buildControls();
        });
      });
      host.querySelectorAll("input[data-slider]").forEach((el) => {
        el.addEventListener("input", () => {
          const k = el.dataset.slider;
          const v = parseInt(el.value, 10);
          sectionSliders[k] = v;
          const display = host.querySelector(`[data-slider-value="${k}"]`);
          if (display) display.textContent = String(v);
        });
      });
      host.querySelectorAll("input[data-slider-random]").forEach((el) => {
        el.addEventListener("change", () => {
          const k = el.dataset.sliderRandom;
          sectionSliderRandom[k] = el.checked;
          const slider = host.querySelector(`input[data-slider="${k}"]`);
          if (slider) slider.disabled = el.checked;
        });
      });
      host.querySelectorAll("input[data-scale-template]").forEach((el) => {
        el.addEventListener("input", () => {
          if (!registry.sentiment) return;
          if (el.value.trim()) {
            registry.sentiment.scale_template = el.value;
          } else {
            delete registry.sentiment.scale_template;
          }
        });
      });
    }

    refreshSectionPreviews();
  }

  // Adopt a parsed registry dict as the current registry. Used by both
  // the paste-JSON importer and the built-in examples modal. Lifts any
  // baked tool-state (`selected`, `section_random`, `array_modes`,
  // `slider`, `slider_random`) out of each section and into the
  // matching runtime state objects. Also accepts root-level state in
  // either builder/snapshot camelCase or backend snake_case.
  let _memorySessionId = null;

  function loadRegistryDict(parsed) {
    registry = parsed.registry || parsed;
    Object.keys(tvarValues).forEach((k) => delete tvarValues[k]);
    Object.keys(arrayModes).forEach((k) => delete arrayModes[k]);
    Object.keys(sectionRandom).forEach((k) => delete sectionRandom[k]);
    Object.keys(sectionSliders).forEach((k) => delete sectionSliders[k]);
    Object.keys(sectionSliderRandom).forEach((k) => delete sectionSliderRandom[k]);

    const bakedSelections = defaultSelectionsForRegistry();

    // Helper: apply a v2 SectionState dict into internal state vars.
    function _applyV2SectionState(k, ss) {
      if (!ss || typeof ss !== "object") return;
      if (ss.selected !== undefined && ss.selected !== null) bakedSelections[k] = ss.selected;
      if (typeof ss.section_random === "boolean") sectionRandom[k] = ss.section_random;
      if (ss.array_modes && typeof ss.array_modes === "object") arrayModes[k] = { ...ss.array_modes };
      if (typeof ss.slider === "number") sectionSliders[k] = ss.slider;
      if (typeof ss.slider_random === "boolean") sectionSliderRandom[k] = ss.slider_random;
      if (ss.template_vars && typeof ss.template_vars === "object") {
        for (const [v, val] of Object.entries(ss.template_vars)) {
          if (val == null) continue;
          tvarValues[`${k}::${v}`] = String(val);
        }
      }
    }

    // v2: read from registry.default_state.sections
    const defaultState = registry.default_state;
    if (defaultState && typeof defaultState === "object") {
      for (const [k, ss] of Object.entries(defaultState)) {
        _applyV2SectionState(k, ss);
      }
    }

    for (const k of sectionKeys()) {
      const sec = registry[k];
      if (!sec) continue;
      // template_var_defaults always provide fallback values
      if (sec.template_var_defaults && typeof sec.template_var_defaults === "object") {
        for (const [v, val] of Object.entries(sec.template_var_defaults)) {
          if (val == null || tvarValues[`${k}::${v}`] != null) continue;
          tvarValues[`${k}::${v}`] = String(val);
        }
      }
    }

    if (parsed && typeof parsed === "object") {
      const rootGeneration = parsed.generation;
      const rootPolicy = parsed.output_policy;
      if (rootGeneration && typeof rootGeneration === "object") {
        registry.generation = { ...(registry.generation || {}), ...rootGeneration };
      }
      if (rootPolicy && typeof rootPolicy === "object") {
        registry.output_policy = { ...(registry.output_policy || {}), ...rootPolicy };
      }

      const rootState = parsed.state;
      if (rootState && typeof rootState === "object" && !Array.isArray(rootState)) {
        for (const [k, ss] of Object.entries(rootState)) {
          _applyV2SectionState(k, ss);
        }
      }
    }

    const title = registry.title || "registry";
    const ver = registry.version != null ? ` v${registry.version}` : "";
    metaEl.textContent = `${title}${ver} · ${sectionKeys().length} sections`;
    if (exportBtn) exportBtn.disabled = false;
    applyGenOverridesToInputs(registry.generation || {});
    populatePolicyEditor(registry.output_policy || {});
    buildControls();
    const loadedSelections = { ...bakedSelections };
    defaultArrayModesForSelection(loadedSelections);
    applySelections(loadedSelections);
    refreshSectionPreviews();
    refreshMemoryUI();
    _memorySessionId = null;
    fetch("/api/memory/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).catch(() => {});
  }

  function consumeBuilderHandoff() {
    try {
      const raw = localStorage.getItem(STUDIO_INBOX_KEY);
      if (!raw) return false;
      localStorage.removeItem(STUDIO_INBOX_KEY);
      loadRegistryDict(JSON.parse(raw));
      return true;
    } catch (e) {
      console.warn("Failed to load builder handoff:", e);
      return false;
    }
  }

  const exampleSaveBtn = $("example-save-btn");
  let loadedExample = null;
  let exampleDirtyTimer = null;

  importBtn.addEventListener("click", () => {
    const raw = prompt("Paste Registry JSON:");
    if (!raw) return;
    try {
      loadRegistryDict(JSON.parse(raw));
      clearLoadedExample();
    } catch (e) {
      alert("Import failed: " + e.message);
    }
  });
  consumeBuilderHandoff();
  if (registry) clearLoadedExample();

  // ─── Built-in examples modal ──────────────────────────────────
  const examplesBtn = $("example-btn");
  const examplesModal = $("examples-modal");
  const examplesList = $("examples-list");

  function closeExamplesModal() {
    if (examplesModal) examplesModal.hidden = true;
  }
  document.querySelectorAll("[data-close-examples]").forEach((el) => {
    el.addEventListener("click", closeExamplesModal);
  });

  async function fetchExampleManifest(url, basePath, sourceLabel) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    const data = await res.json();
    return (data.examples || []).map((ex) => ({
      ...ex,
      sourceLabel,
      path: `${basePath}/${ex.file || ""}`,
    }));
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function buildExampleSavePayload(base = {}) {
    const title = registry?.title || base.name || base.registry?.title || "Example";
    const snap = captureSnapshot(base.name || title);
    if (snap.output_policy) snap.registry.output_policy = snap.output_policy;
    return {
      ...base,
      name: base.name || title,
      savedAt: new Date().toISOString(),
      registry: snap.registry,
      state: snap.state,
      ...(snap.output_policy ? { output_policy: snap.output_policy } : {}),
    };
  }

  function comparableExamplePayload(base = {}) {
    const payload = buildExampleSavePayload(base);
    delete payload.savedAt;
    return payload;
  }

  function updateExampleSaveButton() {
    if (!exampleSaveBtn) return;
    const dirty = !!loadedExample?.dirty;
    exampleSaveBtn.hidden = !dirty;
    if (dirty) {
      exampleSaveBtn.textContent = `Save ${loadedExample.name || "Example"}`;
      exampleSaveBtn.title = `Save changes to ${loadedExample.path}`;
    }
  }

  function setLoadedExample(meta, payload) {
    loadedExample = {
      path: meta.path,
      name: meta.name || payload.name || payload.registry?.title || meta.file || "Example",
      sourceLabel: meta.sourceLabel || "Example",
      base: JSON.parse(JSON.stringify(payload || {})),
      dirty: false,
      baseline: "",
    };
    loadedExample.baseline = stableStringify(comparableExamplePayload(loadedExample.base));
    updateExampleSaveButton();
  }

  function clearLoadedExample() {
    loadedExample = null;
    updateExampleSaveButton();
  }

  function checkExampleDirty() {
    if (!loadedExample || !registry) return;
    const current = stableStringify(comparableExamplePayload(loadedExample.base));
    loadedExample.dirty = current !== loadedExample.baseline;
    updateExampleSaveButton();
  }

  function scheduleExampleDirtyCheck() {
    if (!loadedExample) return;
    window.clearTimeout(exampleDirtyTimer);
    exampleDirtyTimer = window.setTimeout(checkExampleDirty, 0);
  }

  async function openExamplesModal() {
    if (!examplesModal || !examplesList) return;
    examplesList.innerHTML = `<div class="muted" style="padding:8px">Loading…</div>`;
    examplesModal.hidden = false;
    try {
      const examples = await fetchExampleManifest(
        "/static/builder-examples/index.json",
        "/static/builder-examples",
        "Example"
      );
      if (!examples.length) {
        throw new Error("No examples found.");
      }
      const items = examples.map((ex, i) => {
        const name = escapeHtml(ex.name || ex.file || `example_${i}`);
        const desc = escapeHtml(ex.description || "");
        const source = escapeHtml(ex.sourceLabel || "Example");
        return (
          `<div class="snapshot-row">` +
          `<div class="snapshot-meta">` +
          `<div class="snapshot-row-name">${name} <span class="example-source">${source}</span></div>` +
          (desc ? `<div class="muted">${desc}</div>` : "") +
          `</div>` +
          `<div class="snapshot-actions">` +
          `<button type="button" class="ghost-action small" data-example-path="${escapeHtml(
            ex.path || ""
          )}">Load</button>` +
          `</div></div>`
        );
      });
      examplesList.innerHTML = items.length
        ? items.join("")
        : `<div class="muted" style="padding:8px">No examples shipped.</div>`;
      examplesList.querySelectorAll("[data-example-path]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const path = btn.dataset.examplePath;
          if (!path) return;
          try {
            const r = await fetch(path, { cache: "no-cache" });
            if (!r.ok) throw new Error(`fetch ${path} ${r.status}`);
            const payload = await r.json();
            loadRegistryDict(payload);
            const ex = examples.find((item) => item.path === path) || {};
            setLoadedExample(ex, payload);
            closeExamplesModal();
          } catch (e) {
            alert(`Failed to load ${path}: ${e.message}`);
          }
        });
      });
    } catch (e) {
      examplesList.innerHTML =
        `<div class="muted" style="color:var(--warn);padding:8px">` +
        escapeHtml(`Failed to load examples: ${e.message}`) +
        `</div>`;
    }
  }

  if (examplesBtn) examplesBtn.addEventListener("click", openExamplesModal);
  if (exampleSaveBtn) {
    exampleSaveBtn.addEventListener("click", async () => {
      if (!loadedExample || !registry) return;
      const payload = buildExampleSavePayload(loadedExample.base);
      exampleSaveBtn.disabled = true;
      const originalText = exampleSaveBtn.textContent;
      exampleSaveBtn.textContent = "Saving...";
      try {
        const resp = await fetch("/api/registry/example/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: loadedExample.path, payload }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        loadedExample.base = JSON.parse(JSON.stringify(payload));
        loadedExample.baseline = stableStringify(comparableExamplePayload(loadedExample.base));
        loadedExample.dirty = false;
        updateExampleSaveButton();
      } catch (e) {
        alert(`Failed to save example: ${e.message}`);
        exampleSaveBtn.textContent = originalText;
      } finally {
        exampleSaveBtn.disabled = false;
      }
    });
  }

  const studioMain = document.querySelector("main.grid");
  ["input", "change"].forEach((eventName) => {
    studioMain?.addEventListener(eventName, scheduleExampleDirtyCheck);
  });
  studioMain?.addEventListener("click", (e) => {
    if (e.target.closest("button")) scheduleExampleDirtyCheck();
  });

  // ─── Snapshots (save / load current panel state) ─────────────
  const SNAP_KEY = "pl-registry-snapshots-v1";

  function loadSnapshots() {
    try {
      return JSON.parse(localStorage.getItem(SNAP_KEY) || "[]");
    } catch {
      return [];
    }
  }
  function persistSnapshots(arr) {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(arr));
    } catch (e) {
      alert("Failed to save snapshot: " + e.message);
    }
  }

  // Capture the user's current dropdown / checkbox selections (independent
  // of the random-1 toggles, which are stored in sectionRandom).
  function captureSelections() {
    const sels = {};
    if (!registry) return sels;
    for (const key of sectionKeys()) {
      const sec = registry[key];
      if (!sec.items || !sec.items.length) continue;
      const host = containerFor(key);
      if (sec.required) {
        const sel = host.querySelector(`select[data-section="${key}"]`);
        sels[key] = sel ? sel.value : null;
      } else {
        sels[key] = Array.from(
          host.querySelectorAll(`input[data-section="${key}"]:checked`)
        ).map((cb) => cb.value);
      }
    }
    return sels;
  }

  function applySelections(sels) {
    if (!registry || !sels) return;
    for (const key of Object.keys(sels)) {
      if (!registry[key]) continue;
      const host = containerFor(key);
      const val = sels[key];
      if (Array.isArray(val)) {
        host.querySelectorAll(`input[data-section="${key}"]`).forEach((cb) => {
          cb.checked = val.includes(cb.value);
        });
      } else if (val != null) {
        const sel = host.querySelector(`select[data-section="${key}"]`);
        if (sel) sel.value = sectionRandom[key] ? "__random__" : val;
      }
    }
  }

  function captureSnapshot(name) {
    const reg = JSON.parse(JSON.stringify(registry));
    const generation = readGenOverrides();
    if (Object.keys(generation).length) {
      reg.generation = { ...(reg.generation || {}), ...generation };
    }
    const snap = {
      name,
      savedAt: new Date().toISOString(),
      registry: reg,
      state: snapshotActiveState(),
    };
    const policy = readPolicyEditor();
    if (policy) snap.output_policy = policy;
    return snap;
  }

  // Restore internal state vars from a v2 state sections dict.
  function _applyV2StateToVars(stateDict) {
    if (!stateDict || typeof stateDict !== "object") return;
    const sels = {};
    for (const [key, ss] of Object.entries(stateDict)) {
      if (!ss || typeof ss !== "object") continue;
      if (ss.selected !== undefined && ss.selected !== null) sels[key] = ss.selected;
      if (typeof ss.section_random === "boolean") sectionRandom[key] = ss.section_random;
      if (ss.array_modes && typeof ss.array_modes === "object") arrayModes[key] = { ...ss.array_modes };
      if (typeof ss.slider === "number") sectionSliders[key] = ss.slider;
      if (typeof ss.slider_random === "boolean") sectionSliderRandom[key] = ss.slider_random;
      if (ss.template_vars && typeof ss.template_vars === "object") {
        for (const [v, val] of Object.entries(ss.template_vars)) {
          if (val == null) continue;
          tvarValues[`${key}::${v}`] = String(val);
        }
      }
    }
    return sels;
  }

  function restoreSnapshot(snap) {
    if (!snap || !snap.registry) return;
    clearLoadedExample();
    registry = JSON.parse(JSON.stringify(snap.registry));
    Object.keys(arrayModes).forEach((k) => delete arrayModes[k]);
    Object.keys(sectionRandom).forEach((k) => delete sectionRandom[k]);
    Object.keys(sectionSliders).forEach((k) => delete sectionSliders[k]);
    Object.keys(sectionSliderRandom).forEach((k) => delete sectionSliderRandom[k]);
    Object.keys(tvarValues).forEach((k) => delete tvarValues[k]);

    let selections = {};
    if (snap.state && typeof snap.state === "object") {
      selections = _applyV2StateToVars(snap.state) || {};
    }

    const title = registry.title || "registry";
    const ver = registry.version != null ? ` v${registry.version}` : "";
    metaEl.textContent = `${title}${ver} · ${sectionKeys().length} sections`;
    if (exportBtn) exportBtn.disabled = false;
    applyGenOverridesToInputs(registry.generation || snap.generation || {});
    populatePolicyEditor(snap.output_policy || registry.output_policy || {});
    buildControls();
    applySelections(selections);
    refreshSectionPreviews();
    refreshMemoryUI();

    const indicator = $("snapshot-indicator");
    const nameEl = $("snapshot-name");
    if (indicator && nameEl) {
      nameEl.textContent = snap.name;
      indicator.hidden = false;
    }
  }

  function renderSnapshotList() {
    const host = $("snapshot-list");
    if (!host) return;
    const snaps = loadSnapshots();
    if (!snaps.length) {
      host.innerHTML = `<div class="muted" style="padding:8px">No snapshots yet.</div>`;
      return;
    }
    host.innerHTML = snaps
      .map(
        (s, i) =>
          `<div class="snapshot-row">` +
          `<div class="snapshot-meta">` +
          `<div class="snapshot-row-name">${escapeHtml(s.name)}</div>` +
          `<div class="muted">${escapeHtml(new Date(s.savedAt).toLocaleString())}</div>` +
          `</div>` +
          `<div class="snapshot-actions">` +
          `<button type="button" class="ghost-action small" data-snap-load="${i}">Load</button>` +
          `<button type="button" class="ghost-action small" data-snap-export="${i}">Export</button>` +
          `<button type="button" class="ghost-action small" data-snap-delete="${i}">Delete</button>` +
          `</div></div>`
      )
      .join("");
    host.querySelectorAll("[data-snap-load]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.snapLoad, 10);
        const snaps = loadSnapshots();
        if (snaps[idx]) {
          restoreSnapshot(snaps[idx]);
          closeSnapshotsModal();
        }
      });
    });
    host.querySelectorAll("[data-snap-export]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.snapExport, 10);
        const snaps = loadSnapshots();
        if (snaps[idx]) {
          openSnapshotExport(
            snaps[idx],
            `Snapshot "${snaps[idx].name}" — copy to share or back up.`
          );
        }
      });
    });
    host.querySelectorAll("[data-snap-delete]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.snapDelete, 10);
        const snaps = loadSnapshots();
        if (!snaps[idx]) return;
        if (!confirm(`Delete snapshot "${snaps[idx].name}"?`)) return;
        snaps.splice(idx, 1);
        persistSnapshots(snaps);
        renderSnapshotList();
      });
    });
  }

  function openSnapshotExport(payload, desc) {
    const m = $("snapshot-export-modal");
    const code = $("snap-export-code");
    const descEl = $("snap-export-desc");
    if (!m || !code) return;
    code.textContent = JSON.stringify(payload, null, 2);
    if (descEl && desc) descEl.textContent = desc;
    m.hidden = false;
  }
  function closeSnapshotExport() {
    const m = $("snapshot-export-modal");
    if (m) m.hidden = true;
  }
  document.querySelectorAll("[data-close-snap-export]").forEach((el) => {
    el.addEventListener("click", closeSnapshotExport);
  });
  const snapExportCopy = $("snap-export-copy");
  if (snapExportCopy) {
    snapExportCopy.addEventListener("click", async () => {
      const text = ($("snap-export-code") || {}).textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        const orig = snapExportCopy.textContent;
        snapExportCopy.textContent = "Copied!";
        setTimeout(() => (snapExportCopy.textContent = orig), 900);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    });
  }

  // Build a "model JSON" — the original registry shape with the user's
  // tool-side selections/runtime modes/sliders woven into each section as
  // extra fields. Template-var values are dropped (the items' text keeps
  // its `{var}` placeholders, so the model stays generic).
  function buildModelExport() {
    if (!registry) return null;
    const out = JSON.parse(JSON.stringify(registry));
    for (const key of sectionKeys()) {
      if (!out[key]) continue;
      const sec = registry[key];
      const host = containerFor(key);

      if (sec.required) {
        const selEl = host.querySelector(`select[data-section="${key}"]`);
        const selVal = selEl ? selEl.value : null;
        out[key].selected = (selVal === "__random__") ? null : selVal;
      } else {
        out[key].selected = Array.from(
          host.querySelectorAll(`input[data-section="${key}"]:checked`)
        ).map((cb) => cb.value);
      }

      if (key in sectionRandom) out[key].section_random = !!sectionRandom[key];
      if (arrayModes[key] && Object.keys(arrayModes[key]).length) {
        out[key].array_modes = JSON.parse(JSON.stringify(arrayModes[key]));
      }
      if (key in sectionSliders) out[key].slider = sectionSliders[key];
      if (key in sectionSliderRandom)
        out[key].slider_random = !!sectionSliderRandom[key];
    }
    const overrides = readGenOverrides();
    if (Object.keys(overrides).length) out.generation = overrides;
    const policy = readPolicyEditor();
    if (policy) out.output_policy = policy;
    return { registry: out };
  }

  // Compose-tab Export Model JSON button.
  exportBtn = $("registry-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      if (!registry) return;
      const model = buildModelExport();
      if (!model) return;
      openSnapshotExport(
        model,
        "Model JSON — the registry with your selections, runtime modes, slider, and section-random toggles woven into each section. Template-var values are not exported (placeholders like {location} remain in item text)."
      );
    });
  }

  const openBuilderBtn = $("open-builder-btn");
  if (openBuilderBtn) {
    openBuilderBtn.addEventListener("click", () => {
      try {
        const payload = registry ? (buildModelExport() || { registry }) : null;
        if (payload) localStorage.setItem(BUILDER_INBOX_KEY, JSON.stringify(payload));
      } catch (e) {
        console.warn("Failed to hand off registry to builder:", e);
      }
      window.location.href = "/builder";
    });
  }

  function openSnapshotsModal() {
    const m = $("snapshots-modal");
    if (!m) return;
    m.hidden = false;
    const err = $("snapshot-save-error");
    if (err) err.hidden = true;
    const nameInp = $("snapshot-name-input");
    if (nameInp) {
      nameInp.value = "";
      setTimeout(() => nameInp.focus(), 30);
    }
    renderSnapshotList();
  }
  function closeSnapshotsModal() {
    const m = $("snapshots-modal");
    if (m) m.hidden = true;
  }

  const snapBtn = $("snapshots-btn");
  if (snapBtn) snapBtn.addEventListener("click", openSnapshotsModal);
  document.querySelectorAll("[data-close-snapshots]").forEach((el) => {
    el.addEventListener("click", closeSnapshotsModal);
  });

  const saveBtn = $("snapshot-save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const err = $("snapshot-save-error");
      const showErr = (msg) => {
        if (!err) return alert(msg);
        err.textContent = msg;
        err.hidden = false;
      };
      if (!registry) return showErr("Import a registry first.");
      const nameInp = $("snapshot-name-input");
      const name = (nameInp ? nameInp.value : "").trim();
      if (!name) return showErr("Give the snapshot a name.");
      const snaps = loadSnapshots();
      const existingIdx = snaps.findIndex((s) => s.name === name);
      const snap = captureSnapshot(name);
      if (existingIdx >= 0) {
        if (!confirm(`Overwrite existing snapshot "${name}"?`)) return;
        snaps[existingIdx] = snap;
      } else {
        snaps.unshift(snap);
      }
      persistSnapshots(snaps);
      const indicator = $("snapshot-indicator");
      const nameEl = $("snapshot-name");
      if (indicator && nameEl) {
        nameEl.textContent = name;
        indicator.hidden = false;
      }
      if (err) err.hidden = true;
      if (nameInp) nameInp.value = "";
      renderSnapshotList();
    });
  }

  // Generate: re-hydrate, send the prompt browser-direct to the user's
  // configured Ollama, render the response in the Output tab and fill the
  // Debug Trace panel.
  function setTrace(id, value) {
    const el = $(id);
    if (!el) return;
    if (value == null || value === "") {
      el.textContent = "";
      return;
    }
    el.textContent =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function snapshotActiveState() {
    const sels = registry ? captureSelections() : {};
    const sections = {};
    const allKeys = new Set([
      ...Object.keys(sels),
      ...Object.keys(arrayModes),
      ...Object.keys(sectionRandom),
      ...Object.keys(sectionSliders),
      ...Object.keys(sectionSliderRandom),
    ]);
    // also add any section that has template var values
    for (const k of Object.keys(tvarValues)) {
      const sep = k.indexOf("::");
      if (sep > 0) allKeys.add(k.slice(0, sep));
    }
    for (const key of allKeys) {
      const sec = {};
      const sel = sels[key];
      if (sel !== undefined && sel !== null) sec.selected = sel;
      if (sectionSliders[key] != null) sec.slider = sectionSliders[key];
      if (sectionSliderRandom[key]) sec.slider_random = true;
      if (sectionRandom[key]) sec.section_random = true;
      const modes = arrayModes[key];
      if (modes && Object.keys(modes).length) sec.array_modes = { ...modes };
      const prefix = key + "::";
      const tvars = {};
      for (const [k, v] of Object.entries(tvarValues)) {
        if (k.startsWith(prefix)) tvars[k.slice(prefix.length)] = v;
      }
      if (Object.keys(tvars).length) sec.template_vars = tvars;
      if (Object.keys(sec).length) sections[key] = sec;
    }
    return sections;
  }

  function placeholderState(state) {
    // Deep-clone state and replace every empty template var with its {name}
    // literal so the prompt preview shows placeholders instead of blank gaps.
    const out = JSON.parse(JSON.stringify(state));
    for (const sec of Object.values(out)) {
      if (!sec || typeof sec !== "object") continue;
      const tv = sec.template_vars;
      if (!tv || typeof tv !== "object") continue;
      for (const k of Object.keys(tv)) {
        if (tv[k] === "" || tv[k] == null) tv[k] = `{${k}}`;
      }
    }
    return out;
  }

  async function backendHydrate(usePlaceholders = false) {
    const state = usePlaceholders ? placeholderState(snapshotActiveState()) : snapshotActiveState();
    const resp = await fetch("/api/registry/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry, state }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`hydrate failed (${resp.status}): ${err}`);
    }
    const data = await resp.json();
    return data.prompt || "";
  }

  // ── Memory pipeline ───────────────────────────────────────────────

  function hasMemoryRules() {
    // Activate the memory pipeline when ANY memory feature is configured —
    // not just memory_rules. Working notes, system summary, and a configured
    // personality_file are all valid reasons to surface the pipeline UI.
    if (!registry) return false;
    const rules = Array.isArray(registry.memory_rules) ? registry.memory_rules : [];
    const cfg = registry.memory_config || {};
    return (
      rules.length > 0 ||
      !!cfg.working_notes_enabled ||
      !!cfg.system_summary_enabled ||
      !!(cfg.personality_file && String(cfg.personality_file).trim())
    );
  }

  function isMemoryRecallSelected() {
    if (!registry || !registry.memory_recall) return false;
    const host = $("registry-controls");
    if (!host) return false;
    const sel = host.querySelector('select[data-section="memory_recall"]');
    if (sel) return !!sel.value && sel.value !== "__random__";
    return host.querySelectorAll('input[data-section="memory_recall"]:checked').length > 0;
  }

  function refreshMemoryUI() {
    const memPipeline      = $("memory-pipeline");
    const normalOutput     = $("output-rendered");
    const rawOutput        = $("output-raw");
    const viewToggle       = $("output-view-toggle");
    const resetBtn         = $("memory-reset-btn");
    const memCfgFieldset   = $("memory-config-fieldset");
    const infoPanelEl      = $("memory-info-panel");
    const active           = hasMemoryRules();

    if (memPipeline)    memPipeline.hidden    = !active;
    if (normalOutput)   normalOutput.hidden   =  active;
    if (rawOutput)      rawOutput.hidden      =  true;
    if (viewToggle)     viewToggle.hidden     =  active;
    if (resetBtn)       resetBtn.hidden       = !active;
    if (memCfgFieldset) memCfgFieldset.hidden = !active;
    if (infoPanelEl)    infoPanelEl.hidden    = !active;
    if (active) { populateMemoryConfigPanel(); refreshMemoryInfoPanel(); }
    if (!active) _memorySessionId = null;
  }

  function refreshMemoryInfoPanel() {
    const cfg = registry?.memory_config || {};
    const clfUrl   = cfg.classifier_url   || "http://localhost:11434";
    const clfModel = cfg.classifier_model || "—";
    const embUrl   = cfg.embed_url        || clfUrl;
    const embModel = cfg.embed_model      || "nomic-embed-text";
    const useClf   = cfg.use_classifier !== false;

    const infoClf = $("mem-info-classifier");
    const infoEmb = $("mem-info-embedder");
    const infoToggle = $("mem-info-use-classifier");

    if (infoClf) infoClf.textContent = `${clfModel} @ ${clfUrl}`;
    if (infoEmb) infoEmb.textContent = `${embModel} @ ${embUrl}`;
    if (infoToggle) infoToggle.checked = useClf;
  }

  function populateMemoryConfigPanel() {
    const cfg = registry?.memory_config || {};
    const set = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };
    set("studio-mem-classifier-url",   cfg.classifier_url);
    set("studio-mem-classifier-model", cfg.classifier_model);
    const hasEmbedUrl = !!cfg.embed_url;
    const embedCb = $("studio-mem-use-embed-url");
    if (embedCb) embedCb.checked = hasEmbedUrl;
    const embedSec = $("studio-mem-embed-url-section");
    if (embedSec) embedSec.hidden = !hasEmbedUrl;
    set("studio-mem-embed-url",        cfg.embed_url);
    set("studio-mem-embed-model",      cfg.embed_model);
    set("studio-mem-top-k",            cfg.top_k);
    set("studio-mem-prune-keep",       cfg.prune_keep);
  }

  function syncMemoryConfigFromPanel() {
    if (!registry) return;
    const read = (id) => $(id)?.value?.trim() || undefined;
    const readNum = (id) => { const n = parseInt($(id)?.value, 10); return Number.isFinite(n) ? n : undefined; };
    const cfg = {};
    const cu = read("studio-mem-classifier-url");   if (cu) cfg.classifier_url   = cu;
    const cm = read("studio-mem-classifier-model"); if (cm) cfg.classifier_model = cm;
    const useEmbedUrl = $("studio-mem-use-embed-url")?.checked;
    if (useEmbedUrl) {
      const eu = read("studio-mem-embed-url"); if (eu) cfg.embed_url = eu;
    }
    const em = read("studio-mem-embed-model"); if (em) cfg.embed_model = em;
    const tk = readNum("studio-mem-top-k");         if (tk) cfg.top_k            = tk;
    const pk = readNum("studio-mem-prune-keep");    if (pk != null) cfg.prune_keep = pk;
    const ucEl = $("mem-info-use-classifier");
    if (ucEl) cfg.use_classifier = ucEl.checked;
    // preserve other keys (store_path, personality_file) from registry
    const merged = { ...(registry.memory_config || {}), ...cfg };
    if (!useEmbedUrl) delete merged.embed_url;
    registry.memory_config = merged;
  }

  // Wire memory config panel inputs to sync back into registry on change
  ["studio-mem-classifier-url","studio-mem-classifier-model","studio-mem-embed-url",
   "studio-mem-embed-model","studio-mem-top-k","studio-mem-prune-keep"].forEach((id) => {
    $(id)?.addEventListener("change", syncMemoryConfigFromPanel);
  });

  $("studio-mem-use-embed-url")?.addEventListener("change", () => {
    const cb = $("studio-mem-use-embed-url");
    const sec = $("studio-mem-embed-url-section");
    if (sec) sec.hidden = !cb?.checked;
    syncMemoryConfigFromPanel();
  });

  $("mem-info-use-classifier")?.addEventListener("change", syncMemoryConfigFromPanel);

  const studioMemFetchBtn = $("studio-mem-fetch-btn");
  if (studioMemFetchBtn) {
    studioMemFetchBtn.addEventListener("click", async () => {
      const base = ($("studio-mem-classifier-url")?.value?.trim() || "").replace(/\/+$/, "");
      if (!base) { alert("Set classifier_url first."); return; }
      studioMemFetchBtn.textContent = "…";
      studioMemFetchBtn.disabled = true;
      try {
        let models = [];
        for (const path of ["/api/tags", "/v1/models"]) {
          try {
            const r = await fetch(base + path);
            if (!r.ok) continue;
            const d = await r.json();
            if (Array.isArray(d.models)) { models = d.models.map((m) => m.name).filter(Boolean); break; }
            if (Array.isArray(d.data))   { models = d.data.map((m) => m.id).filter(Boolean); break; }
          } catch {}
        }
        const input = $("studio-mem-classifier-model");
        if (input && models.length) {
          const current = input.value;
          // Show a quick datalist for autocomplete
          let dl = document.getElementById("studio-mem-model-list");
          if (!dl) { dl = document.createElement("datalist"); dl.id = "studio-mem-model-list"; document.body.appendChild(dl); input.setAttribute("list", "studio-mem-model-list"); }
          dl.innerHTML = models.map((m) => `<option value="${m}">`).join("");
          if (!current) input.value = models[0] || "";
        } else if (!models.length) {
          alert("No models found at that URL.");
        }
      } catch (e) {
        alert(`Fetch failed: ${e.message}`);
      } finally {
        studioMemFetchBtn.textContent = "↺";
        studioMemFetchBtn.disabled = false;
      }
    });
  }

  function renderMemoryPipeline(userInput, result) {
    const emptyEl  = $("memory-pipeline-empty");
    const trackEl  = $("memory-pipeline-track");
    if (emptyEl) emptyEl.hidden = true;
    if (trackEl) trackEl.hidden = false;

    // Helper: mark a step node active or dim
    const setStepActive = (stepId, active) => {
      const node = $(`${stepId}`)?.querySelector(".pipeline-node");
      if (node) node.classList.toggle("pipeline-node--active", active);
    };

    // 1. Message
    const inputBody = $("pipe-input-body");
    if (inputBody) inputBody.textContent = userInput || "";
    setStepActive("pipe-input-step", true);

    // 2. Memory Retrieval
    const chunksMeta = $("pipe-chunks-meta");
    const chunksBody = $("pipe-chunks-body");
    const chunks = result.retrieved_chunks || [];
    if (chunksMeta) chunksMeta.textContent = chunks.length ? `${chunks.length} chunk${chunks.length > 1 ? "s" : ""}` : "none";
    if (chunksBody) {
      chunksBody.innerHTML = chunks.length
        ? chunks.map((c) => `
            <div class="memory-chunk">
              <span class="memory-chunk-role">${escapeHtml(c.role)}</span>
              <span class="memory-chunk-score">score: ${c.score}</span>
              <div class="memory-chunk-text">${escapeHtml(c.text)}</div>
              ${c.tags?.length ? `<div class="memory-chunk-tags">${c.tags.map((t) => `<span class="memory-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            </div>`).join("")
        : `<span class="muted" style="font-size:12px">Nothing in store yet — first turn.</span>`;
    }
    setStepActive("pipe-chunks-step", chunks.length > 0);

    // 3. Classifier / Tags
    const tagsMeta = $("pipe-tags-meta");
    const tagsBody = $("pipe-tags-body");
    const tags = result.extracted_tags || [];
    const cs = result.classifier_stats || {};
    const csMeta = [
      cs.model ? escapeHtml(cs.model) : null,
      cs.ms    ? `${Math.round(cs.ms)}ms` : null,
      cs.tokens != null ? `${cs.tokens} tok` : null,
    ].filter(Boolean).join(" · ");
    if (tagsMeta) tagsMeta.textContent = tags.length ? `→ ${tags.join(", ")}` : (cs.error ? "→ error" : "→ no tags");
    if (tagsBody) {
      const statsHtml = csMeta ? `<div class="pipeline-clf-stats muted">${csMeta}</div>` : "";
      const knownHtml = cs.known_tags?.length
        ? `<div class="muted" style="font-size:11px;margin-top:4px">vocab: ${cs.known_tags.map(escapeHtml).join(", ")}</div>`
        : "";
      let bodyContent = "";
      if (cs.error) {
        bodyContent = `<div class="reject-banner" style="font-size:12px;padding:6px 8px;margin:0">⚠ classifier error: ${escapeHtml(cs.error)}</div>`;
        if (cs.raw_response) {
          bodyContent += `<details style="margin-top:4px;font-size:11px"><summary class="muted" style="cursor:pointer">raw response</summary><pre style="margin:4px 0 0;padding:6px;background:rgba(0,0,0,0.25);border-radius:3px;white-space:pre-wrap">${escapeHtml(cs.raw_response)}</pre></details>`;
        }
      } else if (tags.length) {
        bodyContent = tags.map((t) => `<span class="memory-chip memory-chip--tag">${escapeHtml(t)}</span>`).join("");
      } else {
        bodyContent = `<span class="muted" style="font-size:12px">No tags matched — rules will not fire.</span>`;
        if (cs.raw_response) {
          bodyContent += `<details style="margin-top:4px;font-size:11px"><summary class="muted" style="cursor:pointer">raw response</summary><pre style="margin:4px 0 0;padding:6px;background:rgba(0,0,0,0.25);border-radius:3px;white-space:pre-wrap">${escapeHtml(cs.raw_response)}</pre></details>`;
        }
      }
      tagsBody.innerHTML = statsHtml + bodyContent + knownHtml;
    }
    setStepActive("pipe-tags-step", tags.length > 0);

    // 4. Rules
    const rulesMeta = $("pipe-rules-meta");
    const rulesBody = $("pipe-rules-body");
    const rules = result.applied_rules || [];
    if (rulesMeta) rulesMeta.textContent = rules.length ? `${rules.length} fired` : "none";
    if (rulesBody) {
      rulesBody.innerHTML = rules.length
        ? rules.map((r) => `<div class="memory-rule-line">${escapeHtml(r)}</div>`).join("")
        : `<span class="muted" style="font-size:12px">No rules applied.</span>`;
    }
    setStepActive("pipe-rules-step", rules.length > 0);

    // 5. Assembled Prompt (collapsible toggle)
    const promptBody   = $("pipe-prompt-body");
    const promptToggle = $("pipe-prompt-toggle");
    if (promptBody) {
      promptBody.textContent = result.prompt || "(none)";
      promptBody.hidden = true;
    }
    if (promptToggle) {
      promptToggle.textContent = "show";
      promptToggle.onclick = () => {
        const hidden = promptBody.hidden = !promptBody.hidden;
        promptToggle.textContent = hidden ? "show" : "hide";
      };
    }
    setStepActive("pipe-prompt-step", true);

    // 6. Response
    const respLabel = $("pipe-response-step")?.querySelector(".pipeline-step-label");
    if (respLabel) {
      const model = result.model || "default";
      respLabel.innerHTML = `Response <span class="pipeline-meta muted">${escapeHtml(model)}</span>`;
    }
    const respBody = $("pipe-response-body");
    if (respBody) respBody.innerHTML = renderMarkdown(result.text || "(empty)");
  }

  const memResetBtn = $("memory-reset-btn");
  if (memResetBtn) {
    memResetBtn.addEventListener("click", async () => {
      if (!registry || !hasMemoryRules()) return;
      memResetBtn.textContent = "Resetting…";
      memResetBtn.disabled = true;
      try {
        const resp = await fetch("/api/memory/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry } }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        _memorySessionId = null;
        const track = $("memory-pipeline-track");
        if (track) track.hidden = true;
        const emptyEl = $("memory-pipeline-empty");
        if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = "Session reset. Store cleared."; }
      } catch (e) {
        alert(`Reset failed: ${e.message}`);
      } finally {
        memResetBtn.textContent = "Reset Session";
        memResetBtn.disabled = false;
      }
    });
  }

  // ── Personality editor ────────────────────────────────────────────

  let _personalityProfile = null;

  function _renderPersonalityEditor(profile, path) {
    _personalityProfile = profile;
    const pathEl      = $("personality-path-label");
    const seedEl      = $("personality-seed");
    const amendList   = $("personality-amendments-list");
    const assembledEl = $("personality-assembled");
    const countEl     = $("personality-amendment-count");
    const saveBtn     = $("personality-save-btn");
    const clearBtn    = $("personality-clear-btn");

    if (pathEl)      pathEl.textContent  = path || "";
    if (seedEl)      seedEl.value        = profile.seed || "";
    if (assembledEl) assembledEl.textContent = profile.assembled || "(empty)";
    if (countEl)     countEl.textContent = profile.amendments?.length ? `(${profile.amendments.length})` : "";
    if (saveBtn)     saveBtn.disabled    = false;
    if (clearBtn)    clearBtn.disabled   = false;

    if (amendList) {
      if (!profile.amendments?.length) {
        amendList.innerHTML = `<div class="muted" style="font-size:12px;padding:4px 0">No amendments yet.</div>`;
      } else {
        amendList.innerHTML = profile.amendments.map((a, i) => `
          <div class="personality-amendment" data-idx="${i}">
            <div class="personality-amendment-meta">
              <span class="muted">${escapeHtml(a.timestamp?.slice(0, 19).replace("T", " ") || "")}</span>
              <button type="button" class="ghost small personality-amend-remove" data-idx="${i}" title="Remove this amendment">✕</button>
            </div>
            <textarea class="personality-textarea personality-amend-text" rows="2" data-idx="${i}">${escapeHtml(a.text || "")}</textarea>
          </div>`).join("");

        amendList.querySelectorAll(".personality-amend-remove").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = parseInt(btn.dataset.idx, 10);
            _personalityProfile.amendments.splice(idx, 1);
            _renderPersonalityEditor(_personalityProfile, path);
          });
        });
        amendList.querySelectorAll(".personality-amend-text").forEach((ta) => {
          ta.addEventListener("input", () => {
            const idx = parseInt(ta.dataset.idx, 10);
            _personalityProfile.amendments[idx].text = ta.value;
          });
        });
      }
    }
  }

  const personalityLoadBtn = $("personality-load-btn");
  if (personalityLoadBtn) {
    personalityLoadBtn.addEventListener("click", async (e) => {
      e.stopPropagation(); // don't toggle the <details>
      if (!registry) return;
      personalityLoadBtn.textContent = "Loading…";
      personalityLoadBtn.disabled = true;
      try {
        const resp = await fetch("/api/memory/personality", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry } }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.json();
        _renderPersonalityEditor(data.profile, data.path);
        $("personality-panel")?.setAttribute("open", "");
      } catch (e) {
        alert(`Load failed: ${e.message}`);
      } finally {
        personalityLoadBtn.textContent = "Load";
        personalityLoadBtn.disabled = false;
      }
    });
  }

  const personalitySaveBtn = $("personality-save-btn");
  if (personalitySaveBtn) {
    personalitySaveBtn.addEventListener("click", async () => {
      if (!registry || !_personalityProfile) return;
      // Sync seed field back into profile before saving
      const seedEl = $("personality-seed");
      if (seedEl) _personalityProfile.seed = seedEl.value;
      personalitySaveBtn.textContent = "Saving…";
      personalitySaveBtn.disabled = true;
      try {
        const resp = await fetch("/api/memory/personality/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry }, profile: _personalityProfile }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        // Reload to show updated assembled string
        const loadResp = await fetch("/api/memory/personality", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry } }),
        });
        if (loadResp.ok) {
          const data = await loadResp.json();
          _renderPersonalityEditor(data.profile, data.path);
        }
      } catch (e) {
        alert(`Save failed: ${e.message}`);
      } finally {
        personalitySaveBtn.textContent = "Save";
        personalitySaveBtn.disabled = false;
      }
    });
  }

  const personalityClearBtn = $("personality-clear-btn");
  if (personalityClearBtn) {
    personalityClearBtn.addEventListener("click", async () => {
      if (!registry) return;
      if (!confirm("Clear all personality data (seed + amendments)? This cannot be undone.")) return;
      personalityClearBtn.textContent = "Clearing…";
      personalityClearBtn.disabled = true;
      try {
        const resp = await fetch("/api/memory/personality/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry } }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        const loadResp = await fetch("/api/memory/personality", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registry: { registry } }),
        });
        if (loadResp.ok) {
          const data = await loadResp.json();
          _renderPersonalityEditor(data.profile, data.path);
        }
      } catch (e) {
        alert(`Clear failed: ${e.message}`);
      } finally {
        personalityClearBtn.textContent = "Clear Personality";
        personalityClearBtn.disabled = false;
      }
    });
  }

  const generateBtn = $("generate-btn");
  if (generateBtn) {
    generateBtn.addEventListener("click", async () => {
      if (!registry) return;
      const missingTvars = collectMissingTvars();
      showTvarWarning(missingTvars);
      if (missingTvars.length) return;

      // — Memory pipeline path —
      if (hasMemoryRules()) {
        const userInputKey = Object.keys(tvarValues).find(k => k.endsWith("::user_input"));
        const userInput = userInputKey ? (tvarValues[userInputKey] || "").trim() : "";

        // Show loading state in pipeline
        const pipelineEmptyEl = $("memory-pipeline-empty");
        const pipelineTrack   = $("memory-pipeline-track");
        if (pipelineEmptyEl) { pipelineEmptyEl.hidden = false; pipelineEmptyEl.textContent = "Running memory pipeline…"; }
        if (pipelineTrack)   pipelineTrack.hidden = true;

        const conn  = getConnection();
        const state = snapshotActiveState();
        const overrides = readGenOverrides();

        // Seed Debug Trace with what we know up-front; fill in attempts/usage after.
        setTrace("trace-user", `[memory pipeline]\nuser_input: ${userInput}`);
        setTrace("trace-active", state);
        setTrace("trace-config", {
          mode: "memory",
          provider: conn.provider || "ollama",
          base_url: conn.baseUrl || conn.base_url || "",
          chat_path: conn.chatPath || conn.chat_path || "",
          model: conn.model || "default",
          generation: overrides,
          session_id: _memorySessionId,
        });
        setTrace("trace-attempts", "");
        setTrace("trace-usage", "");

        // Open a WebSocket so the server can delegate model calls to this browser.
        const wsSessionId = crypto.randomUUID();
        const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
        const memWs = new WebSocket(`${wsProto}//${location.host}/api/memory/ws/${wsSessionId}`);
        const mc = registry?.memory_config ?? {};
        const memEmbedUrl   = (mc.embed_url || mc.classifier_url || conn.baseUrl || "").replace(/\/$/, "") + (mc.embed_path || "/api/embed");
        const memEmbedModel = mc.embed_model || "nomic-embed-text";
        const isOpenAI = (conn.chatPath || "").includes("/v1/") || (conn.payloadShape || "") === "openai";
        const chatUrl   = (conn.baseUrl || "").replace(/\/$/, "") + (conn.chatPath || "/api/chat");
        memWs.onmessage = async (evt) => {
          let msg; try { msg = JSON.parse(evt.data); } catch { return; }
          if (msg.type === "embed_request") {
            try {
              const r = await fetch(memEmbedUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: memEmbedModel, input: msg.text }) });
              if (!r.ok) throw new Error(`embed HTTP ${r.status}`);
              const d = await r.json();
              const vectors = d.embeddings?.[0] ?? d.data?.[0]?.embedding ?? d.embedding ?? [];
              memWs.send(JSON.stringify({ type: "embed_result", id: msg.id, vectors }));
            } catch (e) { memWs.send(JSON.stringify({ type: "embed_error", id: msg.id, error: String(e.message) })); }
          } else if (msg.type === "chat_request") {
            const { id, model, messages, temperature, max_tokens, top_p, top_k, repeat_penalty } = msg;
            try {
              let body;
              if (isOpenAI) {
                body = { model, messages, temperature, max_tokens, stream: true };
                if (top_p != null) body.top_p = top_p;
                if (repeat_penalty != null) body.frequency_penalty = repeat_penalty;
              } else {
                const options = {};
                if (temperature != null) options.temperature = temperature;
                if (top_p != null) options.top_p = top_p;
                if (top_k != null) options.top_k = top_k;
                if (repeat_penalty != null) options.repeat_penalty = repeat_penalty;
                body = { model, messages, options, stream: true };
                if (max_tokens != null) body.num_predict = max_tokens;
              }
              const r = await fetch(chatUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
              if (!r.ok) throw new Error(`chat HTTP ${r.status}`);
              const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
              while (true) {
                const { value, done } = await reader.read(); if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split("\n"); buf = lines.pop();
                for (const line of lines) {
                  const t = line.trim(); if (!t) continue;
                  let raw = t;
                  if (isOpenAI) { if (!t.startsWith("data:")) continue; raw = t.slice(5).trim(); if (raw === "[DONE]") continue; }
                  try { const chunk = JSON.parse(raw); const delta = isOpenAI ? (chunk.choices?.[0]?.delta?.content ?? "") : (chunk.message?.content ?? chunk.content ?? ""); if (delta) memWs.send(JSON.stringify({ type: "chat_chunk", id, delta })); } catch { /* skip */ }
                }
              }
              memWs.send(JSON.stringify({ type: "chat_done", id }));
            } catch (e) { memWs.send(JSON.stringify({ type: "chat_error", id, error: String(e.message) })); }
          }
        };
        await new Promise((resolve, reject) => { memWs.onopen = resolve; memWs.onerror = () => reject(new Error("memory WS failed to open")); });

        try {
          const resp = await fetch("/api/memory/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              registry:   { registry },
              state,
              user_input: userInput,
              connection: {
                base_url:      conn.baseUrl      || conn.base_url      || "http://localhost:11434",
                chat_path:     conn.chatPath     || conn.chat_path     || "/api/chat",
                payload_shape: conn.payloadShape || conn.payload_shape || "auto",
                model:         conn.model        || "default",
              },
              session_id:    _memorySessionId,
              ws_session_id: wsSessionId,
              generation_overrides: overrides,
              skip_retrieval: !isMemoryRecallSelected(),
            }),
          });
          if (!resp.ok) throw new Error(await resp.text());
          const result = await resp.json();
          _memorySessionId = result.session_id;

          // Render the full pipeline flow in the Output tab
          renderMemoryPipeline(userInput, result);

          // Also populate Pre-generate tab with the memory-resolved prompt
          const stage = $("prompt-stage");
          if (stage) {
            const userList = stage.querySelector('[data-list="user"]');
            if (userList) userList.innerHTML = `<pre class="trace" style="white-space:pre-wrap;font-size:12px;padding:8px;margin:0">${escapeHtml(result.prompt || "(no prompt returned)")}</pre>`;
            stage.querySelectorAll(".stage-empty, .stage-empty-root").forEach((el) => (el.hidden = true));
            const stageBanner = stage.querySelector(".stage-banner .muted");
            if (stageBanner) stageBanner.textContent = "Memory-resolved prompt — assembled after classifier + rule mutations.";
            const memNote = $("stage-memory-note");
            if (memNote) memNote.hidden = true;
          }
          const stageBadge = $("stage-tab-badge");
          if (stageBadge) stageBadge.hidden = false;

          // Update meta strip
          const timingEl = $("out-timing");
          const acceptEl = $("out-accepted");
          const usageEl  = $("out-usage");
          const routeEl  = $("out-route");
          const modelName = result.model || conn.model || "default";
          if (timingEl && result.timing) timingEl.textContent = `${Math.round(result.timing.total_ms ?? 0)}ms`;
          if (acceptEl) acceptEl.textContent = result.accepted ? "✓ ok" : "✗ rejected";
          if (usageEl  && result.usage)  usageEl.textContent  = `${result.usage.completion_tokens ?? "?"} tok`;
          if (routeEl)  routeEl.textContent  = `${modelName} · memory`;

          // Populate Debug Trace with the assembled prompt + memory steps + response.
          setTrace("trace-user", result.prompt || "(no prompt)");
          setTrace("trace-config", {
            mode: "memory",
            model: modelName,
            session_id: result.session_id,
            base_url: conn.baseUrl || conn.base_url || "",
            chat_path: conn.chatPath || conn.chat_path || "",
            extracted_tags: result.extracted_tags,
            applied_rules:  result.applied_rules,
            classifier:     result.classifier_stats,
            retrieved:      (result.retrieved_chunks || []).length,
          });
          setTrace("trace-attempts", result.text || "");
          setTrace("trace-usage", {
            accepted: result.accepted,
            timing:   result.timing,
            usage:    result.usage,
          });
        } catch (e) {
          if (pipelineEmptyEl) { pipelineEmptyEl.hidden = false; pipelineEmptyEl.textContent = `Error: ${e.message}`; }
          if (pipelineTrack)   pipelineTrack.hidden = true;
          setTrace("trace-attempts", `error: ${e.message}`);
        } finally {
          memWs.close();
        }
        return;
      }

      // — Standard (non-memory) path —
      const rendered = $("output-rendered");
      const raw = $("output-raw");
      const setOutput = (text) => {
        if (rendered) {
          rendered.innerHTML = renderMarkdown(text);
          rendered.classList.remove("italic");
        }
        if (raw) raw.value = text;
      };

      const outputTab = document.querySelector('.output-tab[data-output-tab="output"]');
      if (outputTab) outputTab.click();
      setOutput("(building prompt…)");

      let prompt;
      const ta = $("input-text");
      if (ta && ta.dataset.fromPregen === "1" && ta.value.trim()) {
        prompt = ta.value;
        delete ta.dataset.fromPregen;
      } else {
        try {
          prompt = await backendHydrate();
        } catch (e) {
          setOutput(`error building prompt: ${e.message}`);
          return;
        }
        if (ta) {
          ta.value = prompt;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      setOutput("(generating…)");

      const conn = getConnection();
      setTrace("trace-user", prompt);
      setTrace("trace-active", snapshotActiveState());
      setTrace("trace-config", {
        provider: conn.provider || "ollama",
        base_url: conn.baseUrl || conn.base_url || "",
        chat_path: conn.chatPath || conn.chat_path || "",
        model: conn.model || "default",
        shape: conn.shape || "ollama",
      });
      setTrace("trace-attempts", "");
      setTrace("trace-usage", "");

      const routeEl    = $("out-route");
      const acceptedEl = $("out-accepted");
      const timingEl   = $("out-timing");
      const usageEl    = $("out-usage");
      if (routeEl)    routeEl.textContent    = `model: ${conn.model || "default"}`;
      if (acceptedEl) acceptedEl.textContent = "…";
      if (timingEl)   timingEl.textContent   = "—";
      if (usageEl)    usageEl.textContent    = "—";

      try {
        const overrides = readGenOverrides();
        setTrace("trace-config", {
          provider: conn.provider || "ollama",
          base_url: conn.baseUrl || conn.base_url || "",
          chat_path: conn.chatPath || conn.chat_path || "",
          model: conn.model || "default",
          shape: conn.shape || "ollama",
          generation: overrides,
        });
        const t0 = performance.now();
        const req = {
          model: conn.model || "default",
          messages: [{ role: "user", content: prompt }],
          temperature: overrides.temperature ?? 0.8,
          max_tokens: overrides.max_tokens ?? 512,
          top_p: overrides.top_p,
          top_k: overrides.top_k,
          repeat_penalty: overrides.repeat_penalty,
        };
        const useStream = !!$("stream-toggle")?.checked;
        let response;
        if (useStream) {
          let accumulated = "";
          response = await streamGenerate(conn, req, (delta) => {
            accumulated += delta;
            setOutput(accumulated);
          });
        } else {
          response = await ollamaGenerate(conn, req);
        }
        const ms = Math.round(performance.now() - t0);
        const text = response.text || "";
        setOutput(text || "(empty response)");
        setTrace("trace-attempts", text);
        setTrace("trace-usage", { total_ms: ms, ...(response.usage || {}) });

        if (timingEl)   timingEl.textContent   = `${ms}ms`;
        if (acceptedEl) acceptedEl.textContent = text ? "✓ ok" : "✗ empty";
        const usage  = response.usage || {};
        const tokens = usage.completion_tokens ?? usage.eval_count ?? usage.total_tokens ?? null;
        if (usageEl) {
          usageEl.textContent = tokens != null ? `${tokens} tok · ${text.length} chars` : `${text.length} chars`;
        }
      } catch (e) {
        setOutput(`error: ${e.message}`);
        setTrace("trace-attempts", `error: ${e.message}`);
        if (acceptedEl) acceptedEl.textContent = "✗ error";
      }
    });
  }

  // Pre-generate: render the hydrated assembly into the stage panel and
  // switch to the Pre-generate tab. Intercepts the engine's default handler
  // (which depended on the now-removed route/base/input controls).
  const pregenBtn = $("pregenerate-btn");
  if (pregenBtn) {
    pregenBtn.addEventListener(
      "click",
      async (e) => {
        if (!registry) return;
        const missingTvars = collectMissingTvars();
        showTvarWarning(missingTvars);
        if (missingTvars.length) return;
        e.stopImmediatePropagation();
        e.preventDefault();

        const stageTab = document.querySelector('.output-tab[data-output-tab="stage"]');
        if (stageTab) stageTab.click();

        const stage = $("prompt-stage");
        const showInStage = (text, isError) => {
          if (!stage) return;
          const userList = stage.querySelector('[data-list="user"]');
          const sysList = stage.querySelector('[data-list="system"]');
          if (sysList) sysList.innerHTML = "";
          if (userList) {
            let inner;
            let footer = "";
            if (isError) {
              inner = escapeHtml(text);
            } else {
              const decorated = decoratePromptOutput(text, registry, snapshotActiveState());
              inner = decorated.html;
              footer = decorated.note;
            }
            userList.innerHTML =
              `<pre class="trace stage-prompt-pre" style="white-space:pre-wrap;font-size:12px;padding:8px;margin:0;${isError ? "color:var(--error,#f44)" : ""}">${inner}</pre>` +
              footer;
          }
          stage.querySelectorAll(".stage-empty, .stage-empty-root").forEach(
            (el) => (el.hidden = true)
          );
        };

        showInStage("(building prompt…)");

        let text;
        try {
          text = await backendHydrate(true);
        } catch (e) {
          showInStage(`error building prompt: ${e.message}`, true);
          return;
        }

        showInStage(text || "(empty — no tokens resolved)");

        const memNote = $("stage-memory-note");
        if (memNote) memNote.hidden = !hasMemoryRules();

        const ta = $("input-text");
        if (ta) {
          ta.value = text;
          ta.dataset.fromPregen = "1";
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const badge = $("stage-tab-badge");
        if (badge) badge.hidden = false;
      },
      true
    );
  }

  // ── ? Help modal ───────────────────────────────────────────────
  const HELP = {
    compose: {
      title: "Compose",
      body: `<p>Import a registry JSON and configure its sections here.</p>
        <ul>
          <li><strong>Import JSON</strong> — paste or load a registry. Sections appear below once loaded.</li>
          <li><strong>Each section</strong> — select an item from the dropdown (required sections) or check items (optional). Toggle random to let the backend pick at runtime.</li>
          <li><strong>Array modes</strong> — for list fields (nudges, examples, items) choose all, none, a specific index, or random:K.</li>
          <li><strong>Template vars</strong> — fill in <code>{placeholder}</code> values that get substituted when the prompt is built.</li>
        </ul>
        <p>Hit <strong>Pre-generate</strong> to see the resolved prompt, then <strong>Generate</strong> to send it to your local Ollama.</p>`,
    },
    state: {
      title: "Tuning",
      body: `<p>Per-generation knobs that don't change the registry structure.</p>
        <ul>
          <li><strong>Registry — Tuning Sections</strong> — slider and per-item controls for sections that support them (e.g. the sentiment intensity slider).</li>
          <li><strong>Generation Overrides</strong> — temperature, top_p, top_k, max_tokens, repeat_penalty, retries. Empty fields use the registry's defaults.</li>
          <li><strong>Output Policy</strong> — min/max length, required patterns, forbidden substrings, strip prefixes, collapse whitespace. Applied by the Python engine on the backend.</li>
        </ul>`,
    },
    registry: {
      title: "Registry",
      body: `<p>A <strong>registry</strong> is a JSON object that defines everything about a prompt: its sections, items, assembly order, generation defaults, and output policy.</p>
        <ul>
          <li><strong>Sections</strong> — named blocks of content (personas, sentiment, examples, etc). Each has items and an optional set of runtime controls.</li>
          <li><strong>assembly_order</strong> — dot-notation tokens that determine what goes into the final prompt and in what order (e.g. <code>persona.context</code>, <code>sentiment.scale</code>).</li>
          <li><strong>Runtime injections</strong> — optional fragments that, when active, filter the prompt down to only the sections they list, then append their own text.</li>
        </ul>
        <p>Use <strong>Export JSON</strong> to save the current state (selections, modes, sliders) back into a registry file you can reload later.</p>`,
    },
    output: {
      title: "Output",
      body: `<p>The Output panel has three tabs:</p>
        <ul>
          <li><strong>Output</strong> — the model's response, rendered with whitespace preserved.</li>
          <li><strong>Pre-generate</strong> — the fully resolved prompt as the Python library assembled it. Review it before sending to Ollama.</li>
          <li><strong>Raw</strong> — editable copy of the response text.</li>
        </ul>
        <p>The meta strip below the tabs shows model, acceptance status, timing, and token count.</p>`,
    },
    trace: {
      title: "Debug Trace",
      body: `<p>Shows the internals of the last generation:</p>
        <ul>
          <li><strong>User prompt</strong> — the exact text sent to Ollama.</li>
          <li><strong>Active state</strong> — selections, array modes, sliders, and template vars at generation time.</li>
          <li><strong>Config</strong> — connection details and generation overrides actually used.</li>
          <li><strong>Attempts / Usage</strong> — response text and token usage from Ollama.</li>
        </ul>`,
    },
    embedding: {
      title: "Embedding Layer",
      body: `<p>The embedding layer converts conversation text into vectors for semantic memory search. When a new message arrives, it's embedded and compared against stored conversation history to surface the most relevant past context — this becomes the <code>{memory_recall}</code> variable in your prompt.</p>
        <p>Embedding calls are made directly from your browser to your local model — the server never touches your data. On memory-enabled runs the server opens a lightweight WebSocket to your browser and delegates embed requests to it; your text goes from browser to local model and back, not through the server.</p>
        <h4>Do I need a separate embed URL?</h4>
        <p>No. If unchecked, embedding runs against the same server as your classifier (<code>classifier_url</code>). Ollama serves both chat and embedding models on the same port, so one server is usually sufficient.</p>
        <p>Enable this only if you want a dedicated embedding server — e.g. a different machine, a specialized service, or a separate Ollama instance with a faster embedding model.</p>
        <h4>Getting an embedding model (Ollama)</h4>
        <pre style="background:var(--panel-2);padding:8px 12px;border-radius:6px;font-size:12px;margin:8px 0">ollama pull nomic-embed-text</pre>
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
        <pre id="cors-tab-nix" class="cors-pre" hidden>OLLAMA_ORIGINS=${window.location.origin} ollama serve</pre>`,
    },
  };

  const helpModal = $("modal");
  const helpTitle = $("modal-title");
  const helpBody = $("modal-body");

  function openHelp(key) {
    const entry = HELP[key];
    if (!entry || !helpModal) return;
    if (helpTitle) helpTitle.textContent = entry.title;
    if (helpBody) helpBody.innerHTML = entry.body;
    helpModal.hidden = false;
  }
  function closeHelp() {
    if (helpModal) helpModal.hidden = true;
  }

  document.querySelectorAll("button.help").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openHelp(btn.dataset.help);
    });
  });
  if (helpModal) {
    helpModal.addEventListener("click", (e) => {
      if (e.target.dataset && e.target.dataset.close !== undefined) closeHelp();
    });
  }

  // ── About / Tour slideshow ──────────────────────────────────────
  const aboutModal = document.getElementById("about-modal");
  if (aboutModal) {
    const aboutSlides = aboutModal.querySelectorAll(".about-slide");
    const aboutDots = aboutModal.querySelector(".about-dots");
    const aboutPrev = document.getElementById("about-prev");
    const aboutNext = document.getElementById("about-next");
    let aboutIdx = 0;

    for (let i = 0; i < aboutSlides.length; i++) {
      const dot = document.createElement("button");
      dot.className = "about-dot" + (i === 0 ? " active" : "");
      dot.type = "button";
      dot.addEventListener("click", () => goToSlide(i));
      if (aboutDots) aboutDots.appendChild(dot);
    }

    const diagram = aboutModal.querySelector(".slide-diagram");

    function goToSlide(idx) {
      aboutSlides[aboutIdx].classList.remove("active");
      if (aboutDots) aboutDots.children[aboutIdx].classList.remove("active");
      aboutIdx = idx;
      aboutSlides[aboutIdx].classList.add("active");
      if (aboutDots) aboutDots.children[aboutIdx].classList.add("active");
      if (aboutPrev) aboutPrev.disabled = aboutIdx === 0;
      if (aboutNext) aboutNext.disabled = aboutIdx === aboutSlides.length - 1;

      // Tour prompt: show blocks whose data-show-at <= current slide
      aboutModal.querySelectorAll(".tour-block, .tour-block-divider").forEach((el) => {
        const threshold = parseInt(el.dataset.showAt, 10);
        const wasVisible = el.classList.contains("visible");
        const nowVisible = idx >= threshold;
        if (nowVisible && !wasVisible) {
          el.classList.add("visible", "just-added");
          el.addEventListener("animationend", () => el.classList.remove("just-added"), { once: true });
        } else if (!nowVisible) {
          el.classList.remove("visible", "just-added");
        }
      });

      // Tour empty message: hide once we reach its threshold slide
      aboutModal.querySelectorAll("[data-hide-at]").forEach((el) => {
        const threshold = parseInt(el.dataset.hideAt, 10);
        el.hidden = idx >= threshold;
      });

      // Diagram: light up boxes whose data-step <= current slide, active = exact match
      if (diagram) {
        diagram.classList.toggle("step-all", idx === 0);
        diagram.querySelectorAll("[data-step]").forEach((el) => {
          const step = parseInt(el.dataset.step, 10);
          el.classList.toggle("lit", idx > 0 && step <= idx);
          el.classList.toggle("lit-active", idx > 0 && step === idx);
        });
      }
    }

    if (aboutPrev) aboutPrev.addEventListener("click", () => { if (aboutIdx > 0) goToSlide(aboutIdx - 1); });
    if (aboutNext) aboutNext.addEventListener("click", () => { if (aboutIdx < aboutSlides.length - 1) goToSlide(aboutIdx + 1); });

    aboutModal.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-close-about")) aboutModal.hidden = true;
    });

    const aboutBtn = document.getElementById("about-btn");
    if (aboutBtn) aboutBtn.addEventListener("click", () => {
      goToSlide(0);
      aboutModal.hidden = false;
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (helpModal && !helpModal.hidden) closeHelp();
      if (aboutModal && !aboutModal.hidden) aboutModal.hidden = true;
    }
  });

})();
