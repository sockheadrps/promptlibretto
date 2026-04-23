import { mountConnectionChip, getConnection } from "/static/connection.js";
import { generate as ollamaGenerate } from "/static/ollama_client.js";

const $ = (sel) => document.querySelector(sel);

mountConnectionChip(document.getElementById("connection-slot"));

const els = {
  models: $("#model-list"),
  reload: $("#reload-models"),
  userInput: $("#user-input"),
  ctxTabBar: $(".ctx-tabs"),
  ctxPanels: $("#ctx-tab-panels"),
  addContext: $("#add-context"),
  run: $("#run-btn"),
  status: $("#run-status"),
  results: $("#results"),
  resultsDiff: $("#results-diff"),
  viewCards: $("#view-cards"),
  viewDiff: $("#view-diff"),
};

let availableModels = [];
// name -> [{name, runtime}] declared runtime slots per export
let modelSlots = {};
let lastResults = [];
let viewMode = "cards";

function selectedModels() {
  return Array.from(
    els.models.querySelectorAll('input[type="checkbox"]:checked')
  ).map((cb) => cb.value);
}

function modelsDeclaringSlot(slotName) {
  return availableModels.filter((m) =>
    (modelSlots[m] || []).some((s) => s.name === slotName)
  );
}

async function loadModels() {
  // Preserve current selection across reloads
  const previouslySelected = new Set(selectedModels());

  els.models.textContent = "loading…";
  try {
    const res = await fetch("/api/exports");
    const data = await res.json();
    const rows = data.exports || [];
    availableModels = rows.map((r) => r.name);
    modelSlots = {};
    for (const r of rows) modelSlots[r.name] = r.slots || [];
    if (!rows.length) {
      els.models.innerHTML = `<div class="muted">No saved exports. Build one in <a href="/">the studio</a> first.</div>`;
      return;
    }
    els.models.innerHTML = "";
    for (const row of rows) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = row.name;
      cb.dataset.name = row.name;
      if (previouslySelected.has(row.name)) cb.checked = true;
      cb.addEventListener("change", () => {
        syncCtxTabs();
        autoloadSlots();
      });
      label.appendChild(cb);
      const text = document.createElement("span");
      const slotNames = (row.slots || []).map((s) =>
        s.runtime === "required" ? `${s.name}*` : s.name
      );
      text.textContent = slotNames.length
        ? `${row.name}  ⟨${slotNames.join(", ")}⟩`
        : row.name;
      label.appendChild(text);
      const inspectBtn = document.createElement("button");
      inspectBtn.type = "button";
      inspectBtn.className = "inspect-btn";
      inspectBtn.textContent = "{ }";
      inspectBtn.title = "Inspect export JSON";
      inspectBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openInspectModal(row.name);
      });
      label.appendChild(inspectBtn);
      els.models.appendChild(label);
    }
    syncCtxTabs();
  } catch (e) {
    els.models.textContent = `failed to load: ${e}`;
  }
}

// --- context override tabs ---------------------------------------------

let activeCtxTab = "__all__";

function syncCtxTabs() {
  const sel = selectedModels();
  // Build tab bar: "All Models" + one per selected model
  els.ctxTabBar.innerHTML = "";
  const allTab = document.createElement("div");
  allTab.className = "ctx-tab" + (activeCtxTab === "__all__" ? " active" : "");
  allTab.textContent = "All";
  allTab.dataset.ctxTab = "__all__";
  allTab.role = "tab";
  allTab.addEventListener("click", () => switchCtxTab("__all__"));
  els.ctxTabBar.appendChild(allTab);

  for (const name of sel) {
    const tab = document.createElement("div");
    tab.className = "ctx-tab" + (activeCtxTab === name ? " active" : "");
    tab.textContent = name;
    tab.dataset.ctxTab = name;
    tab.role = "tab";
    tab.addEventListener("click", () => switchCtxTab(name));
    els.ctxTabBar.appendChild(tab);
  }

  // If active tab was deselected, fall back to "All"
  if (activeCtxTab !== "__all__" && !sel.includes(activeCtxTab)) {
    activeCtxTab = "__all__";
  }

  // Ensure each tab (including "All") has a panel
  ensureCtxPanel("__all__");
  for (const name of sel) ensureCtxPanel(name);

  // Show/hide panels
  for (const panel of els.ctxPanels.children) {
    panel.hidden = panel.dataset.ctxPanel !== activeCtxTab;
  }

  // Update active state on tabs
  for (const tab of els.ctxTabBar.children) {
    tab.classList.toggle("active", tab.dataset.ctxTab === activeCtxTab);
  }

  // Render per-model summary when "All" tab is active
  renderCtxSummary(sel);
}

