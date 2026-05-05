const SNAPSHOT_KEY = "pl-registry-snapshots-v1";
const REGISTRY_KEY = "pl-registry-v2";
const CONN_KEY = "promptlibretto.connection.v1";

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let activeReader = null;
let activeSessionId = null;
let activeEmbedWs = null;
const participantState = { a: null, b: null };
let hasRun = false;

// Examples loaded dynamically from builder-examples/index.json.
let _exampleIndex = null;
async function getExampleIndex() {
  if (_exampleIndex) return _exampleIndex;
  try {
    const res = await fetch("/static/builder-examples/index.json", { cache: "no-cache" });
    if (!res.ok) return [];
    const data = await res.json();
    _exampleIndex = data.examples || [];
  } catch (_) { _exampleIndex = []; }
  return _exampleIndex;
}

// ── connection ────────────────────────────────────────────────────

function getStudioConnection() {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function renderConnChip() {
  const chip = document.getElementById("conn-chip");
  const conn = getStudioConnection();
  if (!conn || !conn.baseUrl) {
    chip.textContent = "⚠ no studio connection";
    chip.classList.add("missing");
    return;
  }
  let host;
  try { host = new URL(conn.baseUrl).host; } catch { host = conn.baseUrl; }
  const model = conn.model || "no model";
  chip.textContent = `${host} · ${model}`;
  chip.classList.remove("missing");
}

// ── snapshots ─────────────────────────────────────────────────────

async function loadSnapshots() {
  const raw = localStorage.getItem(SNAPSHOT_KEY);
  let snaps = [];
  try { snaps = JSON.parse(raw) || []; } catch (_) {}

  const current = localStorage.getItem(REGISTRY_KEY);
  const examples = await getExampleIndex();

  for (const side of ["a", "b"]) {
    const sel = document.getElementById(`${side}-snapshot`);
    sel.innerHTML = '<option value="">Load Snapshot or Example…</option>';

    // Builder examples — loaded from index.json.
    if (examples.length) {
      const og = document.createElement("optgroup");
      og.label = "Examples";
      for (const ex of examples) {
        const file = (ex.file || "").replace(/\.json$/, "");
        const opt = document.createElement("option");
        opt.value = `__example__:${file}`;
        opt.textContent = ex.name || file;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }

    // Current studio registry (if any).
    if (current) {
      const og = document.createElement("optgroup");
      og.label = "Studio";
      const opt = document.createElement("option");
      opt.value = "__current__";
      opt.textContent = "current studio registry";
      og.appendChild(opt);
      sel.appendChild(og);
    }

    // User-saved snapshots from localStorage.
    if (snaps.length) {
      const og = document.createElement("optgroup");
      og.label = "Saved";
      for (const snap of snaps) {
        const opt = document.createElement("option");
        opt.value = snap.name;
        opt.textContent = snap.name;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
  }

  return snaps;
}

// Convert v22-style flat state fields into v2 sections dict.
function _legacyToV2State(selections, sliders, arrayModes, sliderRandom, sectionRandom, templateVars) {
  const sections = {};
  const allKeys = new Set([
    ...Object.keys(selections || {}),
    ...Object.keys(sliders || {}),
    ...Object.keys(arrayModes || {}),
    ...Object.keys(sectionRandom || {}),
    ...Object.keys(sliderRandom || {}),
  ]);
  for (const k of Object.keys(templateVars || {})) {
    const sep = k.indexOf("::");
    if (sep > 0) allKeys.add(k.slice(0, sep));
  }
  for (const key of allKeys) {
    const sec = {};
    const sel = selections?.[key];
    if (sel !== undefined && sel !== null) sec.selected = sel;
    if (sliders?.[key] != null) sec.slider = sliders[key];
    if (sliderRandom?.[key]) sec.slider_random = true;
    if (sectionRandom?.[key]) sec.section_random = true;
    const modes = arrayModes?.[key];
    if (modes && Object.keys(modes).length) sec.array_modes = { ...modes };
    const prefix = key + "::";
    const tvars = {};
    for (const [k, v] of Object.entries(templateVars || {})) {
      if (k.startsWith(prefix)) tvars[k.slice(prefix.length)] = v;
    }
    if (Object.keys(tvars).length) sec.template_vars = tvars;
    if (Object.keys(sec).length) sections[key] = sec;
  }
  return sections;
}

function snapToV2State(snap) {
  if (snap.state && typeof snap.state === "object" && !Array.isArray(snap.state)) return snap.state;
  return _legacyToV2State(
    snap.selections, snap.sectionSliders, snap.arrayModes,
    snap.sectionSliderRandom, snap.sectionRandom, snap.tvarValues
  );
}

async function loadSnapshot(side) {
  const sel = document.getElementById(`${side}-snapshot`);
  const val = sel.value;
  if (!val) return;

  let registry = null;
  let snap = null;
  let preset = null;

  if (val.startsWith("__example__:")) {
    const file = val.slice("__example__:".length);
    try {
      const resp = await fetch(`/static/builder-examples/${file}.json`);
      if (!resp.ok) throw new Error(`failed to fetch example: ${resp.status}`);
      registry = await resp.json();
    } catch (e) {
      setStatus(`example load failed: ${e.message}`);
      return;
    }
  } else if (val === "__current__") {
    const raw = localStorage.getItem(REGISTRY_KEY);
    try { registry = JSON.parse(raw); } catch (_) {}
  } else {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    let snaps = [];
    try { snaps = JSON.parse(raw) || []; } catch (_) {}
    snap = snaps.find(s => s.name === val) || null;
    if (snap) registry = snap.registry ?? snap.data ?? snap;
  }

  if (!registry) {
    setStatus("snapshot not found or empty");
    return;
  }

  document.getElementById(`${side}-registry`).value = JSON.stringify(registry, null, 2);

  // hydrate state — merge snap.state (live user values) over reg.default_state
  const reg = registry?.registry ?? registry;
  if (reg?.default_state && typeof reg.default_state === "object") {
    const baseState = reg.default_state;
    const liveState = (snap?.state && typeof snap.state === "object") ? snap.state : {};
    const merged = {};
    for (const key of new Set([...Object.keys(baseState), ...Object.keys(liveState)])) {
      const b = baseState[key] || {};
      const l = liveState[key] || {};
      merged[key] = { ...b, ...l, template_vars: { ...(b.template_vars || {}), ...(l.template_vars || {}) } };
    }
    participantState[side] = merged;
    // Auto-fill participant name from registry title if still the default A/B.
    const nameEl = document.getElementById(`${side}-name`);
    if (nameEl && /^[AB]$/i.test(nameEl.value.trim()) && reg.title) {
      nameEl.value = reg.title;
    }
  } else if (snap) {
    participantState[side] = snapToV2State(snap);
  } else {
    participantState[side] = null;
  }

  // prefer model from registry generation config, fall back to studio connection model
  const model = reg?.generation?.model || getStudioConnection()?.model;
  if (model) document.getElementById(`${side}-model`).value = model;

  renderTvarInputs(side, reg);
  refreshSummary(side);
}

const ENSEMBLE_RUNTIME_VARS = new Set(["memory_recall", "other_name", "thoughts_about_other", "working_notes", "system_summary", "rule_ending"]);

function rerenderTvars(side) {
  const raw = document.getElementById(`${side}-registry`)?.value?.trim();
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const reg = parsed?.registry ?? parsed;
    renderTvarInputs(side, reg);
  } catch (_) {}
}

function renderTvarInputs(side, reg) {
  const container = document.getElementById(`${side}-tvars`);
  if (!container) return;

  const inputs = [];
  if (reg && typeof reg === "object") {
    for (const [secKey, sec] of Object.entries(reg)) {
      if (!sec || !Array.isArray(sec.template_vars)) continue;
      for (const v of sec.template_vars) {
        if (ENSEMBLE_RUNTIME_VARS.has(v)) continue;
        if (v === "user_input") continue;
        const existing = participantState[side]?.[secKey]?.template_vars?.[v];
        inputs.push({ secKey, varName: v, value: existing || "" });
      }
    }
  }

  if (!inputs.length) { container.innerHTML = ""; return; }

  const rows = inputs.map(({ secKey, varName, value }) =>
    `<label class="pcard-tvar-row">` +
    `<span class="pcard-tvar-label"><span class="pcard-tvar-sec">${escapeHtml(secKey)}</span> · <code>${escapeHtml(varName)}</code></span>` +
    `<input type="text" class="pcard-tvar-input" value="${escapeHtml(value)}" ` +
    `data-tvar-side="${escapeHtml(side)}" data-tvar-sec="${escapeHtml(secKey)}" data-tvar-var="${escapeHtml(varName)}" ` +
    `placeholder="${escapeHtml(varName)}">` +
    `</label>`
  ).join("");

  container.innerHTML =
    `<details class="pcard-tvars-detail" open>` +
    `<summary class="pcard-tvars-summary">Template vars</summary>` +
    `<div class="pcard-tvars-body">${rows}</div>` +
    `</details>`;

  container.querySelectorAll(".pcard-tvar-input").forEach((inp) => {
    inp.addEventListener("input", () => {
      const { tvarSide, tvarSec, tvarVar } = inp.dataset;
      if (!participantState[tvarSide]) participantState[tvarSide] = {};
      if (!participantState[tvarSide][tvarSec]) participantState[tvarSide][tvarSec] = {};
      if (!participantState[tvarSide][tvarSec].template_vars) participantState[tvarSide][tvarSec].template_vars = {};
      participantState[tvarSide][tvarSec].template_vars[tvarVar] = inp.value;
    });
  });
}

function refreshSummary(side) {
  const name  = document.getElementById(`${side}-name`).value.trim() || side.toUpperCase();
  const model = document.getElementById(`${side}-model`).value.trim();
  const reg   = document.getElementById(`${side}-registry`).value.trim();
  const human = document.getElementById(`${side}-human`)?.checked;
  const mem   = document.getElementById(`${side}-memory`)?.checked;

  const nameEl  = document.getElementById(`${side}-summary-name`);
  const metaEl  = document.getElementById(`${side}-summary-meta`);
  const chipsEl = document.getElementById(`${side}-summary-chips`);

  if (nameEl) nameEl.textContent = name;

  let meta;
  if (human) {
    meta = "human-driven";
  } else if (reg) {
    meta = model ? `${model}` : "(model not set)";
  } else {
    meta = "— configure —";
  }
  if (metaEl) metaEl.textContent = meta;

  if (chipsEl) {
    chipsEl.innerHTML = "";
    if (human) chipsEl.innerHTML += `<span class="pcard-chip human">human</span>`;
    if (mem && !human) chipsEl.innerHTML += `<span class="pcard-chip memory">memory</span>`;
  }
}

// ── run ───────────────────────────────────────────────────────────

function parseRegistry(side) {
  const raw = document.getElementById(`${side}-registry`).value.trim();
  if (!raw) throw new Error(`Participant ${side.toUpperCase()}: registry JSON is empty`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Participant ${side.toUpperCase()}: invalid JSON — ${e.message}`);
  }
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function setRunning(running) {
  document.getElementById("btn-run").disabled = running;
  document.getElementById("btn-stop").classList.toggle("visible", running);
}

async function startEnsemble() {
  const humanA = document.getElementById("a-human")?.checked || false;
  const humanB = document.getElementById("b-human")?.checked || false;
  const memA = document.getElementById("a-memory")?.checked !== false;
  const memB = document.getElementById("b-memory")?.checked !== false;

  const num = (id) => {
    const v = document.getElementById(id)?.value;
    if (v === "" || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (id) => !!document.getElementById(id)?.checked;
  const text = (id) => {
    const v = document.getElementById(id)?.value;
    return (typeof v === "string" && v.trim()) ? v.trim() : null;
  };

  const memOverrides = (side) => {
    const out = {};
    const numFields = [
      "history_window", "top_k",
      "working_notes_every_n_turns", "working_notes_max_tokens",
      "system_summary_every_n_turns", "system_summary_max_tokens",
    ];
    for (const f of numFields) {
      const v = num(`${side}-${f}`);
      if (v != null) out[f] = v;
    }
    if (document.getElementById(`${side}-working_notes_enabled`)) {
      out.working_notes_enabled = bool(`${side}-working_notes_enabled`);
    }
    if (document.getElementById(`${side}-system_summary_enabled`)) {
      out.system_summary_enabled = bool(`${side}-system_summary_enabled`);
    }
    const aboutMe = text(`${side}-notes_about_me_prompt`);
    const aboutOther = text(`${side}-notes_about_other_prompt`);
    if (aboutMe)    out.notes_about_me_prompt    = aboutMe;
    if (aboutOther) out.notes_about_other_prompt = aboutOther;
    const embedUrl  = text(`${side}-embed_url`);
    const embedPath = text(`${side}-embed_path`);
    if (embedUrl)  out.embed_url  = embedUrl;
    if (embedPath) out.embed_path = embedPath;
    return out;
  };

  const genOverrides = (side) => {
    const out = {};
    const fields = ["temperature", "top_p", "top_k", "max_tokens", "repeat_penalty", "retries"];
    for (const f of fields) {
      const v = num(`${side}-gen-${f}`);
      if (v != null) out[f] = v;
    }
    return out;
  };

  const overA = memOverrides("a");
  const overB = memOverrides("b");
  const genA  = genOverrides("a");
  const genB  = genOverrides("b");

  let registryA = {};
  let registryB = {};
  try {
    if (!humanA) registryA = parseRegistry("a");
    if (!humanB) registryB = parseRegistry("b");
  } catch (e) {
    setStatus(e.message);
    return;
  }

  const seed = document.getElementById("seed").value.trim();

  const conn = getStudioConnection();
  if (!conn || !conn.baseUrl) {
    setStatus("no studio connection — configure it in Studio first");
    return;
  }

  // Resolve embed config for a side: UI override > registry memory_config > baseUrl fallback.
  function sideEmbedCfg(side, regObj) {
    const mc = (regObj?.registry ?? regObj)?.memory_config ?? {};
    const urlOverride = document.getElementById(`${side}-embed_url`)?.value?.trim();
    const pathOverride = document.getElementById(`${side}-embed_path`)?.value?.trim();
    return {
      url:   urlOverride || mc.embed_url   || mc.classifier_url || conn.baseUrl,
      path:  pathOverride || mc.embed_path || "/api/embed",
      model: mc.embed_model || "nomic-embed-text",
      shape: mc.embed_payload_shape || "auto",
    };
  }

  // When either side is human-driven, run open-ended (capped huge); user stops manually.
  const turnsRaw = document.getElementById("turns").value.trim();
  const anyHuman = humanA || humanB;
  let turns;
  if (anyHuman && (turnsRaw === "" || turnsRaw === "∞" || turnsRaw === "0")) {
    turns = 10000;
  } else {
    turns = parseInt(turnsRaw, 10) || 8;
  }
  const nameA = document.getElementById("a-name").value.trim() || "A";
  const nameB = document.getElementById("b-name").value.trim() || "B";
  const modelA = document.getElementById("a-model").value.trim() || conn.model || "llama3";
  const modelB = document.getElementById("b-model").value.trim() || conn.model || "llama3";

  clearConversation();
  if (seed) showSeed(seed);
  setRunning(true);
  setStatus("connecting…");

  // Collapse setup cards while running so the conversation has more space.
  document.getElementById("card-a")?.removeAttribute("open");
  document.getElementById("card-b")?.removeAttribute("open");

  const sessionId = crypto.randomUUID();
  activeSessionId = sessionId;

  // Open embed WebSocket before POST so the server can route embed_requests to us.
  if (memA || memB) {
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const embedWs = new WebSocket(`${wsProto}//${location.host}/api/ensemble/ws/${sessionId}/embed`);
    activeEmbedWs = embedWs;

    const cfgA = sideEmbedCfg("a", registryA);
    const cfgB = sideEmbedCfg("b", registryB);

    embedWs.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === "embed_request") {
        const { id, text: embedText, side } = msg;
        const cfg = side === "b" ? cfgB : cfgA;
        const embedUrl = cfg.url.replace(/\/$/, "") + cfg.path;
        try {
          const resp = await fetch(embedUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: cfg.model, input: embedText }),
          });
          if (!resp.ok) throw new Error(`embed HTTP ${resp.status}`);
          const data = await resp.json();
          const vectors = data.embeddings?.[0] ?? data.data?.[0]?.embedding ?? data.embedding ?? [];
          embedWs.send(JSON.stringify({ type: "embed_result", id, vectors }));
        } catch (e) {
          embedWs.send(JSON.stringify({ type: "embed_error", id, error: String(e.message) }));
        }

      } else if (msg.type === "chat_request") {
        const { id, model, messages, temperature, max_tokens, top_p, top_k, repeat_penalty } = msg;
        const isOpenAI = conn.chatPath?.includes("/v1/") || conn.payloadShape === "openai";
        const chatUrl = conn.baseUrl.replace(/\/$/, "") + (conn.chatPath || "/api/chat");
        try {
          let body;
          if (isOpenAI) {
            body = { model, messages, temperature, max_tokens, stream: true };
            if (top_p   != null) body.top_p            = top_p;
            if (repeat_penalty != null) body.frequency_penalty = repeat_penalty;
          } else {
            const options = {};
            if (temperature    != null) options.temperature    = temperature;
            if (top_p          != null) options.top_p          = top_p;
            if (top_k          != null) options.top_k          = top_k;
            if (repeat_penalty != null) options.repeat_penalty = repeat_penalty;
            body = { model, messages, options, stream: true };
            if (max_tokens != null) body.num_predict = max_tokens;
          }
          const resp = await fetch(chatUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!resp.ok) throw new Error(`chat HTTP ${resp.status}`);

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let raw = trimmed;
              if (isOpenAI) {
                if (!trimmed.startsWith("data:")) continue;
                raw = trimmed.slice(5).trim();
                if (raw === "[DONE]") continue;
              }
              try {
                const chunk = JSON.parse(raw);
                const delta = isOpenAI
                  ? (chunk.choices?.[0]?.delta?.content ?? "")
                  : (chunk.message?.content ?? chunk.content ?? "");
                if (delta) embedWs.send(JSON.stringify({ type: "chat_chunk", id, delta }));
              } catch { /* skip malformed */ }
            }
          }
          embedWs.send(JSON.stringify({ type: "chat_done", id }));
        } catch (e) {
          embedWs.send(JSON.stringify({ type: "chat_error", id, error: String(e.message) }));
        }
      }
    };

    // Wait for WS to open before sending the POST.
    await new Promise((resolve, reject) => {
      embedWs.onopen = resolve;
      embedWs.onerror = () => reject(new Error("embed WebSocket failed to open"));
    });
  }

  const body = JSON.stringify({
    a: { registry: registryA, model: modelA, name: nameA, state: participantState.a || {}, human: humanA, memory_enabled: memA, memory_overrides: overA, generation_overrides: genA },
    b: { registry: registryB, model: modelB, name: nameB, state: participantState.b || {}, human: humanB, memory_enabled: memB, memory_overrides: overB, generation_overrides: genB },
    seed,
    turns,
    session_id: sessionId,
    // Backend gating is purely the auto/step toggle — we never gate at the
    // backend for TTS. TTS pacing is a frontend visual: bubbles render
    // blurred until their audio plays. Generation runs as fast as it can.
    auto_run: !!document.getElementById("auto-run")?.checked,
    connection: {
      base_url: conn.baseUrl,
      chat_path: conn.chatPath || "/api/chat",
      payload_shape: conn.payloadShape || "auto",
    },
  });

  try {
    const resp = await fetch("/api/ensemble/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`server error ${resp.status}: ${text}`);
    }

    const reader = resp.body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buf = "";

    setStatus("running…");

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let event;
        try { event = JSON.parse(payload); } catch (_) { continue; }
        handleEvent(event, nameA, nameB);
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") {
      showError(e.message);
      setStatus("error");
    }
  } finally {
    activeReader = null;
    if (activeEmbedWs) {
      activeEmbedWs.close();
      activeEmbedWs = null;
    }
    hasRun = true;
    updateSeedVisibility();
    setRunning(false);
  }
}

