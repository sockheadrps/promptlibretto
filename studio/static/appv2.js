// promptlibretto studio — registry client.
//
// Reads/writes the registry JSON entirely client-side: import a registry,
// pick selections, set runtime modes, hydrate, and call the LLM via the
// user's local Ollama (browser-direct). Server is only used as a thin
// proxy through `/api/registry/*` if needed.

import { mountWorkspaceChip } from "/static/session.js";
import { mountConnectionChip, getConnection } from "/static/connection.js";
import { generate as ollamaGenerate } from "/static/ollama_client.js";

const $ = (id) => document.getElementById(id);

// Mount header chips (workspace + connection indicator).
mountWorkspaceChip($("connection-slot"));
mountConnectionChip($("connection-slot"));

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
//   { "registry": { version, title, description, assembly_order, <section>: { required, template_vars, items } } }
//
// Renders a select (required, single-choice) or checkboxes (optional, multi)
// for each section that has items, plus text inputs for each section's
// template_vars. Walks assembly_order to hydrate a final prompt and pushes
// it into #input-text on demand. Self-contained — does not touch the
// engine's existing route/base flow.
(() => {
  const importBtn = $("registry-import-btn");
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
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Always-shown text", type: "textarea" },
      { field: "fragments", label: "Conditional fragments", type: "fragments" },
    ],
    personas: [
      { field: "id", label: "ID", type: "text" },
      { field: "context", label: "Context", type: "textarea" },
      { field: "base_directives", label: "Base Directives (one per line)", type: "lines" },
    ],
    sentiment: [
      { field: "id", label: "ID", type: "text" },
      { field: "context", label: "Context", type: "text" },
      { field: "nudges", label: "Nudges (one per line)", type: "lines" },
      { field: "examples", label: "Examples (one per line)", type: "lines" },
    ],
    static_injections: [
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
    ],
    runtime_injections: [
      { field: "id", label: "ID", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
      { field: "required", label: "Required", type: "bool" },
      { field: "include_sections", label: "Include Sections", type: "section-checks" },
    ],
    output_prompt_directions: [
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
    ],
    examples: [
      { field: "name", label: "Name", type: "text" },
      { field: "items", label: "Items (one per line)", type: "lines" },
    ],
    prompt_endings: [
      { field: "name", label: "Name", type: "text" },
      { field: "items", label: "Items (one per line)", type: "lines" },
    ],
  };

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
  function sectionKeys() {
    return Object.keys(registry).filter((k) =>
      registry[k] && typeof registry[k] === "object" && Array.isArray(registry[k].items)
    );
  }


  // Only these array fields get a per-field runtime mode selector
  // (the user explicitly asked for nudges/examples; pool-shaped sections
  // store their list in `items`). Other arrays — base_directives,
  // include_sections, runtime_variables — are not user-randomizable.
  const ARRAY_MODE_FIELDS = new Set(["nudges", "examples", "items", "base_directives"]);
  function arrayFieldsOf(item) {
    if (!item || typeof item !== "object") return [];
    return Object.keys(item).filter(
      (k) => ARRAY_MODE_FIELDS.has(k) && Array.isArray(item[k])
    );
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
  function arrayModeOptionsHtml(secKey, field, values) {
    if (!values || !values.length) return "";
    const cur = getArrayMode(secKey, field);
    const isRandom = cur.startsWith("random:");
    const isIndex = cur.startsWith("index:");
    const isNone = cur === "none";
    const isAll = !isRandom && !isIndex && !isNone;
    const selIdx = isIndex ? parseInt(cur.slice(6), 10) : -1;
    const k = isRandom ? Math.max(1, parseInt(cur.slice(7), 10) || 1) : 1;

    const allOpt = `<option value="all"${isAll ? " selected" : ""}>(all values)</option>`;
    const noneOpt = `<option value="none"${isNone ? " selected" : ""}>(none — skip)</option>`;
    const itemOpts = values
      .map(
        (v, i) =>
          `<option value="index:${i}"${
            i === selIdx ? " selected" : ""
          }>${escapeHtml(truncateForOption(v))}</option>`
      )
      .join("");

    return (
      `<div class="registry-mode-row" data-mode-row="${escapeHtml(secKey)}::${escapeHtml(
        field
      )}">` +
      // Value picker row (hidden when Random is on)
      `<div class="registry-mode-pick" data-pick-mode="value"${isRandom ? " hidden" : ""}>` +
      `<span class="registry-mode-label">${escapeHtml(field)}:</span>` +
      `<select data-mode-control="value">${allOpt}${noneOpt}${itemOpts}</select>` +
      `</div>` +
      // Random-count row (shown when Random is on)
      `<div class="registry-mode-pick" data-pick-mode="random"${isRandom ? "" : " hidden"}>` +
      `<span class="registry-mode-label">${escapeHtml(field)}:</span>` +
      `<span class="registry-mode-rand-text">pick</span>` +
      `<input type="number" min="1" max="${values.length}" value="${k}" class="registry-mode-count" data-mode-control="count">` +
      `<span class="registry-mode-rand-text">random of ${values.length} at run time</span>` +
      `</div>` +
      // Toggle
      `<label class="registry-mode-rand"><input type="checkbox" data-mode-control="rand"${
        isRandom ? " checked" : ""
      }><span>Random selection</span></label>` +
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
        return `<label class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><textarea ${common} rows="3">${escapeHtml(v ?? "")}</textarea></label>`;
      }
      if (f.type === "lines") {
        const text = Array.isArray(v) ? v.join("\n") : "";
        return `<label class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><textarea ${common} rows="3" placeholder="one per line">${escapeHtml(
          text
        )}</textarea></label>`;
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
      const ifVar = (frag && (frag.if_var || frag.var)) || "";
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
        `<input type="text" data-frag-text value="${escapeHtml(text)}" placeholder="fragment text — use {var}…">` +
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

  // Read fragments from a fragments-row container into [{if_var, text}].
  function readFragmentsFromRow(rowEl) {
    if (!rowEl) return [];
    return Array.from(rowEl.querySelectorAll(".registry-frag-row"))
      .map((r) => ({
        if_var: (r.querySelector("[data-frag-var]") || {}).value || "",
        text: (r.querySelector("[data-frag-text]") || {}).value || "",
      }))
      .filter((f) => f.if_var || f.text);
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
          `<input type="text" data-frag-text placeholder="fragment text — use {var}…">` +
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
          const pickValue = row.querySelector("[data-pick-mode='value']");
          const pickRandom = row.querySelector("[data-pick-mode='random']");
          const valueSel = row.querySelector("[data-mode-control='value']");
          const randCb = row.querySelector("[data-mode-control='rand']");
          const countInp = row.querySelector("[data-mode-control='count']");
          const recompute = () => {
            if (randCb.checked) {
              const n = Math.max(1, parseInt(countInp.value, 10) || 1);
              setArrayMode(section, field, `random:${n}`);
              if (pickValue) pickValue.hidden = true;
              if (pickRandom) pickRandom.hidden = false;
            } else {
              setArrayMode(section, field, valueSel.value);
              if (pickValue) pickValue.hidden = false;
              if (pickRandom) pickRandom.hidden = true;
            }
          };
          valueSel.addEventListener("change", recompute);
          randCb.addEventListener("change", recompute);
          countInp.addEventListener("input", recompute);
        });
      }
    }
  }

  // ─── Add-item form (collapsible, schema-strict) ────────────
  function addFormHtml(key) {
    const schema = ITEM_SCHEMA[key] || [
      { field: "name", label: "Name", type: "text" },
      { field: "text", label: "Text", type: "textarea" },
    ];
    const rows = schema.map((f) => {
      const inputId = `addform-${key}-${f.field}`;
      if (f.type === "textarea") {
        return `<label class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><textarea id="${inputId}" rows="3"></textarea></label>`;
      }
      if (f.type === "lines") {
        return `<label class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><textarea id="${inputId}" rows="3" placeholder="one per line"></textarea></label>`;
      }
      if (f.type === "bool") {
        return `<label class="registry-add-row registry-add-row--inline"><span>${escapeHtml(
          f.label
        )}</span><input type="checkbox" id="${inputId}" checked></label>`;
      }
      if (f.type === "section-checks") {
        const allKeys = sectionKeys().filter((k) => k !== key);
        const boxes = allKeys
          .map(
            (sk) =>
              `<label class="registry-check"><input type="checkbox" data-include="${escapeHtml(
                sk
              )}"><span>${escapeHtml(SECTION_LABELS[sk] || sk)}</span></label>`
          )
          .join("");
        return `<div class="registry-add-row"><span>${escapeHtml(
          f.label
        )}</span><div class="registry-checks" id="${inputId}">${boxes}</div></div>`;
      }
      if (f.type === "fragments") {
        return fragmentsEditorHtml(key, "", [], { editor: false });
      }
      return `<label class="registry-add-row"><span>${escapeHtml(
        f.label
      )}</span><input type="text" id="${inputId}"></label>`;
    });
    return (
      `<div class="registry-add-form" hidden data-form-for="${escapeHtml(key)}">` +
      rows.join("") +
      `<div class="registry-add-actions">` +
      `<button type="button" class="ghost-action small" data-add-cancel="${escapeHtml(
        key
      )}">Cancel</button>` +
      `<button type="button" class="ghost-action small" data-add-submit="${escapeHtml(
        key
      )}">Save</button>` +
      `</div></div>`
    );
  }

  function readAddForm(key, formEl) {
    const schema = ITEM_SCHEMA[key] || [];
    const item = {};
    for (const f of schema) {
      if (f.type === "fragments") {
        const row = formEl.querySelector(
          `.registry-fragments-row[data-frag-form="${key}"]`
        );
        const frags = readFragmentsFromRow(row);
        if (frags.length) item[f.field] = frags;
        continue;
      }
      const el = formEl.querySelector(`#addform-${key}-${f.field}`);
      if (!el) continue;
      if (f.type === "lines") {
        item[f.field] = el.value
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (f.type === "bool") {
        item[f.field] = !!el.checked;
      } else if (f.type === "section-checks") {
        item[f.field] = Array.from(el.querySelectorAll("input[data-include]:checked")).map(
          (cb) => cb.dataset.include
        );
      } else {
        item[f.field] = el.value.trim();
      }
    }
    return item;
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
        // Per-injection: enable checkbox + sub-checkboxes for which other
        // sections to include in the output when this injection is active.
        const otherSecs = sectionKeys().filter((k) => k !== "runtime_injections");
        inputHtml =
          `<div class="registry-rti-list">` +
          sec.items
            .map((it, idx) => {
              const id = it.id || it.name || `item_${idx}`;
              const includes = Array.isArray(it.include_sections)
                ? it.include_sections
                : [];
              return (
                `<div class="registry-rti-row">` +
                `<label class="registry-check registry-rti-enable"><input type="checkbox" data-section="${escapeHtml(
                  key
                )}" value="${escapeHtml(id)}"><span><strong>${escapeHtml(
                  id
                )}</strong></span></label>` +
                `<div class="registry-rti-includes">` +
                `<small class="muted">Include only these sections when active:</small>` +
                `<div class="registry-checks">` +
                otherSecs
                  .map(
                    (sk) =>
                      `<label class="registry-check"><input type="checkbox" data-rti-include="${escapeHtml(
                        id
                      )}::${escapeHtml(sk)}"${
                        includes.includes(sk) ? " checked" : ""
                      }><span>${escapeHtml(SECTION_LABELS[sk] || sk)}</span></label>`
                  )
                  .join("") +
                `</div></div></div>`
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
        inputHtml =
          `<select data-section="${escapeHtml(key)}">` +
          sec.items
            .map((it, idx) => {
              const id = it.id || it.name || `item_${idx}`;
              return `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`;
            })
            .join("") +
          `</select>`;
      }

      // Section-level "random 1" toggle for required, non-base_context.
      let randomHtml = "";
      if (sectionRandomEligible(key) && hasItems) {
        randomHtml =
          `<label class="registry-random-row"><input type="checkbox" data-random-section="${escapeHtml(
            key
          )}"${sectionRandom[key] ? " checked" : ""}><span>Pick a random ${escapeHtml(
            label.toLowerCase()
          )} at run time</span></label>`;
      }

      // Sentiment intensity slider — drives the `sentiment.scale` token.
      let sliderHtml = "";
      if (key === "sentiment") {
        const cur = sectionSliders[key] != null ? sectionSliders[key] : 5;
        const isRand = !!sectionSliderRandom[key];
        sliderHtml =
          `<div class="registry-slider-row">` +
          `<label>Intensity: <span data-slider-value="${escapeHtml(
            key
          )}">${cur}</span> / 10</label>` +
          `<input type="range" min="1" max="10" value="${cur}" data-slider="${escapeHtml(
            key
          )}"${isRand ? " disabled" : ""}>` +
          `<label class="registry-slider-rand"><input type="checkbox" data-slider-random="${escapeHtml(
            key
          )}"${isRand ? " checked" : ""}><span>Random at run time</span></label>` +
          `</div>`;
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
        `<button type="button" class="registry-add-btn" data-add-toggle="${escapeHtml(
          key
        )}" title="Add new item">+</button>` +
        `</span>` +
        `</div>` +
        inputHtml +
        randomHtml +
        sliderHtml +
        varsHtml +
        addFormHtml(key) +
        `<div class="registry-editors"></div>` +
        `<div class="registry-modes"></div>`;
      containerFor(key).appendChild(card);
    }

    for (const host of bothContainers()) {
      host.querySelectorAll("select[data-section], input[data-section]").forEach((el) => {
        el.addEventListener("change", refreshSectionPreviews);
      });
      host.querySelectorAll("input[data-tvar]").forEach((el) => {
        el.addEventListener("input", () => {
          tvarValues[el.dataset.tvar] = el.value;
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
      host.querySelectorAll("input[data-random-section]").forEach((el) => {
        el.addEventListener("change", () => {
          sectionRandom[el.dataset.randomSection] = el.checked;
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
      host.querySelectorAll("input[data-rti-include]").forEach((el) => {
        el.addEventListener("change", () => {
          const [id, sk] = el.dataset.rtiInclude.split("::");
          const items =
            (registry.runtime_injections && registry.runtime_injections.items) || [];
          const item = items.find((it) => (it.id || it.name) === id);
          if (!item) return;
          if (!Array.isArray(item.include_sections)) item.include_sections = [];
          if (el.checked) {
            if (!item.include_sections.includes(sk)) item.include_sections.push(sk);
          } else {
            item.include_sections = item.include_sections.filter((s) => s !== sk);
          }
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
      host.querySelectorAll("[data-add-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.dataset.addToggle;
          const card = host.querySelector(`.registry-section[data-key="${k}"]`);
          const form = card && card.querySelector(`[data-form-for="${k}"]`);
          if (form) {
            form.hidden = !form.hidden;
            if (!form.hidden) wireFragmentRows(form, /* editor */ false);
          }
        });
      });
      host.querySelectorAll("[data-add-cancel]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.dataset.addCancel;
          const card = host.querySelector(`.registry-section[data-key="${k}"]`);
          const form = card && card.querySelector(`[data-form-for="${k}"]`);
          if (form) form.hidden = true;
        });
      });
      host.querySelectorAll("[data-add-submit]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.dataset.addSubmit;
          const card = host.querySelector(`.registry-section[data-key="${k}"]`);
          const form = card && card.querySelector(`[data-form-for="${k}"]`);
          if (!form) return;
          const item = readAddForm(k, form);
          const idVal = item.id || item.name;
          if (!idVal) {
            alert("Item needs an id or name.");
            return;
          }
          registry[k].items.push(item);
          buildControls();
        });
      });
    }

    refreshSectionPreviews();
  }

  // Adopt a parsed registry dict as the current registry. Used by both
  // the paste-JSON importer and the built-in examples modal. Lifts any
  // baked tool-state (`selected`, `section_random`, `array_modes`,
  // `slider`, `slider_random`) out of each section and into the
  // matching runtime state objects so a registry exported with those
  // fields round-trips on import.
  function loadRegistryDict(parsed) {
    registry = parsed.registry || parsed;
    Object.keys(tvarValues).forEach((k) => delete tvarValues[k]);
    Object.keys(arrayModes).forEach((k) => delete arrayModes[k]);
    Object.keys(sectionRandom).forEach((k) => delete sectionRandom[k]);
    Object.keys(sectionSliders).forEach((k) => delete sectionSliders[k]);
    Object.keys(sectionSliderRandom).forEach((k) => delete sectionSliderRandom[k]);

    const bakedSelections = {};
    for (const k of sectionKeys()) {
      const sec = registry[k];
      if (!sec) continue;
      if (sec.selected !== undefined && sec.selected !== null) {
        bakedSelections[k] = sec.selected;
      }
      if (typeof sec.section_random === "boolean") sectionRandom[k] = sec.section_random;
      if (sec.array_modes && typeof sec.array_modes === "object") {
        arrayModes[k] = { ...sec.array_modes };
      }
      if (typeof sec.slider === "number") sectionSliders[k] = sec.slider;
      if (typeof sec.slider_random === "boolean") sectionSliderRandom[k] = sec.slider_random;
      if (sec.template_var_defaults && typeof sec.template_var_defaults === "object") {
        for (const [v, val] of Object.entries(sec.template_var_defaults)) {
          if (val == null) continue;
          tvarValues[`${k}::${v}`] = String(val);
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
    applySelections(bakedSelections);
    refreshSectionPreviews();
  }

  importBtn.addEventListener("click", () => {
    const raw = prompt("Paste Registry JSON:");
    if (!raw) return;
    try {
      loadRegistryDict(JSON.parse(raw));
    } catch (e) {
      alert("Import failed: " + e.message);
    }
  });

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

  async function openExamplesModal() {
    if (!examplesModal || !examplesList) return;
    examplesList.innerHTML = `<div class="muted" style="padding:8px">Loading…</div>`;
    examplesModal.hidden = false;
    try {
      const res = await fetch("/static/examples/index.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const data = await res.json();
      const items = (data.examples || []).map((ex, i) => {
        const name = escapeHtml(ex.name || ex.file || `example_${i}`);
        const desc = escapeHtml(ex.description || "");
        return (
          `<div class="snapshot-row">` +
          `<div class="snapshot-meta">` +
          `<div class="snapshot-row-name">${name}</div>` +
          (desc ? `<div class="muted">${desc}</div>` : "") +
          `</div>` +
          `<div class="snapshot-actions">` +
          `<button type="button" class="ghost-action small" data-example-load="${escapeHtml(
            ex.file || ""
          )}">Load</button>` +
          `</div></div>`
        );
      });
      examplesList.innerHTML = items.length
        ? items.join("")
        : `<div class="muted" style="padding:8px">No examples shipped.</div>`;
      examplesList.querySelectorAll("[data-example-load]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const file = btn.dataset.exampleLoad;
          if (!file) return;
          try {
            const r = await fetch(`/static/examples/${file}`, { cache: "no-cache" });
            if (!r.ok) throw new Error(`fetch ${file} ${r.status}`);
            loadRegistryDict(await r.json());
            closeExamplesModal();
          } catch (e) {
            alert(`Failed to load ${file}: ${e.message}`);
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
        if (sel) sel.value = val;
      }
    }
  }

  function captureSnapshot(name) {
    const snap = {
      name,
      savedAt: new Date().toISOString(),
      registry: JSON.parse(JSON.stringify(registry)),
      selections: captureSelections(),
      arrayModes: JSON.parse(JSON.stringify(arrayModes)),
      sectionRandom: JSON.parse(JSON.stringify(sectionRandom)),
      sectionSliders: JSON.parse(JSON.stringify(sectionSliders)),
      sectionSliderRandom: JSON.parse(JSON.stringify(sectionSliderRandom)),
      tvarValues: JSON.parse(JSON.stringify(tvarValues)),
    };
    const policy = readPolicyEditor();
    if (policy) snap.output_policy = policy;
    return snap;
  }

  function restoreSnapshot(snap) {
    if (!snap || !snap.registry) return;
    registry = JSON.parse(JSON.stringify(snap.registry));
    Object.keys(arrayModes).forEach((k) => delete arrayModes[k]);
    Object.assign(arrayModes, snap.arrayModes || {});
    Object.keys(sectionRandom).forEach((k) => delete sectionRandom[k]);
    Object.assign(sectionRandom, snap.sectionRandom || {});
    Object.keys(sectionSliders).forEach((k) => delete sectionSliders[k]);
    Object.assign(sectionSliders, snap.sectionSliders || {});
    Object.keys(sectionSliderRandom).forEach((k) => delete sectionSliderRandom[k]);
    Object.assign(sectionSliderRandom, snap.sectionSliderRandom || {});
    Object.keys(tvarValues).forEach((k) => delete tvarValues[k]);
    Object.assign(tvarValues, snap.tvarValues || {});

    const title = registry.title || "registry";
    const ver = registry.version != null ? ` v${registry.version}` : "";
    metaEl.textContent = `${title}${ver} · ${sectionKeys().length} sections`;
    if (exportBtn) exportBtn.disabled = false;
    applyGenOverridesToInputs(registry.generation || snap.generation || {});
    populatePolicyEditor(snap.output_policy || registry.output_policy || {});
    buildControls();
    applySelections(snap.selections || {});
    refreshSectionPreviews();

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
        out[key].selected = selEl ? selEl.value : null;
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
  const exportBtn = $("registry-export-btn");
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
    return {
      selections: registry ? captureSelections() : {},
      array_modes: arrayModes,
      section_random: sectionRandom,
      sliders: sectionSliders,
      slider_random: sectionSliderRandom,
      template_vars: tvarValues,
    };
  }

  async function backendHydrate() {
    const state = snapshotActiveState();
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

  const generateBtn = $("generate-btn");
  if (generateBtn) {
    generateBtn.addEventListener("click", async () => {
      if (!registry) return;

      const rendered = $("output-rendered");
      const raw = $("output-raw");
      const setOutput = (text) => {
        if (rendered) {
          rendered.textContent = text;
          rendered.classList.remove("italic");
        }
        if (raw) raw.value = text;
      };

      const outputTab = document.querySelector('.output-tab[data-output-tab="output"]');
      if (outputTab) outputTab.click();
      setOutput("(building prompt…)");

      let prompt;
      try {
        prompt = await backendHydrate();
      } catch (e) {
        setOutput(`error building prompt: ${e.message}`);
        return;
      }

      const ta = $("input-text");
      if (ta) {
        ta.value = prompt;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
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

      // Reset meta pills before the call.
      const routeEl = $("out-route");
      const acceptedEl = $("out-accepted");
      const timingEl = $("out-timing");
      const usageEl = $("out-usage");
      if (routeEl) routeEl.textContent = `model: ${conn.model || "default"}`;
      if (acceptedEl) acceptedEl.textContent = "…";
      if (timingEl) timingEl.textContent = "—";
      if (usageEl) usageEl.textContent = "—";

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
        const response = await ollamaGenerate(conn, {
          model: conn.model || "default",
          messages: [{ role: "user", content: prompt }],
          temperature: overrides.temperature ?? 0.8,
          max_tokens: overrides.max_tokens ?? 512,
          top_p: overrides.top_p,
          top_k: overrides.top_k,
          repeat_penalty: overrides.repeat_penalty,
        });
        const ms = Math.round(performance.now() - t0);
        const text = response.text || "";
        setOutput(text || "(empty response)");
        setTrace("trace-attempts", text);
        setTrace("trace-usage", { total_ms: ms, ...(response.usage || {}) });

        // Meta strip
        if (timingEl) timingEl.textContent = `${ms}ms`;
        if (acceptedEl) acceptedEl.textContent = text ? "✓ ok" : "✗ empty";
        const usage = response.usage || {};
        const tokens =
          usage.completion_tokens ?? usage.eval_count ?? usage.total_tokens ?? null;
        if (usageEl) {
          if (tokens != null) {
            usageEl.textContent = `${tokens} tok · ${text.length} chars`;
          } else {
            usageEl.textContent = `${text.length} chars`;
          }
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
            userList.innerHTML = `<pre class="trace" style="white-space:pre-wrap;font-size:12px;padding:8px;margin:0;${isError ? "color:var(--error,#f44)" : ""}">${escapeHtml(text)}</pre>`;
          }
          stage.querySelectorAll(".stage-empty, .stage-empty-root").forEach(
            (el) => (el.hidden = true)
          );
        };

        showInStage("(building prompt…)");

        let text;
        try {
          text = await backendHydrate();
        } catch (e) {
          showInStage(`error building prompt: ${e.message}`, true);
          return;
        }

        showInStage(text || "(empty — no tokens resolved)");

        const ta = $("input-text");
        if (ta) {
          ta.value = text;
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

    function goToSlide(idx) {
      aboutSlides[aboutIdx].classList.remove("active");
      if (aboutDots) aboutDots.children[aboutIdx].classList.remove("active");
      aboutIdx = idx;
      aboutSlides[aboutIdx].classList.add("active");
      if (aboutDots) aboutDots.children[aboutIdx].classList.add("active");
      if (aboutPrev) aboutPrev.disabled = aboutIdx === 0;
      if (aboutNext) aboutNext.disabled = aboutIdx === aboutSlides.length - 1;
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