function ensureCtxPanel(id) {
  if (els.ctxPanels.querySelector(`[data-ctx-panel="${id}"]`)) return;
  const panel = document.createElement("div");
  panel.className = "context-rows";
  panel.dataset.ctxPanel = id;
  panel.hidden = true;
  els.ctxPanels.appendChild(panel);
}

function renderCtxSummary(sel) {
  // Remove old summary
  const old = els.ctxPanels.querySelector(".ctx-summary");
  if (old) old.remove();

  if (activeCtxTab !== "__all__") return;

  // Collect per-model rows
  const entries = [];
  for (const model of sel) {
    const panel = els.ctxPanels.querySelector(`[data-ctx-panel="${model}"]`);
    if (!panel) continue;
    const rows = [];
    for (const row of panel.querySelectorAll(".context-row")) {
      const k = (row.querySelector(".ctx-key").value || "").trim();
      const v = row.querySelector(".ctx-val").value || "";
      if (k) rows.push({ k, v });
    }
    if (rows.length) entries.push({ model, rows });
  }

  if (!entries.length) return;

  const allPanel = els.ctxPanels.querySelector('[data-ctx-panel="__all__"]');
  const summary = document.createElement("div");
  summary.className = "ctx-summary";
  summary.innerHTML = `<div class="ctx-summary-title">Per-model overrides</div>` +
    entries.map(({ model, rows }) =>
      `<div class="ctx-summary-model">
        <span class="ctx-summary-name">${model}</span>
        ${rows.map(({ k, v }) =>
          `<span class="ctx-summary-pair"><span class="ctx-summary-key">${k}</span> = <span class="ctx-summary-val">${v || '""'}</span></span>`
        ).join("")}
      </div>`
    ).join("");
  allPanel.appendChild(summary);

  // Live-update: re-render on input changes in model panels
  // (handled by syncCtxTabs being called on tab switch)
}

function switchCtxTab(id) {
  activeCtxTab = id;
  syncCtxTabs();
}

function addContextRow({ key = "", value = "", target = null } = {}) {
  const tabId = target || activeCtxTab;
  ensureCtxPanel(tabId);
  const panel = els.ctxPanels.querySelector(`[data-ctx-panel="${tabId}"]`);
  const row = document.createElement("div");
  row.className = "context-row";
  row.innerHTML = `
    <div class="ctx-main">
      <input class="ctx-key" placeholder="key (e.g. focus)" />
      <input class="ctx-val" placeholder="value" />
      <button class="ghost small ctx-remove" type="button" title="remove row">×</button>
    </div>
  `;
  row.querySelector(".ctx-key").value = key;
  row.querySelector(".ctx-val").value = value;
  row.querySelector(".ctx-remove").addEventListener("click", () => row.remove());
  panel.appendChild(row);
  return row;
}

const ctxStatus = $("#ctx-status");

function flashCtxStatus(msg) {
  ctxStatus.textContent = msg;
  clearTimeout(ctxStatus._timer);
  ctxStatus._timer = setTimeout(() => { ctxStatus.textContent = ""; }, 3000);
}

function autoloadSlots() {
  const sel = selectedModels();
  for (const model of sel) {
    const slots = modelSlots[model] || [];
    if (!slots.length) continue;
    ensureCtxPanel(model);
    const panel = els.ctxPanels.querySelector(`[data-ctx-panel="${model}"]`);
    const existingKeys = new Set(
      Array.from(panel.querySelectorAll(".ctx-key")).map((i) => i.value.trim()).filter(Boolean)
    );
    for (const s of slots) {
      if (existingKeys.has(s.name)) continue;
      addContextRow({ key: s.name, value: "", target: model });
    }
  }
}

function gatherContextRows() {
  const out = [];
  const sel = selectedModels();

  // "All" panel rows — no exclude
  const allPanel = els.ctxPanels.querySelector('[data-ctx-panel="__all__"]');
  if (allPanel) {
    for (const row of allPanel.querySelectorAll(".context-row")) {
      const k = row.querySelector(".ctx-key").value.trim();
      const v = row.querySelector(".ctx-val").value;
      if (!k) continue;
      out.push({ key: k, value: v, exclude: [] });
    }
  }

  // Per-model panel rows — exclude all other selected models
  for (const model of sel) {
    const panel = els.ctxPanels.querySelector(`[data-ctx-panel="${model}"]`);
    if (!panel) continue;
    for (const row of panel.querySelectorAll(".context-row")) {
      const k = row.querySelector(".ctx-key").value.trim();
      const v = row.querySelector(".ctx-val").value;
      if (!k) continue;
      const exclude = sel.filter((m) => m !== model);
      out.push({ key: k, value: v, exclude });
    }
  }

  return out;
}