async function stepEnsemble() {
  // Manual step button — only visible when TTS is idle anyway, but keep
  // the guard.
  if (ttsIsBusy()) return;
  await triggerStep();
}

// ── TTS ───────────────────────────────────────────────────────────
// Bubble pipeline:
//   - generation may continue while the previous turn is being spoken.
//   - bubbles generated during that audio render blurred, and their
//     memory/about trace is held back.
//   - when the held turn's own TTS starts (or its reveal-only queue item is
//     reached), the bubble and trace reveal together.
//   - clicking a blurred bubble cancels the current utterance and skips
//     forward to play that bubble's audio next.
let _voicesCache = [];
// Each item: { utterance, side, bubbleEl }
const _ttsQueue = [];
let _ttsActive = null;     // currently playing { utterance, side, bubbleEl }
let _stepPending = false;  // backend is awaiting our /step request (manual step mode only)
const _turnGates = new Map();

function getTurnGate(turn) {
  if (!_turnGates.has(turn)) {
    _turnGates.set(turn, {
      hold: false,
      released: false,
      traceRendered: false,
      traceEvent: null,
      bubbleRef: null,
    });
  }
  return _turnGates.get(turn);
}

function holdBubble(bubbleEl) {
  if (!bubbleEl) return;
  bubbleEl.classList.add("bubble-blurred");
  bubbleEl.title = "Generated while the previous turn is still speaking.";
}

