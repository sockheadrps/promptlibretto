// Connection config: base URL + chat path + payload shape + selected model.
// Persisted in localStorage, edited via a small modal, and read by the
// generate/stream paths before every call to the user's local Ollama.

import { DEFAULT_CONNECTION, listModels, testConnection } from "/static/ollama_client.js";

const STORAGE_KEY = "promptlibretto.connection.v1";

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}
  return null;
}

function saveStored(conn) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  } catch {}
}

let state = { ...DEFAULT_CONNECTION, model: "", ...(loadStored() || {}) };

export function getConnection() {
  return { ...state };
}

const listeners = new Set();
export function onConnectionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit(next) {
  state = { ...state, ...next };
  saveStored(state);
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

// ── Modal UI ──────────────────────────────────────────────────────

function ensureModal() {
  let modal = document.getElementById("connection-modal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "connection-modal";
  modal.className = "modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal-backdrop" data-close-conn></div>
    <div class="modal-card">
      <header>
        <h3>Connection</h3>
        <button class="modal-close" type="button" data-close-conn>×</button>
      </header>
      <div class="modal-body">
        <p class="hint">The studio sends prompt construction instructions to your browser, which then calls your local model directly. Nothing flows through the studio server.</p>
        <div class="dialog-form">
          <label>Base URL
            <input type="text" id="conn-base-url" placeholder="http://localhost:11434" />
          </label>
          <label>Chat path
            <input type="text" id="conn-chat-path" placeholder="/api/chat" />
            <span class="hint">Ollama: <code>/api/chat</code>. OpenAI-compatible (llama.cpp, vLLM): <code>/v1/chat/completions</code>.</span>
          </label>
          <label>Payload shape
            <select id="conn-shape">
              <option value="auto">auto</option>
              <option value="ollama">ollama</option>
              <option value="openai">openai</option>
            </select>
          </label>
          <label>Model
            <select id="conn-model"></select>
            <span class="hint" id="conn-model-hint">Test connection to list available models.</span>
          </label>
          <div class="dialog-actions">
            <button type="button" class="ghost" id="conn-test">Test connection</button>
            <span class="spacer" style="flex:1"></span>
            <button type="button" class="ghost" data-close-conn>Cancel</button>
            <button type="button" class="primary" id="conn-save">Save</button>
          </div>
          <div id="conn-status" class="hint"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-conn]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (!modal.hidden && e.key === "Escape") closeModal();
  });

  modal.querySelector("#conn-test").addEventListener("click", () => doTest({ manual: true }));
  modal.querySelector("#conn-save").addEventListener("click", doSave);

  // Auto-fetch models when the endpoint fields settle.
  let debounce;
  const onEndpointChange = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => doTest({ manual: false }), 400);
  };
  modal.querySelector("#conn-base-url").addEventListener("input", onEndpointChange);
  modal.querySelector("#conn-chat-path").addEventListener("input", onEndpointChange);
  modal.querySelector("#conn-shape").addEventListener("change", onEndpointChange);

  return modal;
}

function readForm() {
  const modal = ensureModal();
  return {
    baseUrl: modal.querySelector("#conn-base-url").value.trim() || DEFAULT_CONNECTION.baseUrl,
    chatPath: modal.querySelector("#conn-chat-path").value.trim() || DEFAULT_CONNECTION.chatPath,
    payloadShape: modal.querySelector("#conn-shape").value || DEFAULT_CONNECTION.payloadShape,
    model: modal.querySelector("#conn-model").value || "",
    timeoutMs: state.timeoutMs || DEFAULT_CONNECTION.timeoutMs,
  };
}

function writeForm(conn) {
  const modal = ensureModal();
  modal.querySelector("#conn-base-url").value = conn.baseUrl || "";
  modal.querySelector("#conn-chat-path").value = conn.chatPath || "";
  modal.querySelector("#conn-shape").value = conn.payloadShape || "auto";
  populateModels(conn.model ? [conn.model] : [], conn.model);
}

function populateModels(names, selected) {
  const modal = ensureModal();
  const sel = modal.querySelector("#conn-model");
  sel.innerHTML = "";
  if (!names.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— no models yet —";
    sel.appendChild(opt);
    return;
  }
  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    if (n === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

function setStatus(msg, kind) {
  const modal = ensureModal();
  const el = modal.querySelector("#conn-status");
  el.textContent = msg;
  el.dataset.kind = kind || "";
}

let testSeq = 0;

async function doTest({ manual } = { manual: true }) {
  const conn = readForm();
  if (!conn.baseUrl || !/^https?:\/\//.test(conn.baseUrl)) {
    if (manual) setStatus("Enter a full URL (http://host:port).", "warn");
    populateModels([], "");
    return;
  }
  const seq = ++testSeq;
  setStatus("Checking…", "");
  try {
    const models = await listModels(conn);
    if (seq !== testSeq) return; // a newer test superseded this one
    if (!models.length) {
      setStatus("Reached the server but no models are listed.", "warn");
      populateModels([], "");
      return;
    }
    populateModels(models, conn.model || models[0]);
    setStatus(`${models.length} model${models.length === 1 ? "" : "s"} available — pick one and Save.`, "ok");
  } catch (err) {
    if (seq !== testSeq) return;
    setStatus(`Can't reach server: ${err.message || err}`, manual ? "err" : "warn");
    populateModels([], "");
  }
}

function doSave() {
  const next = readForm();
  if (!next.model) {
    setStatus("Pick a model before saving.", "err");
    return;
  }
  commit(next);
  closeModal();
}

export function openConnectionModal() {
  const modal = ensureModal();
  writeForm(state);
  setStatus("");
  modal.hidden = false;
  // If we already have a URL, try to fetch models in the background.
  if (state.baseUrl) doTest({ manual: false });
}

function closeModal() {
  const modal = document.getElementById("connection-modal");
  if (modal) modal.hidden = true;
}

// ── Header chip ───────────────────────────────────────────────────

export function mountConnectionChip(container) {
  if (!container) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "meta-chip meta-chip--action";
  btn.id = "connection-chip";
  btn.addEventListener("click", openConnectionModal);
  container.appendChild(btn);

  function render() {
    const host = (() => {
      try { return new URL(state.baseUrl).host; } catch { return state.baseUrl; }
    })();
    const model = state.model || "no model";
    btn.innerHTML = `
      <span class="chip-dot" data-ok="${state.model ? "1" : "0"}"></span>
      <span class="chip-label">${host}</span>
      <span class="chip-sep">·</span>
      <span class="chip-model">${model}</span>
    `;
    btn.title = state.model ? "Click to change connection" : "Click to set up your local LLM connection";
  }
  render();
  onConnectionChange(render);

  // First-time users: auto-open the modal so they configure before generating.
  if (!state.model) {
    setTimeout(openConnectionModal, 300);
  }
}