function gatherSelectedModels() {
  return Array.from(
    els.models.querySelectorAll('input[type="checkbox"]:checked')
  ).map((cb) => cb.value);
}

function renderResults(results) {
  lastResults = results;
  if (viewMode === "diff") {
    renderDiff(results);
  } else {
    renderCards(results);
  }
}

function renderCards(results) {
  if (!results.length) {
    els.results.innerHTML = `<div class="muted" style="padding:12px">No models selected.</div>`;
    return;
  }
  els.results.innerHTML = "";
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "result-card" + (r.ok ? "" : " error");
    const header = document.createElement("header");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = r.name;
    header.appendChild(name);
    if (r.ok) {
      const route = document.createElement("span");
      route.className = "pill muted";
      route.textContent = `route: ${r.route}`;
      header.appendChild(route);
      const accepted = document.createElement("span");
      accepted.className = "pill muted";
      accepted.textContent = r.accepted ? "accepted" : "rejected";
      header.appendChild(accepted);
      const spacer = document.createElement("span");
      spacer.className = "spacer";
      header.appendChild(spacer);
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "ghost small";
      useBtn.textContent = "Use as context →";
      useBtn.title =
        "Add this output as a context row for the next ensemble run";
      useBtn.addEventListener("click", () => useAsContext(r));
      header.appendChild(useBtn);
    } else {
      const tag = document.createElement("span");
      tag.className = "pill muted";
      tag.textContent = "error";
      header.appendChild(tag);
    }
    if (r.ok && r.prompt) {
      const flipBtn = document.createElement("button");
      flipBtn.type = "button";
      flipBtn.className = "ghost small flip-btn";
      flipBtn.textContent = "Show prompt";
      flipBtn.title = "Toggle output ↔ resolved prompt + context";
      flipBtn.addEventListener("click", () => toggleFlip(card, flipBtn));
      header.appendChild(flipBtn);
    }
    card.appendChild(header);
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = r.ok ? r.text || "(empty)" : r.error || "unknown error";
    card.appendChild(body);
    if (r.ok && r.prompt) {
      const promptView = document.createElement("div");
      promptView.className = "body prompt-view";
      promptView.hidden = true;
      promptView.appendChild(buildPromptView(r));
      card.appendChild(promptView);
    }
    els.results.appendChild(card);
  }
}

function toggleFlip(card, btn) {
  const out = card.querySelector(".body:not(.prompt-view)");
  const prompt = card.querySelector(".prompt-view");
  if (!prompt) return;
  const showingPrompt = !prompt.hidden;
  prompt.hidden = showingPrompt;
  out.hidden = !showingPrompt;
  btn.textContent = showingPrompt ? "Show prompt" : "Show output";
}

function buildPromptView(r) {
  const wrap = document.createElement("div");
  const ctx = r.context_applied || {};
  const ctxKeys = Object.keys(ctx);
  if (ctxKeys.length) {
    const ctxBlock = document.createElement("div");
    ctxBlock.className = "prompt-section";
    const h = document.createElement("div");
    h.className = "prompt-section-label";
    h.textContent = "context applied";
    ctxBlock.appendChild(h);
    const pre = document.createElement("pre");
    pre.className = "prompt-pre";
    pre.textContent = ctxKeys
      .map((k) => `{${k}: ${JSON.stringify(ctx[k])}}`)
      .join("\n");
    ctxBlock.appendChild(pre);
    wrap.appendChild(ctxBlock);
  }
  if (r.prompt.system) {
    wrap.appendChild(promptBlock("system", r.prompt.system));
  }
  wrap.appendChild(promptBlock("user", r.prompt.user || "(empty)"));
  return wrap;
}

function promptBlock(label, text) {
  const block = document.createElement("div");
  block.className = "prompt-section";
  const h = document.createElement("div");
  h.className = "prompt-section-label";
  h.textContent = label;
  block.appendChild(h);
  const pre = document.createElement("pre");
  pre.className = "prompt-pre";
  pre.textContent = text;
  block.appendChild(pre);
  return block;
}