function renderHeldTraceIfReady(gate) {
  if (!gate || gate.traceRendered || !gate.traceEvent) return;
  const event = gate.traceEvent;
  renderSidePanel(event.side, event.speaker, event.trace);
  gate.traceRendered = true;
}

function shouldHoldScrollForGate(gate) {
  return !!(gate && gate.hold && !gate.released && ttsIsBusy());
}

function revealTurnGate(turn) {
  const gate = _turnGates.get(turn);
  if (!gate) return;
  gate.hold = false;
  gate.released = true;
  if (gate.bubbleRef?.bubble) {
    gate.bubbleRef.bubble.classList.remove("bubble-blurred");
    gate.bubbleRef.bubble.title = "";
  }
  renderHeldTraceIfReady(gate);
  scrollToBottom();
}

function revealBubbleTurn(bubbleEl) {
  const turn = Number(bubbleEl?.dataset?.turnIdx);
  if (Number.isFinite(turn)) revealTurnGate(turn);
  else if (bubbleEl) bubbleEl.classList.remove("bubble-blurred");
}

function revealAllHeldTurns() {
  for (const turn of _turnGates.keys()) revealTurnGate(turn);
}

function loadVoices() {
  if (typeof speechSynthesis === "undefined") return;
  _voicesCache = speechSynthesis.getVoices() || [];
  // Read persisted settings so we can restore the saved voice once the
  // browser actually delivers the voice list (which is async on Chromium).
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PARTICIPANT_SETTINGS_KEY) || "{}"); } catch (_) {}
  for (const side of ["a", "b"]) {
    const sel = document.getElementById(`${side}-tts-voice`);
    if (!sel) continue;
    const target = sel.value || saved[side]?.["tts-voice"] || "";
    sel.innerHTML = '<option value="">— default —</option>' +
      _voicesCache.map((v) => `<option value="${escHtml(v.name)}">${escHtml(v.name)} (${escHtml(v.lang)})</option>`).join("");
    if (target && _voicesCache.some((v) => v.name === target)) {
      sel.value = target;
    }
  }
}

function ttsIsBusy() {
  return !!_ttsActive || _ttsQueue.length > 0;
}

function pumpTtsQueue() {
  if (_ttsActive || _ttsQueue.length === 0) return;
  const item = _ttsQueue.shift();
  _ttsActive = item;
  // Keep held content blurred until the browser confirms audio actually
  // started. Some voices have a small scheduling delay after speak().
  const finish = () => {
    if (typeof item.onReveal === "function") item.onReveal();
    if (_ttsActive === item) _ttsActive = null;
    refreshStepButton();
    pumpTtsQueue();
  };
  if (!item.utterance) {
    finish();
    return;
  }
  item.utterance.onend = finish;
  item.utterance.onerror = finish;
  // onstart fires when audio actually begins; reveal the response and its
  // memory/about trace at the same moment.
  item.utterance.onstart = () => {
    if (typeof item.onReveal === "function") item.onReveal();
    else if (item.bubbleEl) item.bubbleEl.classList.remove("bubble-blurred");
  };
  try {
    speechSynthesis.speak(item.utterance);
  } catch (_) {
    finish();
  }
}

function enqueueRevealOnly(bubbleEl, onReveal) {
  _ttsQueue.push({ utterance: null, side: null, bubbleEl, onReveal });
  pumpTtsQueue();
  refreshStepButton();
}

function flushTtsQueue() {
  for (const item of _ttsQueue) {
    if (item.bubbleEl) revealBubbleTurn(item.bubbleEl);
  }
  _ttsQueue.length = 0;
  _ttsActive = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  revealAllHeldTurns();
}

// Skip ahead to a specific bubble: cancel whatever is playing, drop any
// queued items that come before the target, then play target.
function skipToBubble(bubbleEl) {
  // Find the target in queue (or it might be currently active).
  if (_ttsActive && _ttsActive.bubbleEl === bubbleEl) return; // already playing
  const idx = _ttsQueue.findIndex((it) => it.bubbleEl === bubbleEl);
  if (idx < 0) return;
  // Drop everything before the target — they get skipped (un-blurred so
  // the user can read them).
  const skipped = _ttsQueue.splice(0, idx);
  for (const it of skipped) {
    if (it.bubbleEl) revealBubbleTurn(it.bubbleEl);
  }
  // Cancel current playback so the new top of queue starts immediately.
  _ttsActive = null;
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  pumpTtsQueue();
}