function useAsContext(result) {
  const defaultKey = result.name.replace(/[^A-Za-z0-9_]/g, "_");
  const key = prompt(
    "Context key for this output (kwarg name on the next run):",
    `from_${defaultKey}`
  );
  if (!key) return;
  const excludeSelf = confirm(
    `Exclude "${result.name}" from receiving this row on the next run?\n\nOK = exclude source model (recommended — avoids feeding its own output back).\nCancel = broadcast to all selected models.`
  );
  const row = addContextRow({
    key,
    value: result.text || "",
    exclude: excludeSelf ? [result.name] : [],
  });
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  // Briefly flash to confirm the add
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 800);
}

function splitBlocks(text) {
  return (text || "")
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderDiff(results) {
  const ok = results.filter((r) => r.ok);
  if (!ok.length) {
    els.resultsDiff.innerHTML = `<div class="muted" style="padding:12px">No successful results to diff.</div>`;
    return;
  }
  const cols = ok.map((r) => ({ name: r.name, blocks: splitBlocks(r.text) }));
  const maxRows = Math.max(...cols.map((c) => c.blocks.length));

  const table = document.createElement("div");
  table.className = "diff-table";
  table.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;

  const headerRow = document.createElement("div");
  headerRow.className = "diff-row diff-header";
  for (const c of cols) {
    const cell = document.createElement("div");
    cell.className = "diff-cell diff-name";
    cell.textContent = c.name;
    headerRow.appendChild(cell);
  }
  table.appendChild(headerRow);

  for (let i = 0; i < maxRows; i++) {
    const row = document.createElement("div");
    row.className = "diff-row";
    const blocks = cols.map((c) => c.blocks[i] || "");
    const allSame =
      blocks.every((b) => b === blocks[0]) && blocks[0] !== "";
    for (const b of blocks) {
      const cell = document.createElement("div");
      cell.className =
        "diff-cell" + (b === "" ? " diff-empty" : allSame ? " diff-same" : " diff-diff");
      cell.textContent = b || "—";
      row.appendChild(cell);
    }
    table.appendChild(row);
  }

  els.resultsDiff.innerHTML = "";
  els.resultsDiff.appendChild(table);
}

function setView(mode) {
  viewMode = mode;
  els.viewCards.classList.toggle("active", mode === "cards");
  els.viewDiff.classList.toggle("active", mode === "diff");
  els.results.hidden = mode !== "cards";
  els.resultsDiff.hidden = mode !== "diff";
  if (lastResults.length) renderResults(lastResults);
}

async function run() {
  const exports_ = gatherSelectedModels();
  if (!exports_.length) {
    els.status.textContent = "select at least one model";
    return;
  }
  const body = {
    exports: exports_,
    user_input: els.userInput.value,
    context: gatherContextRows(),
  };
  const conn = getConnection();
  const useBrowserDirect = !!conn.model;

  els.run.disabled = true;
  els.status.textContent = `running ${exports_.length}…`;
  const t0 = performance.now();
  try {
    const data = useBrowserDirect
      ? await runBrowserDirect(body, conn)
      : await runServerSide(body);
    const ms = Math.round(performance.now() - t0);
    els.status.textContent = `${data.results.length} done in ${ms} ms`;
    renderResults(data.results);
  } catch (e) {
    els.status.textContent = `failed: ${e.message || e}`;
  } finally {
    els.run.disabled = false;
  }
}

async function runServerSide(body) {
  const res = await fetch("/api/ensemble/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

async function runBrowserDirect(body, conn) {
  // 1. Resolve all members server-side (no LLM call).
  const resolveRes = await fetch("/api/ensemble/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resolveRes.ok) {
    const err = await resolveRes.json().catch(() => ({}));
    throw new Error(err.detail || `${resolveRes.status}`);
  }
  const { results: resolved } = await resolveRes.json();

  // 2. For each ok resolution, fan out to the browser's configured LLM,
  //    then post the raw output through /api/process for policy cleanup.
  //    All fan-outs run in parallel — each member is independent.
  const tasks = resolved.map(async (r) => {
    if (!r.ok) return r;
    const providerReq = {
      ...r.provider_request,
      model: conn.model || r.provider_request.model,
    };
    try {
      const llm = await ollamaGenerate(conn, providerReq);
      const processed = await postJson("/api/process", {
        raw_text: llm.text,
        output_policy: r.output_policy,
        route: r.route,
        usage: llm.usage || null,
        timing: llm.timing || null,
        trace_scaffolding: null,
        debug: false,
        attempt_history: [],
      });
      return {
        name: r.name,
        ok: true,
        text: processed.text,
        accepted: processed.accepted,
        route: r.route,
        context_applied: r.context_applied,
        prompt: r.prompt,
      };
    } catch (err) {
      return {
        name: r.name,
        ok: false,
        error: `provider unreachable: ${err.message || err}`,
        context_applied: r.context_applied,
      };
    }
  });
  const results = await Promise.all(tasks);
  return { results };
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `${res.status}`);
  }
  return res.json();
}

els.reload.addEventListener("click", loadModels);
els.addContext.addEventListener("click", () => addContextRow());
els.run.addEventListener("click", run);
els.viewCards.addEventListener("click", () => setView("cards"));
els.viewDiff.addEventListener("click", () => setView("diff"));

loadModels();
syncCtxTabs();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadModels();
});
window.addEventListener("focus", loadModels);

// --- help tooltips -----------------------------------------------------

const ENSEMBLE_HELP = {
  "ensemble-input": {
    title: "Input & Context",
    body: `<p>This panel controls what gets sent to every selected model when you hit <strong>Run</strong>.</p>
      <ul>
        <li><strong>Shared Directive</strong> — the prompt, question, or instruction that all models receive identically. Think of it as the common task you're comparing their responses to.</li>
        <li><strong>Context Overrides</strong> — key-value pairs broadcast to each model as runtime arguments. They fill declared slots or become overlays, letting you steer each model's behavior without editing the export itself.</li>
      </ul>
      <p>Each model runs independently with its own route, system prompt, and overlays — the directive and context are the shared inputs that let you compare apples to apples.</p>`,
  },
  "ensemble-directive": {
    title: "Shared Directive",
    body: `<p>The prompt sent to <em>every</em> selected model as <code>user_input</code>. This is the common request all models will respond to — your question, instruction, brief, or source text.</p>
      <p>Each model's export defines its own system prompt, route, and overlays. The directive is the one thing they all share, making it the control variable when comparing outputs side-by-side.</p>`,
  },
  "ensemble-context": {
    title: "Context Overrides",
    body: `<p>Key-value pairs passed to each model's <code>run()</code> call. Organized by tabs:</p>
      <ul>
        <li><strong>All</strong> — rows here are sent to every selected model.</li>
        <li><strong>Per-model tabs</strong> — appear when you select models. Rows here are sent only to that specific model, useful for model-specific runtime slots.</li>
      </ul>
      <p>If a model declares a <strong>runtime slot</strong> matching the key, the value fills that slot in the prompt template. Otherwise it becomes a <strong>priority-10 overlay</strong>.</p>
      <p><strong>Preload slots</strong> auto-creates rows in each model's tab for its declared runtime slots.</p>`,
  },
};

function openEnsembleHelp(key) {
  const h = ENSEMBLE_HELP[key];
  if (!h) return;
  inspectTitle.textContent = h.title;
  inspectJson.innerHTML = h.body;
  inspectJson.className = "inspect-json inspect-json--help";
  inspectModal.hidden = false;
}

document.querySelectorAll("button.help[data-help]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEnsembleHelp(btn.dataset.help);
  });
});

// --- inspect export modal ----------------------------------------------

function highlightJson(json) {
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, num) => {
      if (str) {
        return colon
          ? `<span class="json-key">${str}</span>:`
          : `<span class="json-str">${str}</span>`;
      }
      if (bool) return `<span class="json-bool">${match}</span>`;
      if (num) return `<span class="json-num">${match}</span>`;
      return match;
    }
  );
}

const inspectModal = document.getElementById("inspect-modal");
const inspectTitle = document.getElementById("inspect-title");
const inspectJson = document.getElementById("inspect-json");

function closeInspectModal() {
  inspectModal.hidden = true;
}

inspectModal.querySelectorAll("[data-close-inspect]").forEach((el) =>
  el.addEventListener("click", closeInspectModal)
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !inspectModal.hidden) closeInspectModal();
});

async function openInspectModal(name) {
  inspectTitle.textContent = name;
  inspectJson.className = "inspect-json";
  inspectJson.textContent = "Loading…";
  inspectModal.hidden = false;
  try {
    const res = await fetch(`/api/exports/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const row = await res.json();
    const formatted = JSON.stringify(row.data || row, null, 2);
    inspectJson.innerHTML = highlightJson(formatted);
  } catch (e) {
    inspectJson.textContent = `Failed to load: ${e.message}`;
  }
}