function speakIfEnabled(side, text, bubbleEl, onReveal) {
  if (typeof speechSynthesis === "undefined") return false;
  const enabled = document.getElementById(`${side}-tts`)?.checked;
  if (!enabled || !text) return false;
  // Strip markdown for cleaner speech.
  const clean = text.replace(/[*_`#>~]/g, "").replace(/\[(.+?)\]\(.+?\)/g, "$1");
  const u = new SpeechSynthesisUtterance(clean);
  const voiceName = document.getElementById(`${side}-tts-voice`)?.value;
  if (voiceName) {
    const match = _voicesCache.find((v) => v.name === voiceName);
    if (match) u.voice = match;
  }
  const speedEl = document.getElementById(`${side}-tts-speed`);
  u.rate  = speedEl ? parseFloat(speedEl.value) || 1.0 : 1.0;
  u.pitch = side === "a" ? 1.0 : 0.95;
  // Blur the bubble until its TTS actually starts playing.
  if (bubbleEl) {
    // Don't blur if it'll be the very next thing played and nothing is
    // currently active — un-blurs immediately on speak start anyway, but
    // this avoids a flash for the first turn.
    if (_ttsActive || _ttsQueue.length > 0) {
      bubbleEl.classList.add("bubble-blurred");
      bubbleEl.title = "Generated, queued for audio. Click to skip ahead.";
      bubbleEl.onclick = () => skipToBubble(bubbleEl);
    }
  }
  _ttsQueue.push({ utterance: u, side, bubbleEl, onReveal });
  pumpTtsQueue();
  refreshStepButton();
  return true;
}

async function triggerStep() {
  if (!activeSessionId || !_stepPending) return;
  _stepPending = false;
  refreshStepButton();
  try {
    await fetch(`/api/ensemble/step/${activeSessionId}`, { method: "POST" });
  } catch (_) {
    // Re-arm on failure so user can retry.
    _stepPending = true;
    refreshStepButton();
  }
}

// Step button: visible only when manual step mode has paused at a gate
// AND TTS is idle so the user finishes hearing the current turn first.
function refreshStepButton() {
  const btn = document.getElementById("btn-step");
  if (!btn) return;
  if (!_stepPending) {
    btn.hidden = true;
    return;
  }
  if (ttsIsBusy()) {
    btn.hidden = true;
    setStatus("paused — listening to current turn before continuing…");
  } else {
    btn.hidden = false;
    setStatus("paused — click Next to continue");
  }
}

async function fetchModels() {
  const conn = getStudioConnection();
  if (!conn || !conn.baseUrl) {
    setStatus("no studio connection");
    return;
  }
  const base = conn.baseUrl.replace(/\/+$/, "");
  let names = [];
  for (const path of ["/api/tags", "/v1/models"]) {
    try {
      const resp = await fetch(base + path);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (Array.isArray(data.models)) names = data.models.map((m) => m.name || m.model).filter(Boolean);
      else if (Array.isArray(data.data)) names = data.data.map((m) => m.id).filter(Boolean);
      if (names.length) break;
    } catch (_) {}
  }
  const dl = document.getElementById("ensemble-models-list");
  if (dl) {
    dl.innerHTML = names.map((n) => `<option value="${n}"></option>`).join("");
    setStatus(names.length ? `${names.length} models loaded` : "no models found");
  }
}

async function viewStore(side) {
  let registry;
  try { registry = parseRegistry(side); }
  catch (e) { setStatus(e.message); return; }
  const name = document.getElementById(`${side}-name`).value.trim() || side.toUpperCase();
  openMemView(`${name} memory`, "loading…", "");
  try {
    const resp = await fetch("/api/ensemble/view_store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry, participant_name: name, limit: 100 }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    renderMemView(name, data);
  } catch (e) {
    closeMemView();
    setStatus(`view memory failed: ${e.message}`);
  }
}

async function viewPrompt(side) {
  let registry;
  try { registry = parseRegistry(side); }
  catch (e) { setStatus(e.message); return; }
  const name = document.getElementById(`${side}-name`).value.trim() || side.toUpperCase();
  openMemView(`${name} — prompt structure`, "building…", "");
  try {
    // Build a state where every template var is its own {placeholder} literal.
    const reg = registry.registry || registry;
    // Start from the loaded participant state (preserves selections, injections,
    // persona etc.), fall back to default_state, then placeholder all template vars.
    const base = participantState[side] || reg.default_state || {};
    const state = JSON.parse(JSON.stringify(base));
    for (const [secKey, sec] of Object.entries(reg)) {
      if (!sec || typeof sec !== "object" || !Array.isArray(sec.items)) continue;
      const vars = new Set();
      for (const item of sec.items) {
        for (const v of (item.template_vars || [])) vars.add(v);
        for (const v of (sec.template_vars || [])) vars.add(v);
      }
      if (!vars.size) continue;
      if (!state[secKey]) state[secKey] = {};
      if (!state[secKey].template_vars) state[secKey].template_vars = {};
      for (const v of vars) {
        state[secKey].template_vars[v] = `{${v}}`;
      }
    }
    const resp = await fetch("/api/registry/hydrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry, state }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const m = document.getElementById("memview-meta");
    const b = document.getElementById("memview-body");
    if (m) m.textContent = "";
    if (b) b.innerHTML = `<pre class="memview-prompt-pre">${escHtml(data.prompt || "")}</pre>`;
  } catch (e) {
    closeMemView();
    setStatus(`view prompt failed: ${e.message}`);
  }
}

function openMemView(title, metaText, _bodyHtml) {
  const ov = document.getElementById("memview-overlay");
  const t = document.getElementById("memview-title");
  const m = document.getElementById("memview-meta");
  const b = document.getElementById("memview-body");
  if (t) t.textContent = title;
  if (m) m.textContent = metaText || "";
  if (b) b.innerHTML = `<div class="memview-empty">Loading…</div>`;
  if (ov) ov.hidden = false;
}

function closeMemView() {
  const ov = document.getElementById("memview-overlay");
  if (ov) ov.hidden = true;
}

function renderMemView(name, data) {
  const m = document.getElementById("memview-meta");
  const b = document.getElementById("memview-body");
  if (!b) return;

  const totalTurns = data.turn_count || 0;
  const personality = data.personality || null;
  const notes = data.working_notes || null;
  const sysum = data.system_summary || null;

  if (m) m.textContent = `${totalTurns} turns stored`;

  const sections = [];

  // Personality
  if (personality) {
    const seed = personality.seed || "";
    const amends = personality.amendments || [];
    const assembled = personality.assembled || "";
    sections.push(`
      <details class="memview-section" ${seed || amends.length ? "open" : ""}>
        <summary>Personality <span class="memview-section-meta">${amends.length} amendment${amends.length !== 1 ? "s" : ""}</span></summary>
        <div class="memview-section-body">
          ${seed ? `<div class="memview-section-meta" style="margin-bottom:4px">SEED</div><pre>${escHtml(seed)}</pre>` : `<div class="memview-empty">No seed.</div>`}
          ${amends.length
            ? `<div class="memview-section-meta" style="margin:8px 0 4px">AMENDMENTS</div>` +
              amends.map((a) => `<pre style="margin-bottom:4px">${escHtml(a.text || "")}</pre>`).join("")
            : ""}
          ${assembled
            ? `<div class="memview-section-meta" style="margin:8px 0 4px">ASSEMBLED</div><pre>${escHtml(assembled)}</pre>`
            : ""}
        </div>
      </details>`);
  } else {
    sections.push(`
      <details class="memview-section">
        <summary>Personality <span class="memview-section-meta">file not present</span></summary>
        <div class="memview-section-body"><div class="memview-empty">No personality file written yet.</div></div>
      </details>`);
  }

  // Working notes
  if (notes) {
    const updates = notes.update_count || 0;
    const last = notes.last_updated || "";
    sections.push(`
      <details class="memview-section" ${notes.text ? "open" : ""}>
        <summary>Working notes <span class="memview-section-meta">${updates} update${updates !== 1 ? "s" : ""}${last ? " · " + escHtml(last.slice(0, 19).replace("T", " ")) : ""}</span></summary>
        <div class="memview-section-body">
          ${notes.text ? `<pre>${escHtml(notes.text)}</pre>` : `<div class="memview-empty">No notes yet.</div>`}
        </div>
      </details>`);
  }

  // System summary
  if (sysum) {
    const updates = sysum.update_count || 0;
    const ratio = sysum.source_chars > 0 && sysum.text
      ? `${Math.round((sysum.text.length / sysum.source_chars) * 100)}% of full`
      : "";
    sections.push(`
      <details class="memview-section" ${sysum.text ? "open" : ""}>
        <summary>System prompt summary <span class="memview-section-meta">${updates} update${updates !== 1 ? "s" : ""}${ratio ? " · " + ratio : ""}</span></summary>
        <div class="memview-section-body">
          ${sysum.text ? `<pre>${escHtml(sysum.text)}</pre>` : `<div class="memview-empty">No summary yet.</div>`}
        </div>
      </details>`);
  }

  // Recent turns
  const turns = data.turns || [];
  sections.push(`
    <details class="memview-section" ${turns.length ? "open" : ""}>
      <summary>Recorded turns <span class="memview-section-meta">${totalTurns} total · showing ${turns.length}</span></summary>
      <div class="memview-section-body">
        ${turns.length
          ? turns.map((t) => `
              <div class="memview-turn ${escHtml(t.role)}">
                <div class="memview-turn-meta">
                  <span>${escHtml(t.role)}</span>
                  <span>${escHtml((t.timestamp || "").slice(0, 19).replace("T", " "))}</span>
                  ${t.tags?.length ? `<span>tags: ${escHtml(t.tags.join(", "))}</span>` : ""}
                  <span style="opacity:0.6">${escHtml((t.session_id || "").slice(0, 8))}</span>
                </div>
                <div class="memview-turn-text">${escHtml(t.text || "")}</div>
              </div>`).join("")
          : `<div class="memview-empty">No turns recorded yet.</div>`}
      </div>
    </details>`);

  // Paths footer
  const paths = data.paths || {};
  sections.push(`
    <div class="memview-paths">
      <div>store: ${escHtml(paths.store || "—")}</div>
      <div>personality: ${escHtml(paths.personality || "—")}</div>
      <div>notes: ${escHtml(paths.notes || "—")}</div>
      <div>sysum: ${escHtml(paths.sysum || "—")}</div>
    </div>`);

  b.innerHTML = sections.join("");
}

async function resetStore(side) {
  let registry;
  try {
    registry = parseRegistry(side);
  } catch (e) {
    setStatus(e.message);
    return;
  }
  const name = document.getElementById(`${side}-name`).value.trim() || side.toUpperCase();
  if (!confirm(`Wipe ${name}'s entire memory? Clears the turn store, personality file, working notes, and system-prompt summary. Cannot be undone.`)) return;
  try {
    const resp = await fetch("/api/ensemble/reset_store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registry, participant_name: name }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const wiped = (data.wiped_files || []).join(", ") || "none";
    setStatus(`${name}: cleared ${data.cleared_turns} turns · wiped ${wiped}`);
  } catch (e) {
    setStatus(`reset failed: ${e.message}`);
  }
}

function stopEnsemble() {
  if (activeReader) {
    activeReader.cancel();
    activeReader = null;
  }
  if (activeEmbedWs) {
    activeEmbedWs.close();
    activeEmbedWs = null;
  }
  flushTtsQueue();
  _stepPending = false;
  refreshStepButton();
  setRunning(false);
  setStatus("stopped");
}

// ── event handling ────────────────────────────────────────────────

let currentBubble = null;
let turnCount = 0;
const _sidesSpoken = new Set();

function handleEvent(event, nameA, nameB) {
  if (event.type === "memory_status") {
    const bits = [];
    if (event.a) bits.push(`${nameA}: memory`);
    if (event.b) bits.push(`${nameB}: memory`);
    if (bits.length) setStatus(`running… (${bits.join(", ")})`);
    return;
  }
  if (event.type === "prepare_trace") {
    const side = event.speaker === nameA ? "a" : "b";
    const gate = getTurnGate(event.turn);
    gate.traceEvent = { ...event, side };
    if (ttsIsBusy()) gate.hold = true;
    if (!gate.hold || gate.released) renderHeldTraceIfReady(gate);
    return;
  }
  if (event.type === "turn_start") {
    // Resuming from a step gate / starting next turn — clear the step state.
    _stepPending = false;
    refreshStepButton();
    const side = event.speaker === nameA ? "a" : "b";
    const gate = getTurnGate(event.turn);
    if (ttsIsBusy()) gate.hold = true;
    currentBubble = createTurnBubble(side, event.speaker, event.turn + 1, event.turn);
    gate.bubbleRef = currentBubble;
    if (gate.hold && !gate.released) holdBubble(currentBubble.bubble);
    else renderHeldTraceIfReady(gate);
    if (!shouldHoldScrollForGate(gate)) scrollToBottom();
  } else if (event.type === "chunk") {
    if (currentBubble) appendChunk(currentBubble, event.text);
    const activeTurn = Number(currentBubble?.bubble?.dataset?.turnIdx);
    const gate = Number.isFinite(activeTurn) ? getTurnGate(activeTurn) : null;
    if (!shouldHoldScrollForGate(gate)) scrollToBottom();
  } else if (event.type === "turn_end") {
    const bubbleRef = currentBubble;
    if (bubbleRef) {
      finalizeBubble(bubbleRef);
      // Show metadata (chars / words / token estimate) in the label.
      if (event.text) annotateBubble(bubbleRef, event.text);
    }
    currentBubble = null;
    turnCount++;
    setStatus(`turn ${turnCount} / ${document.getElementById("turns").value}`);
    // Speak the just-finalized turn if TTS is on for that participant.
    const speakerSide = event.speaker === nameA ? "a" : "b";
    _sidesSpoken.add(speakerSide);
    const gate = getTurnGate(event.turn);
    const reveal = () => revealTurnGate(event.turn);
    if (event.text && bubbleRef) {
      const queued = speakIfEnabled(speakerSide, event.text, bubbleRef.bubble, reveal);
      if (!queued) {
        if (gate.hold && !gate.released) enqueueRevealOnly(bubbleRef.bubble, reveal);
        else reveal();
      }
    } else if (gate.hold && !gate.released) {
      enqueueRevealOnly(bubbleRef?.bubble, reveal);
    } else {
      reveal();
    }
  } else if (event.type === "awaiting_step") {
    activeSessionId = event.session_id;
    _stepPending = true;
    refreshStepButton();
  } else if (event.type === "awaiting_human") {
    const side = event.speaker === nameA ? "a" : "b";
    showHumanPrompt(side, event.speaker, event.turn + 1, event.last_input, event.session_id);
    setStatus(`waiting on ${event.speaker}…`);
  } else if (event.type === "done") {
    showDone();
    setStatus(`done — ${turnCount} turns`);
    setRunning(false);
  } else if (event.type === "error") {
    showError(event.message);
    setStatus("error");
    setRunning(false);
  }
}

function showHumanPrompt(side, name, num, lastInput, sessionId) {
  const conv = document.getElementById("conversation");
  const turn = document.createElement("div");
  turn.className = `turn speaker-${side} human-pending`;

  const label = document.createElement("div");
  label.className = "turn-label";
  label.textContent = `${name}  ·  turn ${num}  ·  your move`;

  const bubble = document.createElement("div");
  bubble.className = "turn-bubble human-input-bubble";

  const ta = document.createElement("textarea");
  ta.className = "human-input";
  ta.rows = 3;
  ta.placeholder = `Reply as ${name} — Enter to send, Shift+Enter for newline`;

  const actions = document.createElement("div");
  actions.className = "human-input-actions";
  const hint = document.createElement("span");
  hint.className = "human-input-hint";
  hint.textContent = "Enter to send · Shift+Enter for newline";
  actions.appendChild(hint);
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "btn-run";
  submit.textContent = "Send";
  actions.appendChild(submit);

  bubble.appendChild(ta);
  bubble.appendChild(actions);
  turn.appendChild(label);
  turn.appendChild(bubble);
  conv.appendChild(turn);
  scrollToBottom();
  ta.focus();

  const send = async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    submit.disabled = true;
    ta.disabled = true;
    try {
      const resp = await fetch(`/api/ensemble/submit/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      // Replace input UI with the finalized turn bubble — the server will
      // emit chunk + turn_end events that render the same text again, so
      // strip our placeholder first.
      turn.remove();
    } catch (e) {
      submit.disabled = false;
      ta.disabled = false;
      showError(`submit failed: ${e.message}`);
    }
  };

  submit.addEventListener("click", send);
  ta.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline (default behavior).
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
}

// ── conversation DOM ──────────────────────────────────────────────

function clearConversation() {
  const el = document.getElementById("conversation");
  el.innerHTML = "";
  currentBubble = null;
  turnCount = 0;
  _turnGates.clear();
  _sidesSpoken.clear();
  for (const side of ["a", "b"]) {
    const meBody = document.querySelector(`#side-${side}-self .thoughts-pane-body`);
    const otBody = document.querySelector(`#side-${side}-other .thoughts-pane-body`);
    const trace = document.getElementById(`side-${side}-trace`);
    if (meBody) meBody.innerHTML = `<div class="side-panel-empty">no notes yet</div>`;
    if (otBody) otBody.innerHTML = `<div class="side-panel-empty">no notes yet</div>`;
    if (trace) trace.innerHTML = `<div class="side-panel-empty">no turns yet</div>`;
  }
}

function showSeed(text) {
  const el = document.getElementById("conversation");
  const div = document.createElement("div");
  div.className = "seed-display";
  div.innerHTML = `<div class="seed-label">seed</div>${escHtml(text)}`;
  el.appendChild(div);
}

function createTurnBubble(side, name, num, turnIdx = null) {
  const conv = document.getElementById("conversation");
  const turn = document.createElement("div");
  turn.className = `turn speaker-${side}`;

  const label = document.createElement("div");
  label.className = "turn-label";
  label.innerHTML = `<span class="turn-label-name">${escHtml(name)}</span><span class="turn-label-sep">·</span><span class="turn-label-num">turn ${num}</span><span class="turn-label-stats" data-stats></span>`;

  const bubble = document.createElement("div");
  bubble.className = "turn-bubble";
  if (turnIdx != null) bubble.dataset.turnIdx = String(turnIdx);

  const cursor = document.createElement("span");
  cursor.className = "turn-cursor";
  bubble.appendChild(cursor);

  turn.appendChild(label);
  turn.appendChild(bubble);
  conv.appendChild(turn);

  return { bubble, cursor, turn };
}

// Parse working-notes text into about-me / about-other halves. The notes
// prompt enforces "ABOUT ME:" / "ABOUT <NAME>:" headings; this is best-effort
// when the model deviates.
function parseThoughts(text) {
  if (!text || !text.trim()) return { me: "", other: "" };
  const src = text.trim();

  const headerRe = /(^|\n)\s*ABOUT\s+(.+?)\s*:\s*/gi;
  const matches = [];
  let m;
  while ((m = headerRe.exec(src)) !== null) {
    const headerName = m[2].trim().toUpperCase().replace(/\s+/g, " ");
    const kind = (
      headerName === "ME" ||
      headerName === "MYSELF" ||
      headerName === "SELF"
    ) ? "me" : "other";
    matches.push({
      kind,
      headerEnd: m.index + m[0].length,
      headerStart: m.index + (m[1] ? m[1].length : 0),
    });
  }

  if (matches.length === 0) {
    // No headings — dump everything into "me" so something is visible.
    return { me: src, other: "" };
  }

  const result = { me: "", other: "" };
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].headerEnd;
    const end = (i + 1 < matches.length) ? matches[i + 1].headerStart : src.length;
    const block = src.slice(start, end).trim();
    if (block) {
      // If the same kind appears twice, append (don't lose content).
      result[matches[i].kind] = result[matches[i].kind]
        ? result[matches[i].kind] + "\n\n" + block
        : block;
    }
  }
  return result;
}

function renderSidePanel(side, speakerName, trace) {
  const nameEl = document.getElementById(`side-${side}-name`);
  const modelEl = document.getElementById(`side-${side}-model`);
  const selfEl = document.getElementById(`side-${side}-self`);
  const otherEl = document.getElementById(`side-${side}-other`);
  const traceEl = document.getElementById(`side-${side}-trace`);

  if (nameEl) nameEl.textContent = speakerName;
  if (modelEl && trace.classifier?.model) modelEl.textContent = trace.classifier.model;
  else if (modelEl) {
    const m = document.getElementById(`${side}-model`)?.value;
    if (m) modelEl.textContent = m;
  }

  // Update the "About other" pane label to use the actual name.
  const otherName = trace.other_name || "other";
  const otherLabel = otherEl?.querySelector(".thoughts-pane-label");
  if (otherLabel) otherLabel.textContent = `About ${otherName}`;

  // ── Tab 1: Thoughts (about me / about other) ─────────────
  const thoughts = parseThoughts(trace.working_notes?.text || "");
  const updateCount = trace.working_notes?.update_count || 0;
  const meBody = selfEl?.querySelector(".thoughts-pane-body");
  const otherBody = otherEl?.querySelector(".thoughts-pane-body");

  if (meBody) {
    if (thoughts.me) {
      meBody.innerHTML = renderMd(thoughts.me);
    } else {
      meBody.innerHTML = `<div class="side-panel-empty">${updateCount === 0 ? "no notes yet — appear after a few turns" : "(no self-notes in latest update)"}</div>`;
    }
  }
  if (otherBody) {
    const otherSide = side === "a" ? "b" : "a";
    const otherHasSpoken = _sidesSpoken.has(otherSide);
    if (thoughts.other && otherHasSpoken) {
      otherBody.innerHTML = renderMd(thoughts.other);
    } else {
      const msg = !otherHasSpoken
        ? `waiting for ${escHtml(otherName)} to speak…`
        : updateCount === 0 ? "no notes yet" : `(no notes about ${escHtml(otherName)} in latest update)`;
      otherBody.innerHTML = `<div class="side-panel-empty">${msg}</div>`;
    }
  }

  // ── Tab 2: Trace (classifier, chunks, system prompts) ────
  if (traceEl) {
    traceEl.innerHTML = "";

    // Generation params actually sent for this turn — confirms overrides
    // are being applied.
    if (trace.generation) {
      const g = trace.generation;
      const rows = [
        ["model",          g.model],
        ["temperature",    g.temperature],
        ["top_p",          g.top_p],
        ["top_k",          g.top_k],
        ["max_tokens",     g.max_tokens],
        ["repeat_penalty", g.repeat_penalty],
      ].filter(([, v]) => v !== null && v !== undefined && v !== "");
      const sec = document.createElement("details");
      sec.className = "side-section";
      sec.open = true;
      sec.innerHTML = `
        <summary>Generation params <span class="side-section-meta">${escHtml(String(g.model || "—"))}</span></summary>
        <div class="side-section-body">
          ${rows.map(([k, v]) => `<div class="trace-line"><span class="muted">${escHtml(k)}</span> <strong>${escHtml(String(v))}</strong></div>`).join("")}
        </div>`;
      traceEl.appendChild(sec);
    }

    // Classifier + tags
    const clfMeta = trace.classifier ? `${Math.round(trace.classifier.ms || 0)}ms` : "";
    const clfSec = document.createElement("details");
    clfSec.className = "side-section";
    clfSec.open = true;
    clfSec.innerHTML = `
      <summary>Classifier <span class="side-section-meta">${escHtml(clfMeta)}</span></summary>
      <div class="side-section-body">
        ${trace.tags?.length
          ? trace.tags.map((t) => `<span class="chip">${escHtml(t)}</span>`).join("")
          : `<span class="muted">no tags fired</span>`}
        ${trace.applied_rules?.length
          ? `<div style="margin-top:6px">` +
            trace.applied_rules.map((r) => `<div class="chip">${escHtml(r)}</div>`).join("") +
            `</div>`
          : ""}
      </div>`;
    traceEl.appendChild(clfSec);

    // Retrieved chunks
    if (trace.chunks?.length) {
      const sec = document.createElement("details");
      sec.className = "side-section";
      sec.innerHTML = `
        <summary>Retrieved chunks <span class="side-section-meta">${trace.chunks.length}</span></summary>
        <div class="side-section-body">
          ${trace.chunks.map((c) => `
            <div class="side-chunk">
              <div class="side-chunk-meta">[${escHtml(c.role)}] score ${c.score}</div>
              <div>${escHtml(c.text)}</div>
            </div>`).join("")}
        </div>`;
      traceEl.appendChild(sec);
    }

    // System-prompt summary
    if (trace.system_summary && trace.system_summary.text?.trim()) {
      const ss = trace.system_summary;
      const ratio = ss.source_chars > 0
        ? `${Math.round((ss.text.length / ss.source_chars) * 100)}% of full`
        : "";
      const sec = document.createElement("details");
      sec.className = "side-section";
      sec.innerHTML = `
        <summary>System prompt summary <span class="side-section-meta">${ss.update_count || 0} updates · ${ratio}</span></summary>
        <div class="side-section-body"><pre>${escHtml(ss.text)}</pre></div>`;
      traceEl.appendChild(sec);
    } else if (trace.system_summary) {
      const sec = document.createElement("details");
      sec.className = "side-section";
      sec.innerHTML = `
        <summary>System prompt summary <span class="side-section-meta">empty</span></summary>
        <div class="side-section-body muted">No summary yet — appears after the first compression cycle.</div>`;
      traceEl.appendChild(sec);
    }

    // Full system prompt — decorated with template-var + random highlights
    // and a footer summarizing skipped fragments and active randomness.
    if (trace.system_prompt) {
      const decorated = decorateSystemPrompt(trace.system_prompt, side, trace);
      const sec = document.createElement("details");
      sec.className = "side-section";
      sec.innerHTML = `
        <summary>System prompt sent <span class="side-section-meta">${trace.system_prompt.length} chars</span></summary>
        <div class="side-section-body">
          <pre class="stage-prompt-pre">${decorated.html}</pre>
          ${decorated.note}
        </div>`;
      traceEl.appendChild(sec);
    }
  }
}

function appendChunk({ bubble, cursor }, text) {
  const node = document.createTextNode(text);
  bubble.insertBefore(node, cursor);
}

function finalizeBubble({ bubble, cursor }) {
  cursor.remove();
}

// Approx token count: ≈ 4 chars per token for English / Latin scripts.
// Good enough for a status indicator without pulling in a tokenizer.
function approxTokens(text) {
  return Math.max(1, Math.round(text.length / 4));
}

function annotateBubble(bubbleRef, text) {
  const turn = bubbleRef.turn;
  if (!turn) return;
  const stats = turn.querySelector("[data-stats]");
  if (!stats) return;
  const chars = text.length;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const toks  = approxTokens(text);
  stats.innerHTML = `<span class="stat">${chars} ch</span><span class="stat">${words} w</span><span class="stat">~${toks} tok</span>`;
}

function showDone() {
  const conv = document.getElementById("conversation");
  const div = document.createElement("div");
  div.className = "done-marker";
  div.textContent = "— conversation complete —";
  conv.appendChild(div);
  scrollToBottom();
}

function showError(msg) {
  const conv = document.getElementById("conversation");
  const div = document.createElement("div");
  div.className = "error-marker";
  div.textContent = `error: ${msg}`;
  conv.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const conv = document.getElementById("conversation");
  conv.scrollTop = conv.scrollHeight;
}

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Pre-gen-style highlighting for system-prompt panes ────────────
// Mirrors studio's decoratePromptOutput: orange spans for template-var
// injections (including dynamic ones like {user_input}, {other_name}),
// blue dashed underlines for content from random-rotated sections, and
// a footer summary listing skipped fragments + active randomness.
function _ensDecorateText(text, markers) {
  if (!markers.length) return escHtml(text);
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
      out += `<span class="${cls}" title="${escHtml(best.key)}">${escHtml(best.value)}</span>`;
      i += best.value.length;
    } else {
      const ch = text[i];
      out += (ch === "&" || ch === "<" || ch === ">" || ch === '"' || ch === "'")
        ? escHtml(ch)
        : ch;
      i++;
    }
  }
  return out;
}

function _ensCollectRandomMarkers(reg, sectionRandom, arrayModes) {
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
      if (wholeRandom) {
        for (const field of ["text", "context", "scale_emotion"]) {
          const v = item[field];
          if (typeof v === "string" && v.trim().length >= 4) {
            out.push({ key: `${secKey}::${field} (random item)`, value: v, kind: "random" });
          }
        }
      }
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

function _ensDescribeFragments(reg, tvarMap) {
  const out = [];
  if (!reg) return out;
  for (const [secKey, sec] of Object.entries(reg)) {
    if (!sec || typeof sec !== "object" || !Array.isArray(sec.items)) continue;
    for (const item of sec.items) {
      if (!Array.isArray(item.fragments) || !item.fragments.length) continue;
      const frags = item.fragments.map((f) => {
        const v = f.if_var || f.var || "";
        const val = v ? String(tvarMap[`${secKey}::${v}`] || "").trim() : "";
        return { var: v, fired: !v || !!val };
      });
      out.push({ section: secKey, item: item.name || item.id || "(unnamed)", fragments: frags });
    }
  }
  return out;
}

function decorateSystemPrompt(text, side, trace) {
  let registry;
  try {
    const raw = document.getElementById(`${side}-registry`)?.value?.trim();
    registry = raw ? JSON.parse(raw) : null;
  } catch (_) { registry = null; }
  const reg = registry?.registry || registry || {};
  const state = participantState[side] || {};
  const tvarMap = { ...(state.template_vars || {}) };

  // Dynamic injections that ensemble adds at run-time, sourced from the
  // prepare_trace payload. resolved_tvars carries the actual substituted
  // values keyed as "section::var" so the decorator can highlight them.
  const resolved = trace?.resolved_tvars || {};
  for (const [fullKey, val] of Object.entries(resolved)) {
    if (val && String(val).trim()) tvarMap[fullKey] = String(val);
  }
  // Fallbacks for user_input / other_name when not in resolved_tvars.
  for (const [secKey, sec] of Object.entries(reg)) {
    if (!sec || typeof sec !== "object" || !Array.isArray(sec.template_vars)) continue;
    for (const v of sec.template_vars) {
      const fullKey = `${secKey}::${v}`;
      if (fullKey in tvarMap) continue;
      if (v === "user_input" && trace?.user_input)   tvarMap[fullKey] = trace.user_input;
      if (v === "other_name" && trace?.other_name)   tvarMap[fullKey] = trace.other_name;
    }
  }
  // Highlight system_summary text directly if present.
  const ssText = trace?.system_summary?.text?.trim();
  if (ssText) tvarMap["__system_summary__"] = ssText;

  const tvars = Object.entries(tvarMap)
    .map(([k, v]) => ({ key: k, value: String(v == null ? "" : v), kind: "tvar" }))
    .filter((e) => e.value.trim().length >= 2);
  const randoms = _ensCollectRandomMarkers(reg, state.section_random, state.array_modes);
  const html = _ensDecorateText(text, [...tvars, ...randoms]);

  const fragInfo = _ensDescribeFragments(reg, tvarMap);
  const noteLines = [];
  for (const e of fragInfo) {
    const fired = e.fragments.filter((f) => f.fired);
    const skipped = e.fragments.filter((f) => !f.fired);
    if (skipped.length) {
      noteLines.push(
        `<div class="pregen-note-line">` +
        `<span class="muted">${escHtml(e.section)}.${escHtml(e.item)}:</span> ` +
        `${fired.length} fired, ${skipped.length} skipped (vars empty: ${skipped.map((f) => `<code>${escHtml(f.var)}</code>`).join(", ")})` +
        `</div>`
      );
    }
  }
  const sliderRandom = state.slider_random || {};
  const rs = Object.entries(sliderRandom).filter(([, v]) => v).map(([k]) => k);
  if (rs.length) noteLines.push(`<div class="pregen-note-line"><span class="muted">random sliders:</span> ${rs.map(escHtml).join(", ")}</div>`);
  const sr = Object.entries(state.section_random || {}).filter(([, v]) => v).map(([k]) => k);
  if (sr.length) noteLines.push(`<div class="pregen-note-line"><span class="muted">random section items:</span> ${sr.map(escHtml).join(", ")}</div>`);
  const ra = [];
  for (const [k, modes] of Object.entries(state.array_modes || {})) {
    for (const [field, mode] of Object.entries(modes || {})) {
      if (typeof mode === "string" && mode.startsWith("random:")) ra.push(`${k}.${field} (${mode})`);
    }
  }
  if (ra.length) noteLines.push(`<div class="pregen-note-line"><span class="muted">random array picks:</span> ${ra.map(escHtml).join(", ")}</div>`);

  const note = noteLines.length ? `<div class="pregen-note">${noteLines.join("")}</div>` : "";
  return { html, note };
}

// ── Lightweight markdown renderer for thought panes ──────────────
// Handles headings (#–######), bold (**), italic (* or _), inline code (`),
// bullet lists (- or *), numbered lists, and paragraphs.
function renderMd(src) {
  if (!src || !src.trim()) return "";
  const text = String(src).replace(/\r\n/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const out = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split("\n");
    // Heading (single line starting with #)
    const h = lines.length === 1 && lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderMdInline(h[2])}</h${level}>`);
      continue;
    }
    // Bullet list
    if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
      out.push("<ul>" + lines.map((l) =>
        `<li>${renderMdInline(l.trim().replace(/^[-*]\s+/, ""))}</li>`
      ).join("") + "</ul>");
      continue;
    }
    // Numbered list
    if (lines.every((l) => /^\d+[.)]\s+/.test(l.trim()))) {
      out.push("<ol>" + lines.map((l) =>
        `<li>${renderMdInline(l.trim().replace(/^\d+[.)]\s+/, ""))}</li>`
      ).join("") + "</ol>");
      continue;
    }
    // Paragraph (line breaks become <br>)
    out.push(`<p>${lines.map((l) => renderMdInline(l)).join("<br>")}</p>`);
  }
  return out.join("");
}

function renderMdInline(s) {
  let out = escHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  return out;
}

// ── init ──────────────────────────────────────────────────────────

function updateSeedVisibility() {
  const humanA = document.getElementById("a-human")?.checked || false;
  const humanB = document.getElementById("b-human")?.checked || false;
  const seedEl = document.getElementById("seed");
  if (seedEl) seedEl.hidden = !(hasRun && (humanA || humanB));
}

function syncHumanUI() {
  const humanA = document.getElementById("a-human")?.checked || false;
  const humanB = document.getElementById("b-human")?.checked || false;
  const turnsEl = document.getElementById("turns");
  const aReg = document.getElementById("a-registry");
  const bReg = document.getElementById("b-registry");
  if (turnsEl) {
    if (humanA || humanB) {
      if (turnsEl.value && turnsEl.value !== "∞") turnsEl.dataset.prevTurns = turnsEl.value;
      turnsEl.value = "∞";
      turnsEl.title = "Human-driven runs are open-ended — use Stop";
    } else if (turnsEl.value === "∞") {
      turnsEl.value = turnsEl.dataset.prevTurns || "8";
      turnsEl.title = "";
    }
  }
  if (aReg) aReg.placeholder = humanA ? "(not needed — human-driven)" : '{"registry": { ... }}';
  if (bReg) bReg.placeholder = humanB ? "(not needed — human-driven)" : '{"registry": { ... }}';

  // Hide all model-related fields on the participant's card when human-driven.
  document.getElementById("card-a")?.classList.toggle("is-human", humanA);
  document.getElementById("card-b")?.classList.toggle("is-human", humanB);
  updateSeedVisibility();
}

// ── Per-participant settings persistence ─────────────────────────
const PARTICIPANT_SETTINGS_KEY = "pl-ensemble-participant-settings.v1";

const PERSISTED_FIELDS = {
  text:   ["name", "model", "notes_about_me_prompt", "notes_about_other_prompt", "tts-voice", "embed_url", "embed_path"],
  number: ["history_window", "top_k", "working_notes_every_n_turns", "working_notes_max_tokens",
           "system_summary_every_n_turns", "system_summary_max_tokens",
           "gen-temperature", "gen-top_p", "gen-top_k", "gen-max_tokens", "gen-repeat_penalty", "gen-retries",
           "tts-speed"],
  bool:   ["human", "memory", "working_notes_enabled", "system_summary_enabled", "tts"],
};

function saveParticipantSettings() {
  const payload = { a: {}, b: {} };
  for (const side of ["a", "b"]) {
    for (const k of [...PERSISTED_FIELDS.text, ...PERSISTED_FIELDS.number]) {
      const el = document.getElementById(`${side}-${k}`);
      if (el && el.value != null) payload[side][k] = el.value;
    }
    for (const k of PERSISTED_FIELDS.bool) {
      const el = document.getElementById(`${side}-${k}`);
      if (el) payload[side][k] = !!el.checked;
    }
  }
  try { localStorage.setItem(PARTICIPANT_SETTINGS_KEY, JSON.stringify(payload)); } catch (_) {}
}

function loadParticipantSettings() {
  let payload;
  try { payload = JSON.parse(localStorage.getItem(PARTICIPANT_SETTINGS_KEY) || "{}"); }
  catch (_) { return; }
  const NOTE_DEFAULTS = {
    notes_about_me_prompt:
      "How I'm feeling, my mood, my state, decisions I've made about how to handle this. " +
      "Use markdown — short bullets for distinct thoughts, **bold** for things I've decided, " +
      "*italic* for emotional texture.",
    notes_about_other_prompt:
      "My read on them — what they want, how they're behaving, my opinion of them. " +
      "Use markdown — short bullets for distinct observations, **bold** for things I'm sure of, " +
      "*italic* for hunches I'm not yet certain about.",
  };

  for (const side of ["a", "b"]) {
    const data = payload[side] || {};
    for (const k of [...PERSISTED_FIELDS.text, ...PERSISTED_FIELDS.number]) {
      const el = document.getElementById(`${side}-${k}`);
      if (el && data[k] != null && data[k] !== "") el.value = data[k];
    }
    for (const k of PERSISTED_FIELDS.bool) {
      const el = document.getElementById(`${side}-${k}`);
      if (el && data[k] != null) el.checked = !!data[k];
    }
    // Seed note-prompt fields with defaults if still empty after restore.
    for (const [k, def] of Object.entries(NOTE_DEFAULTS)) {
      const el = document.getElementById(`${side}-${k}`);
      if (el && !el.value.trim()) el.value = def;
    }
    // Sync speed display span after restore.
    const speedEl = document.getElementById(`${side}-tts-speed`);
    const speedValEl = document.getElementById(`${side}-tts-speed-val`);
    if (speedEl && speedValEl) speedValEl.textContent = parseFloat(speedEl.value).toFixed(1);
  }
}

function bindSettingsAutosave() {
  for (const side of ["a", "b"]) {
    for (const k of [...PERSISTED_FIELDS.text, ...PERSISTED_FIELDS.number, ...PERSISTED_FIELDS.bool]) {
      const el = document.getElementById(`${side}-${k}`);
      if (!el) continue;
      const evt = (el.type === "checkbox" || el.tagName === "SELECT") ? "change" : "input";
      el.addEventListener(evt, saveParticipantSettings);
    }
  }
}

window.addEventListener("load", () => {
  loadSnapshots();
  renderConnChip();
  fetchModels();
  loadVoices();
  if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  loadParticipantSettings();
  bindSettingsAutosave();
  document.getElementById("a-human")?.addEventListener("change", syncHumanUI);
  document.getElementById("b-human")?.addEventListener("change", syncHumanUI);
  updateSeedVisibility();

  for (const side of ["a", "b"]) {
    for (const id of [`${side}-name`, `${side}-model`, `${side}-human`, `${side}-memory`]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", () => refreshSummary(side));
      if (el && el.tagName === "INPUT" && el.type === "text") {
        el.addEventListener("input", () => refreshSummary(side));
      }
    }
    // Re-render tvars whenever the model is confirmed (datalist pick fires input, manual entry fires change).
    const modelEl = document.getElementById(`${side}-model`);
    if (modelEl) {
      const onModelInteract = () => rerenderTvars(side);
      modelEl.addEventListener("change", onModelInteract);
      modelEl.addEventListener("input", onModelInteract);
    }
    // Re-render tvars if the user directly edits the registry textarea JSON.
    const regEl = document.getElementById(`${side}-registry`);
    if (regEl) regEl.addEventListener("change", () => rerenderTvars(side));
    refreshSummary(side);
  }

  // Pressing Enter in the seed input runs the ensemble.
  const seedEl = document.getElementById("seed");
  if (seedEl) seedEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); startEnsemble(); }
  });

  // Side panel toggles in the header.
  const mainRow = document.querySelector(".main-row");
  document.getElementById("toggle-side-a")?.addEventListener("click", () => mainRow?.classList.toggle("hide-a"));
  document.getElementById("toggle-side-b")?.addEventListener("click", () => mainRow?.classList.toggle("hide-b"));

  // Side-panel tab switching.
  document.querySelectorAll(".side-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const side = btn.dataset.side;
      const tab = btn.dataset.tab;
      // Update buttons
      document.querySelectorAll(`.side-tab[data-side="${side}"]`).forEach((b) => {
        b.classList.toggle("active", b.dataset.tab === tab);
      });
      // Update panes
      const body = document.getElementById(`side-${side}-body`);
      if (body) {
        body.dataset.activeTab = tab;
        body.querySelectorAll(".side-tab-pane").forEach((p) => {
          p.hidden = p.dataset.tab !== tab;
        });
      }
    });
  });

  // Memory-view modal close: Esc + click on backdrop.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const ov = document.getElementById("memview-overlay");
      if (ov && !ov.hidden) closeMemView();
    }
  });
  const memviewOverlay = document.getElementById("memview-overlay");
  if (memviewOverlay) {
    memviewOverlay.addEventListener("click", (e) => {
      if (e.target === memviewOverlay) closeMemView();
    });
  }

  // pre-fill model fields from studio connection
  const conn = getStudioConnection();
  if (conn?.model) {
    document.getElementById("a-model").value = conn.model;
    document.getElementById("b-model").value = conn.model;
  }
});

window.addEventListener("focus", () => {
  loadSnapshots();
  renderConnChip();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadSnapshots();
    renderConnChip();
  }
});

window.addEventListener("storage", (e) => {
  if (e.key === SNAPSHOT_KEY || e.key === REGISTRY_KEY) loadSnapshots();
  if (e.key === CONN_KEY) renderConnChip();
});
