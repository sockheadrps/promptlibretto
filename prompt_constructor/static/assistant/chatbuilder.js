/* chatbuilder.js — Registry Assistant frontend */

'use strict';

const MEMORY_ENABLED = localStorage.getItem('promptlibretto.memory-enabled.v1') === 'true';

// ── state ──────────────────────────────────────────────────────────────────

let draftId       = null;
let conversationHistory = [];  // [{role, content}] sent to /api/builder/chat
let isStreaming   = false;
let lastExportJSON = '';
let builderSession = null;

// local mirror of the registry being built, for visualization only
const regState = {
  title:       '',
  description: '',
  sections:    {}, // section_key → { vars: [], items: [] }
  assembly:    [],
  generation:  {},
  output_policy: {},
  memory_config: {},
  style_blend:   {},
  memory_rules:  [],
};

// runtime state — selected items, array modes, sliders per section
// mirrors the "state" block in exported registry files
const draftState = {}; // section_key → { selected, array_modes, slider, template_vars }

let currentDetailSection = null; // section currently open in the detail panel

// Non-section keys at the registry top level (used to detect section keys by exclusion).
const META_KEYS = new Set([
  'version', 'title', 'description', 'assembly_order', 'default_state',
  'generation', 'output_policy', 'memory_config', 'memory_rules', 'style_blend',
]);

const SECTION_LABELS = {
  base_context:               'Base Context',
  personas:                   'Personas',
  sentiment:                  'Sentiment',
  static_injections:          'Static Inject',
  runtime_injections:         'Runtime Inject',
  output_prompt_directions:   'Output Dirs',
  memory_recall:              'Memory Recall',
  user_message:               'User Message',
  prompt_endings:             'Prompt Endings',
};

const ASSEMBLY_TOKEN_ALIASES = {
  base_context: 'base_context.text',
  personas: 'personas.text',
  sentiment: 'sentiment.text',
  static_injections: 'static_injections.text',
  runtime_injections: 'runtime_injections.text',
  output_prompt_directions: 'output_prompt_directions.text',
  memory_recall: 'memory_recall.text',
  prompt_endings: 'prompt_endings.endings',
};

const GENERATION_KEYS = new Set([
  'max_prompt_chars',
  'max_tokens',
  'model',
  'provider',
  'repeat_penalty',
  'retries',
  'temperature',
  'timeout_ms',
  'top_k',
  'top_p',
]);

// ── init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  buildSectionGrid();
  updateConnChip();
  document.getElementById('user-input').focus();
});

// Keep chip in sync if the user configures the connection in another tab.
window.addEventListener('storage', e => {
  if (e.key === CONN_KEY) updateConnChip();
});

function _makeSectionCard(key) {
  const card = document.createElement('div');
  card.className = 'cb-section-card';
  card.id = `sec-card-${key}`;
  card.innerHTML = `
    <div class="cb-section-name">${SECTION_LABELS[key] || key}</div>
    <div class="cb-section-items" id="sec-items-${key}">
      <span class="cb-sec-empty">Empty</span>
    </div>
    <div class="cb-section-vars" id="sec-vars-${key}"></div>
  `;
  card.onclick = () => openSectionDetail(key);
  return card;
}

function _ensureSectionCard(key) {
  if (!regState.sections[key]) regState.sections[key] = { vars: [], items: [] };
  if (!document.getElementById(`sec-card-${key}`)) {
    document.getElementById('sections-grid').appendChild(_makeSectionCard(key));
  }
}

function buildSectionGrid() {
  const grid = document.getElementById('sections-grid');
  grid.innerHTML = '';
  for (const key of Object.keys(regState.sections)) {
    grid.appendChild(_makeSectionCard(key));
  }
}

// ── connection (reads from studio localStorage profile) ────────────────────

const CONN_KEY = 'promptlibretto.connection.v1';
const SNAP_KEY = 'pl-registry-snapshots-v1';

function loadStoredConnection() {
  try {
    const raw = localStorage.getItem(CONN_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function getConfig() {
  const stored = loadStoredConnection();
  const modelOverride = document.getElementById('cfg-model-override')?.value.trim();
  return {
    base_url:  stored?.baseUrl  || 'http://localhost:11434',
    model:     modelOverride    || stored?.model || 'llama3.1',
    chat_path: stored?.chatPath || '/api/chat',
  };
}

function updateConnChip() {
  const stored = loadStoredConnection();
  const chip  = document.getElementById('conn-chip');
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-chip-label');
  const display = document.getElementById('settings-conn-display');

  if (!chip) return;

  if (stored?.model) {
    let host = stored.baseUrl;
    try { host = new URL(stored.baseUrl).host; } catch {}
    label.textContent = `${host} · ${stored.model}`;
    dot.className = 'conn-dot ok';
    if (display) display.textContent = `${stored.baseUrl}  ${stored.chatPath || '/api/chat'}  ${stored.model}`;
  } else {
    label.textContent = 'no connection — configure in Studio';
    dot.className = 'conn-dot err';
    if (display) display.textContent = 'not configured';
  }
}

// ── settings ───────────────────────────────────────────────────────────────

function toggleSettings() {
  const bar = document.getElementById('settings-bar');
  const shell = document.querySelector('.cb-shell');
  const hidden = bar.hidden;
  bar.hidden = !hidden;
  shell.classList.toggle('settings-open', hidden);
}

// ── conversation ───────────────────────────────────────────────────────────

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  if (isStreaming) return;
  const input = document.getElementById('user-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  removeWelcome();

  addMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  await runChat();
}

async function runChat() {
  isStreaming = true;
  setInputEnabled(false);

  const thinkingEl = addThinking();
  const cfg = getConfig();

  try {
    await runBrowserDelegatedChat(cfg, thinkingEl);
  } catch (err) {
    removeEl(thinkingEl);
    addErrorBubble(`Browser-direct LLM error: ${err.message}`);
  } finally {
    isStreaming = false;
    setInputEnabled(true);
    document.getElementById('user-input').focus();
  }
}

async function runBrowserDelegatedChat(cfg, thinkingEl) {
  const session = await ensureBuilderSession();
  const openaiShape = cfg.chat_path.includes('/v1/');
  const url = `${cfg.base_url.replace(/\/+$/, '')}${cfg.chat_path.startsWith('/') ? cfg.chat_path : '/' + cfg.chat_path}`;
  const localMessages = [
    { role: 'system', content: session.system_prompt },
    ...conversationHistory,
  ];

  let assistantText = '';
  let assistantEl = null;

  for (let step = 0; step < 32; step++) {
    const data = await callLocalBuilderModel(url, cfg, localMessages, session.tools, openaiShape);
    removeEl(thinkingEl);

    const msg = extractAssistantMessage(data);
    const toolCalls = normalizeToolCalls(msg.tool_calls || []);

    if (!toolCalls.length) {
      const contentCalls = parseContentToolCalls(msg.content || '');
      if (contentCalls.length) {
        // Model emitted tool_call code blocks instead of native tool_calls — execute them.
        const displayText = (msg.content || '').replace(/```tool_call[\s\S]*?```/gi, '').trim();
        if (displayText) {
          assistantEl = addMessage('assistant', '');
          for (let i = 0; i < displayText.length; i += 40) {
            setMessageText(assistantEl, displayText.slice(0, i + 40));
            await delayFrame();
          }
        }
        for (const tc of contentCalls) {
          const toolResult = await dispatchBuilderTool(tc.name, tc.args);
          if (toolResult.draft_id && toolResult.draft_id !== draftId) {
            draftId = toolResult.draft_id;
            updateDraftBadge(draftId);
          }
          addToolEvent(toolResult.name, toolResult.args, toolResult.result);
          applyToolCall(toolResult.name, toolResult.args, toolResult.result);
        }
        conversationHistory.push({ role: 'assistant', content: msg.content || '' });
        return;
      }

      assistantText = msg.content || '';
      if (!assistantText) assistantText = '(no response from model - check your connection settings)';
      assistantEl = addMessage('assistant', '');
      for (let i = 0; i < assistantText.length; i += 40) {
        setMessageText(assistantEl, assistantText.slice(0, i + 40));
        await delayFrame();
      }
      conversationHistory.push({ role: 'assistant', content: assistantText });
      return;
    }

    localMessages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: toolCalls.map(tc => tc.original),
    });

    for (const tc of toolCalls) {
      const toolResult = await dispatchBuilderTool(tc.name, tc.args);
      if (toolResult.draft_id && toolResult.draft_id !== draftId) {
        draftId = toolResult.draft_id;
        updateDraftBadge(draftId);
      }
      addToolEvent(toolResult.name, toolResult.args, toolResult.result);
      applyToolCall(toolResult.name, toolResult.args, toolResult.result);

      const toolMsg = {
        role: 'tool',
        content: JSON.stringify(toolResult.result),
      };
      if (openaiShape) toolMsg.tool_call_id = tc.id || 'call_0';
      localMessages.push(toolMsg);
    }
  }

  addErrorBubble('The builder hit the tool-call round limit after applying the visible changes. Ask it to continue, summarize, validate, or export.');
}

async function ensureBuilderSession() {
  if (builderSession && builderSession.draft_id === draftId) return builderSession;
  const resp = await fetch('/api/builder/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft_id: draftId }),
  });
  if (!resp.ok) throw new Error(`builder session failed (${resp.status})`);
  builderSession = await resp.json();
  if (builderSession.draft_id) {
    draftId = builderSession.draft_id;
    updateDraftBadge(draftId);
  }
  return builderSession;
}

async function callLocalBuilderModel(url, cfg, messages, tools, openaiShape) {
  const payload = openaiShape
    ? {
        model: cfg.model,
        messages,
        tools,
        stream: false,
        temperature: 0.4,
        max_tokens: 1024,
      }
    : {
        model: cfg.model,
        messages,
        tools,
        stream: false,
        options: { temperature: 0.4, num_predict: 1024 },
      };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (isNativeToolParseFailure(resp.status, body)) {
      return callLocalBuilderModelJsonFallback(url, cfg, messages, tools, openaiShape);
    }
    throw new Error(`LLM ${resp.status}: ${body.slice(0, 240)}`);
  }
  return resp.json();
}

async function callLocalBuilderModelJsonFallback(url, cfg, messages, tools, openaiShape) {
  const toolNames = tools
    .map(t => t?.function?.name)
    .filter(Boolean)
    .join(', ');
  const fallbackMessages = [
    ...messages,
    {
      role: 'system',
      content:
        'Native tool calling failed. Return ONLY valid JSON, no markdown. ' +
        'Shape: {"tool_calls":[{"name":"tool.name","arguments":{}}],"content":""}. ' +
        'Use these tool names only: ' + toolNames,
    },
  ];
  const payload = openaiShape
    ? {
        model: cfg.model,
        messages: fallbackMessages,
        stream: false,
        temperature: 0.2,
        max_tokens: 1024,
      }
    : {
        model: cfg.model,
        messages: fallbackMessages,
        stream: false,
        options: { temperature: 0.2, num_predict: 1024 },
      };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`LLM ${resp.status}: ${body.slice(0, 240)}`);
  }

  const data = await resp.json();
  const msg = extractAssistantMessage(data);
  const parsed = parseJsonCommandMessage(msg.content || '');
  const toolCalls = (parsed.tool_calls || parsed.tools || []).map((tc, idx) => ({
    id: tc.id || `json_call_${idx}`,
    type: 'function',
    function: {
      name: tc.name || tc.tool || tc.function?.name || '',
      arguments: JSON.stringify(tc.arguments || tc.args || tc.function?.arguments || {}),
    },
  })).filter(tc => tc.function.name);

  return openaiShape
    ? { choices: [{ message: { role: 'assistant', content: parsed.content || '', tool_calls: toolCalls } }] }
    : { message: { role: 'assistant', content: parsed.content || '', tool_calls: toolCalls } };
}

function isNativeToolParseFailure(status, body) {
  return status >= 400 && /tool call arguments|parse tool call|parse_error/i.test(body || '');
}

function parseKwargs(argsStr) {
  argsStr = (argsStr || '').trim();
  if (!argsStr) return {};
  try { return JSON.parse(argsStr); } catch {}
  const args = {};
  let i = 0;
  while (i < argsStr.length) {
    while (i < argsStr.length && (argsStr[i] === ',' || argsStr[i] === ' ')) i++;
    const keyMatch = argsStr.slice(i).match(/^([a-zA-Z_]\w*)\s*=\s*/);
    if (!keyMatch) break;
    const key = keyMatch[1];
    i += keyMatch[0].length;
    const valStart = i;
    let depth = 0, inStr = false, strChar = '', escape = false;
    while (i < argsStr.length) {
      const ch = argsStr[i];
      if (escape) { escape = false; i++; continue; }
      if (ch === '\\') { escape = true; i++; continue; }
      if (inStr) { if (ch === strChar) inStr = false; i++; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strChar = ch; i++; continue; }
      if (ch === '{' || ch === '[') { depth++; i++; continue; }
      if (ch === '}' || ch === ']') { if (depth === 0) break; depth--; i++; continue; }
      if (depth === 0 && ch === ',') break;
      i++;
    }
    const raw = argsStr.slice(valStart, i).trim();
    try { args[key] = JSON.parse(raw.replace(/'/g, '"')); } catch { args[key] = raw; }
  }
  return args;
}

function parseContentToolCalls(content) {
  if (!content) return [];
  const results = [];
  const blockRe = /```tool_call\s*([\s\S]*?)```/gi;
  let m;
  while ((m = blockRe.exec(content)) !== null) {
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const parenIdx = line.indexOf('(');
      if (parenIdx < 1) continue;
      const name = line.slice(0, parenIdx).trim();
      if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(name)) continue;
      const lastParen = line.lastIndexOf(')');
      const args = parseKwargs(lastParen > parenIdx ? line.slice(parenIdx + 1, lastParen) : '');
      results.push({
        id: `cblock_${results.length}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    }
  }
  return normalizeToolCalls(results);
}

function parseJsonCommandMessage(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return { content: trimmed, tool_calls: [] };
}

function extractAssistantMessage(data) {
  if (data?.message) return data.message || {};
  const choices = data?.choices || [];
  if (choices.length) return choices[0]?.message || {};
  if (data?.error) throw new Error(String(data.error?.message || data.error));
  return {};
}

function normalizeToolCalls(toolCalls) {
  return toolCalls.map((tc, idx) => {
    const fn = tc.function || tc;
    let args = fn.arguments ?? fn.args ?? {};
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    return {
      id: tc.id || `call_${idx}`,
      name: fn.name || tc.name || '',
      args: args || {},
      original: tc.function ? tc : {
        id: tc.id || `call_${idx}`,
        type: 'function',
        function: { name: fn.name || tc.name || '', arguments: JSON.stringify(args || {}) },
      },
    };
  }).filter(tc => tc.name);
}

async function dispatchBuilderTool(name, args) {
  const resp = await fetch('/api/builder/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args, draft_id: draftId }),
  });
  if (!resp.ok) throw new Error(`tool dispatch failed (${resp.status})`);
  return resp.json();
}

function delayFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// ── tool call application → registry viz ──────────────────────────────────

function applyToolCall(name, args, result) {
  if (result.error) return; // don't update viz on errors

  switch (name) {
    case 'registry.draft.create':
      draftId = result.draft_id || draftId;
      updateDraftBadge(draftId);
      break;

    case 'registry.meta.set':
      if (result.title !== undefined) setRegTitle(result.title);
      if (result.description !== undefined) setRegDesc(result.description);
      break;

    case 'registry.section.add_var': {
      const { section, template_vars } = result;
      if (section && template_vars) {
        _ensureSectionCard(section);
        regState.sections[section].vars = template_vars;
        refreshSectionVars(section);
      }
      break;
    }

    case 'registry.section.add_item': {
      const { section, item } = result;
      if (section && item) {
        _ensureSectionCard(section);
        regState.sections[section].items.push(item);
        addSectionItem(section, item);
        flashCard(section);
        document.getElementById('export-btn').disabled = false;
        if (currentDetailSection === section) renderSectionPreview(section);
      }
      break;
    }

    case 'registry.item.update': {
      const { section, item } = result;
      if (section && item) {
        const id = item.id || item.name;
        const existing = regState.sections[section]?.items.find(
          i => (i.id || i.name) === id
        );
        if (existing) Object.assign(existing, item);
        refreshSectionItems(section);
        flashCard(section);
        if (currentDetailSection === section) renderSectionPreview(section);
      }
      break;
    }

    case 'registry.item.add_fragment': {
      // Patch the fragment into the client-side item so it's included in export.
      const { section, item_id, fragment } = result;
      if (section && item_id && fragment) {
        const item = regState.sections[section]?.items.find(i => (i.id || i.name) === item_id);
        if (item) {
          item.fragments = item.fragments || [];
          if (!item.fragments.find(f => f.id === fragment.id)) item.fragments.push(fragment);
        }
      }
      flashCard(args.section_key);
      break;
    }

    case 'registry.item.add_group': {
      // Patch the group into the client-side item so it's included in export.
      const { section, item_id, group } = result;
      if (section && item_id && group) {
        const item = regState.sections[section]?.items.find(i => (i.id || i.name) === item_id);
        if (item) {
          item.groups = item.groups || [];
          const existing = item.groups.find(g => g.id === group.id);
          if (existing) Object.assign(existing, group);
          else item.groups.push(group);
        }
      }
      flashCard(args.section_key);
      break;
    }

    case 'registry.assembly.set_order':
      if (result.assembly_order) {
        regState.assembly = normalizeAssemblyOrder(result.assembly_order);
        renderAssemblyOrder();
      }
      break;

    case 'registry.generation.set':
      if (result.generation) {
        Object.assign(regState.generation, sanitizeGeneration(result.generation));
        renderExtras();
      }
      break;

    case 'registry.output_policy.set':
      if (result.output_policy) {
        Object.assign(regState.output_policy, result.output_policy);
        renderExtras();
      }
      break;

    case 'registry.memory.configure':
      if (result.memory_config) {
        Object.assign(regState.memory_config, result.memory_config);
        renderExtras();
      }
      break;

    case 'registry.classifier_rule.add':
      if (result.rule) {
        regState.memory_rules.push(result.rule);
        renderExtras();
      }
      break;

    case 'registry.classifier_rule.remove':
      if (result.removed) {
        regState.memory_rules = regState.memory_rules.filter(r => r.tag !== result.removed);
        renderExtras();
      }
      break;

    case 'registry.style_blend.set':
      if (result.style_blend) {
        regState.style_blend = result.style_blend;
        renderExtras();
      }
      break;

    case 'registry.style_blend.disable':
      if (result.style_blend !== undefined) {
        regState.style_blend = result.style_blend;
        renderExtras();
      }
      break;

    case 'registry.draft.validate':
      // Enable export regardless of ok — user can export a partial/invalid draft too.
      document.getElementById('export-btn').disabled = false;
      break;

    case 'registry.draft.export':
      document.getElementById('export-btn').disabled = false;
      break;
  }
}

// ── section detail (master-detail panel) ──────────────────────────────────

function openSectionDetail(sectionKey) {
  currentDetailSection = sectionKey;
  document.getElementById('detail-overview').hidden = true;
  document.getElementById('detail-section').hidden = false;
  document.getElementById('sec-detail-name').textContent = SECTION_LABELS[sectionKey] || sectionKey;
  renderSectionPreview(sectionKey);
}

function closeSectionDetail() {
  currentDetailSection = null;
  document.getElementById('detail-section').hidden = true;
  document.getElementById('detail-overview').hidden = false;
}

function renderSectionPreview(sectionKey) {
  const body = document.getElementById('sec-detail-body');
  body.innerHTML = '';

  const sec = regState.sections[sectionKey];
  if (!sec) return;

  const st = secState(sectionKey);

  // ── template vars row ──
  if (sec.vars.length) {
    const varsRow = document.createElement('div');
    varsRow.className = 'cb-detail-vars';
    for (const v of sec.vars) {
      const chip = document.createElement('span');
      chip.className = 'cb-var-chip';
      chip.textContent = `{${v}}`;
      varsRow.appendChild(chip);
    }
    body.appendChild(varsRow);
  }

  if (!sec.items.length) {
    const empty = document.createElement('p');
    empty.className = 'cb-detail-empty';
    empty.textContent = 'No items in this section yet.';
    body.appendChild(empty);
    return;
  }

  for (let itemIdx = 0; itemIdx < sec.items.length; itemIdx++) {
    const item = sec.items[itemIdx];
    const id = item.id || item.name || '?';
    const isSelected = st.selected === id;
    const card = document.createElement('div');
    card.className = 'cb-detail-item' + (isSelected ? ' selected' : '');

    // ── header: id + badge + actions ──
    const hdr = document.createElement('div');
    hdr.className = 'cb-detail-item-hdr';

    const idSpan = document.createElement('span');
    idSpan.className = 'cb-detail-item-id';
    idSpan.textContent = id;
    hdr.appendChild(idSpan);

    if (isSelected) {
      const badge = document.createElement('span');
      badge.className = 'cb-detail-item-badge';
      badge.textContent = 'selected';
      hdr.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'cb-detail-item-actions';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'cb-detail-action-btn cb-detail-delete-btn';
    delBtn.title = 'Delete item';
    delBtn.textContent = '×';
    delBtn.onclick = (e) => { e.stopPropagation(); deleteItem(sectionKey, itemIdx); };
    actions.appendChild(delBtn);

    hdr.appendChild(actions);
    card.appendChild(hdr);

    // ── main text (editable) ──
    const textField = item.text !== undefined ? 'text' : (item.context !== undefined ? 'context' : 'text');
    const mainText = item[textField] || '';
    const textDiv = document.createElement('div');
    textDiv.className = 'cb-detail-item-text';
    textDiv.innerHTML = highlightVars(mainText);
    textDiv.title = 'Click to edit';
    textDiv.onclick = () => openInlineEdit(sectionKey, itemIdx, textField, textDiv, mainText);
    card.appendChild(textDiv);

    // ── fragments ──
    for (let fi = 0; fi < (item.fragments || []).length; fi++) {
      const frag = item.fragments[fi];
      const fragDiv = document.createElement('div');
      fragDiv.className = 'cb-detail-fragment';

      const fragHdr = document.createElement('div');
      fragHdr.className = 'cb-detail-frag-hdr';
      fragHdr.innerHTML = `<span class="cb-detail-frag-label">${escHtml(frag.id || 'fragment')}</span>`;

      const fragDel = document.createElement('button');
      fragDel.type = 'button';
      fragDel.className = 'cb-detail-action-btn cb-detail-delete-btn';
      fragDel.textContent = '×';
      fragDel.title = 'Delete fragment';
      fragDel.onclick = (e) => { e.stopPropagation(); deleteFragment(sectionKey, itemIdx, fi); };
      fragHdr.appendChild(fragDel);
      fragDiv.appendChild(fragHdr);

      const fragText = document.createElement('div');
      fragText.className = 'cb-detail-frag-text';
      fragText.innerHTML = highlightVars(frag.text || '');
      fragText.title = 'Click to edit';
      fragText.onclick = () => openInlineEdit(sectionKey, itemIdx, null, fragText, frag.text || '', (val) => {
        item.fragments[fi].text = val;
        refreshSectionItems(sectionKey);
        renderSectionPreview(sectionKey);
      });
      fragDiv.appendChild(fragText);

      card.appendChild(fragDiv);
    }

    // ── groups ──
    for (let gi = 0; gi < (item.groups || []).length; gi++) {
      const g = item.groups[gi];
      const gKey = `groups[${g.id}]`;
      const currentMode = st.array_modes[gKey] || 'all';

      const gDiv = document.createElement('div');
      gDiv.className = 'cb-detail-group';

      const gHdr = document.createElement('div');
      gHdr.className = 'cb-detail-group-hdr';
      gHdr.innerHTML = `
        <span class="cb-detail-group-id">${escHtml(g.id)}</span>
        <span class="cb-detail-group-mode">${escHtml(currentMode)}</span>
      `;
      gDiv.appendChild(gHdr);

      if (g.items && g.items.length) {
        const gList = document.createElement('div');
        gList.className = 'cb-detail-group-items';
        for (let dIdx = 0; dIdx < g.items.length; dIdx++) {
          const directive = g.items[dIdx];
          const giText = typeof directive === 'string' ? directive : (directive.text || directive.directive || JSON.stringify(directive));

          const giRow = document.createElement('div');
          giRow.className = 'cb-detail-group-item';

          const giTextSpan = document.createElement('span');
          giTextSpan.className = 'cb-detail-group-item-text';
          giTextSpan.innerHTML = highlightVars(giText);
          giTextSpan.title = 'Click to edit';
          giTextSpan.onclick = () => openInlineEdit(sectionKey, itemIdx, null, giTextSpan, giText, (val) => {
            g.items[dIdx] = val;
            renderSectionPreview(sectionKey);
          }, true);
          giRow.appendChild(giTextSpan);

          const giDel = document.createElement('button');
          giDel.type = 'button';
          giDel.className = 'cb-detail-action-btn cb-detail-delete-btn cb-detail-group-del';
          giDel.textContent = '×';
          giDel.title = 'Delete directive';
          giDel.onclick = (e) => { e.stopPropagation(); deleteGroupDirective(sectionKey, itemIdx, gi, dIdx); };
          giRow.appendChild(giDel);

          gList.appendChild(giRow);
        }

        // add directive button
        const addRow = document.createElement('button');
        addRow.type = 'button';
        addRow.className = 'cb-detail-add-directive';
        addRow.textContent = '+ directive';
        addRow.onclick = () => addGroupDirective(sectionKey, itemIdx, gi);
        gList.appendChild(addRow);

        gDiv.appendChild(gList);
      }

      card.appendChild(gDiv);
    }

    // ── scale ──
    if (item.scale) {
      const current = (isSelected && st.slider !== null) ? st.slider : (item.scale.default_value ?? 5);
      const scaleDiv = document.createElement('div');
      scaleDiv.className = 'cb-detail-scale';
      scaleDiv.innerHTML = `
        <span class="cb-detail-scale-label">scale</span>
        <span class="cb-detail-scale-val">${current}/10</span>
      `;
      card.appendChild(scaleDiv);
    }

    body.appendChild(card);
  }

  // ── generate more footer ──
  const footer = document.createElement('div');
  footer.className = 'cb-sec-gen-footer';

  const stepper = document.createElement('div');
  stepper.className = 'cb-gen-stepper';
  stepper.innerHTML = `
    <button type="button" class="cb-gen-step-btn" onclick="adjustGenCount(-1)">−</button>
    <span class="cb-gen-count" id="gen-count-display">2</span>
    <button type="button" class="cb-gen-step-btn" onclick="adjustGenCount(1)">+</button>
    <span class="cb-gen-count-label">more items</span>
  `;
  footer.appendChild(stepper);

  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'cb-gen-btn';
  genBtn.textContent = 'Generate →';
  genBtn.onclick = () => generateMoreItems(sectionKey);
  footer.appendChild(genBtn);

  body.appendChild(footer);
}

let _generateCount = 2;

function adjustGenCount(delta) {
  _generateCount = Math.max(1, Math.min(5, _generateCount + delta));
  const el = document.getElementById('gen-count-display');
  if (el) el.textContent = _generateCount;
}

const SECTION_PURPOSE = {
  base_context:             'establishes the core scenario, role, and situation — each item is a different context variation the runtime can select',
  personas:                 'defines character identity and behavioral traits — each item is a distinct persona the model adopts',
  sentiment:                'sets the emotional tone or attitude — each item is a distinct mood or disposition',
  static_injections:        'injects fixed instructional text into the prompt — each item is a different static snippet',
  runtime_injections:       'injects dynamic runtime values — each item is a different runtime hook',
  output_prompt_directions: 'guides how the model should structure and style its response — each item is a different output directive set',
  memory_recall:            'injects retrieved memory context — each item is a different recall format',
  prompt_endings:           'provides the final prompt suffix that closes the assembled prompt — each item is a different closing style',
};

function generateMoreItems(sectionKey) {
  const sec = regState.sections[sectionKey];
  if (!sec) return;

  const label = SECTION_LABELS[sectionKey] || sectionKey;
  const purpose = SECTION_PURPOSE[sectionKey] || `the ${label} section`;
  const count = _generateCount;

  // summarise existing items
  const existingLines = sec.items.map(item => {
    const id = item.id || item.name || '?';
    const content = item.text || item.context || '';
    return `  - "${id}": ${content ? content.slice(0, 120) + (content.length > 120 ? '…' : '') : '(empty)'}`;
  });

  // include base context if available
  const bcItems = regState.sections.base_context?.items || [];
  const bcText = bcItems[0]?.text || '';

  const lines = [
    `Add ${count} more item${count > 1 ? 's' : ''} to the ${label} section of the current draft.`,
    '',
    `Section purpose: ${purpose}`,
    '',
  ];

  if (bcText) {
    lines.push('Base context (for reference):');
    lines.push(`  ${bcText.slice(0, 200)}${bcText.length > 200 ? '…' : ''}`);
    lines.push('');
  }

  if (existingLines.length) {
    lines.push(`Existing ${label} items (do not duplicate these):`);
    lines.push(...existingLines);
    lines.push('');
  }

  lines.push(
    `Generate ${count} new, distinct item${count > 1 ? 's' : ''} that fit the registry theme and complement what already exists.`,
    `Use registry.section.add_item for each one. Include real descriptive content — do not leave content fields empty.`,
  );

  const input = document.getElementById('user-input');
  if (input) {
    input.value = lines.join('\n');
    input.focus();
    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
  }
}

// ── inline editing helpers ─────────────────────────────────────────────────

function openInlineEdit(sectionKey, itemIdx, field, displayEl, currentVal, customSave, singleLine) {
  const isTextarea = !singleLine;
  const editor = document.createElement(isTextarea ? 'textarea' : 'input');
  editor.className = 'cb-detail-inline-editor';
  editor.value = currentVal;
  if (isTextarea) {
    editor.rows = Math.max(3, (currentVal.match(/\n/g) || []).length + 2);
  }

  const save = () => {
    const val = editor.value.trim();
    if (customSave) {
      customSave(val);
    } else if (field) {
      regState.sections[sectionKey].items[itemIdx][field] = val;
      refreshSectionItems(sectionKey);
      renderSectionPreview(sectionKey);
    }
  };

  editor.onblur = save;
  editor.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); displayEl.style.display = ''; editor.remove(); }
    if (singleLine && e.key === 'Enter') { e.preventDefault(); editor.blur(); }
    if (!singleLine && e.key === 'Enter' && e.metaKey) { e.preventDefault(); editor.blur(); }
  };

  displayEl.style.display = 'none';
  displayEl.parentNode.insertBefore(editor, displayEl.nextSibling);
  editor.focus();
  editor.selectionStart = editor.selectionEnd = editor.value.length;
}

function deleteItem(sectionKey, itemIdx) {
  regState.sections[sectionKey].items.splice(itemIdx, 1);
  refreshSectionItems(sectionKey);
  refreshSectionVars(sectionKey);
  renderSectionPreview(sectionKey);
}

function deleteFragment(sectionKey, itemIdx, fragIdx) {
  regState.sections[sectionKey].items[itemIdx].fragments.splice(fragIdx, 1);
  renderSectionPreview(sectionKey);
}

function deleteGroupDirective(sectionKey, itemIdx, groupIdx, directiveIdx) {
  regState.sections[sectionKey].items[itemIdx].groups[groupIdx].items.splice(directiveIdx, 1);
  renderSectionPreview(sectionKey);
}

function addGroupDirective(sectionKey, itemIdx, groupIdx) {
  const text = window.prompt('New directive:');
  if (!text || !text.trim()) return;
  regState.sections[sectionKey].items[itemIdx].groups[groupIdx].items.push(text.trim());
  renderSectionPreview(sectionKey);
}

function highlightVars(text) {
  return escHtml(text).replace(/\{([a-zA-Z0-9_]+)\}/g, '<span class="cb-tvar">{$1}</span>');
}

// ── registry viz helpers ───────────────────────────────────────────────────

function setRegTitle(title) {
  regState.title = title;
  const el = document.getElementById('reg-title');
  el.textContent = title || 'Untitled';
  el.classList.toggle('populated', !!title);
}

function setRegDesc(desc) {
  regState.description = desc;
  document.getElementById('reg-desc').textContent = desc || 'No description yet.';
}

// ── section state helpers ──────────────────────────────────────────────────

function secState(sectionKey) {
  if (!draftState[sectionKey]) draftState[sectionKey] = { selected: null, array_modes: {}, slider: null, template_vars: {} };
  return draftState[sectionKey];
}

function selectItem(sectionKey, itemId) {
  const st = secState(sectionKey);
  st.selected = itemId;
  refreshSectionItems(sectionKey);
}

function setArrayMode(sectionKey, itemId, groupKey, mode, btn) {
  const st = secState(sectionKey);
  st.array_modes[groupKey] = mode;
  // re-render just the mode pills for this group
  const pill_row = btn?.closest('.cb-group-modes');
  if (pill_row) {
    pill_row.querySelectorAll('.cb-mode-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.mode === mode);
    });
  }
}

function setSlider(sectionKey, itemId, value, valEl) {
  const st = secState(sectionKey);
  st.slider = Number(value);
  if (valEl) valEl.textContent = value;
}

const KNOWN_SECTION_KEYS = new Set(Object.keys(SECTION_LABELS));

function normalizeAssemblyOrder(order) {
  return (order || []).map(token => {
    if (ASSEMBLY_TOKEN_ALIASES[token]) return ASSEMBLY_TOKEN_ALIASES[token];
    // collapse section.item_id.attribute → section.attribute
    const parts = token.split('.');
    if (parts.length === 3 && KNOWN_SECTION_KEYS.has(parts[0])) {
      return `${parts[0]}.${parts[2]}`;
    }
    return token;
  });
}

function sanitizeGeneration(generation) {
  const clean = {};
  for (const [key, val] of Object.entries(generation || {})) {
    if (GENERATION_KEYS.has(key)) clean[key] = val;
  }
  return clean;
}

function validSelectedForSection(sectionKey, selected) {
  const items = regState.sections[sectionKey]?.items || [];
  if (selected && items.some(item => (item.id || item.name) === selected)) return selected;
  return items[0] ? (items[0].id || items[0].name || null) : null;
}

// ── item rendering ─────────────────────────────────────────────────────────

function _buildItemEl(sectionKey, item) {
  const id     = item.id || item.name || '?';
  const preview = item.text || item.context || '';
  const truncated = preview.length > 44 ? preview.slice(0, 44) + '…' : preview;
  const st     = secState(sectionKey);
  const isSelected = st.selected === id;

  const div = document.createElement('div');
  div.className = 'cb-sec-item' + (isSelected ? ' selected' : '');
  div.dataset.itemId = id;
  div.onclick = (e) => {
    e.stopPropagation();
    selectItem(sectionKey, id);
    openSectionDetail(sectionKey);
  };

  // main row
  const row = document.createElement('div');
  row.className = 'cb-sec-item-row';
  row.innerHTML = `
    <span class="cb-sel-dot"></span>
    <span class="item-id">${escHtml(id)}</span>
    <span class="item-text">${escHtml(truncated)}</span>
  `;
  div.appendChild(row);

  // groups — only shown when selected
  const groups = item.groups || [];
  const hasItemsArr = Array.isArray(item.items) && item.items.length; // prompt_endings
  const hasGroups = groups.length > 0 || hasItemsArr;

  if (isSelected && hasGroups) {
    const allGroups = [...groups];
    if (hasItemsArr) allGroups.push({ id: 'items', items: item.items });

    for (const g of allGroups) {
      const gKey = g.id ? `groups[${g.id}]` : 'items';
      const currentMode = st.array_modes[gKey] || 'all';
      const modes = ['all', 'r:1', 'r:2', 'r:3', 'first', 'last'];

      const gDiv = document.createElement('div');
      gDiv.className = 'cb-item-group';
      gDiv.innerHTML = `<span class="cb-group-label">${escHtml(g.id || 'items')}</span>`;

      const pillRow = document.createElement('div');
      pillRow.className = 'cb-group-modes';
      for (const m of modes) {
        const apiMode = m.startsWith('r:') ? `random:${m.slice(2)}` : m;
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'cb-mode-pill' + (currentMode === apiMode || currentMode === m ? ' active' : '');
        pill.dataset.mode = apiMode;
        pill.textContent = m;
        pill.onclick = e => { e.stopPropagation(); setArrayMode(sectionKey, id, gKey, apiMode, pill); };
        pillRow.appendChild(pill);
      }
      gDiv.appendChild(pillRow);
      div.appendChild(gDiv);
    }
  }

  // scale slider — only shown when selected
  if (isSelected && item.scale) {
    const scaleDiv = document.createElement('div');
    scaleDiv.className = 'cb-item-scale';
    const current = st.slider ?? item.scale.default_value ?? 5;
    const valSpan = document.createElement('span');
    valSpan.className = 'cb-scale-val';
    valSpan.textContent = current;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0; slider.max = 10; slider.value = current;
    slider.className = 'cb-scale-slider';
    slider.oninput = e => { e.stopPropagation(); setSlider(sectionKey, id, e.target.value, valSpan); };
    slider.onclick = e => e.stopPropagation();
    scaleDiv.appendChild(slider);
    scaleDiv.appendChild(valSpan);
    div.appendChild(scaleDiv);
    // init slider state
    if (st.slider === null) st.slider = current;
  }

  return div;
}

function addSectionItem(sectionKey, item) {
  const container = document.getElementById(`sec-items-${sectionKey}`);
  if (!container) return;

  const empty = container.querySelector('.cb-sec-empty');
  if (empty) empty.remove();

  const st = secState(sectionKey);
  // Auto-select first item added to a section
  if (st.selected === null) {
    st.selected = item.id || item.name || null;
    // init slider if scale present
    if (item.scale && st.slider === null) st.slider = item.scale.default_value ?? 5;
  }

  container.appendChild(_buildItemEl(sectionKey, item));
  document.getElementById(`sec-card-${sectionKey}`)?.classList.add('has-items');
}

function refreshSectionItems(sectionKey) {
  const container = document.getElementById(`sec-items-${sectionKey}`);
  if (!container) return;
  container.innerHTML = '';
  const items = regState.sections[sectionKey]?.items || [];
  if (!items.length) {
    container.innerHTML = '<span class="cb-sec-empty">Empty</span>';
    document.getElementById(`sec-card-${sectionKey}`)?.classList.remove('has-items');
    return;
  }
  for (const item of items) {
    container.appendChild(_buildItemEl(sectionKey, item));
  }
  document.getElementById(`sec-card-${sectionKey}`)?.classList.add('has-items');
}

function refreshSectionVars(sectionKey) {
  const container = document.getElementById(`sec-vars-${sectionKey}`);
  if (!container) return;
  container.innerHTML = '';
  for (const v of (regState.sections[sectionKey]?.vars || [])) {
    const chip = document.createElement('span');
    chip.className = 'cb-var-chip';
    chip.textContent = `{${v}}`;
    container.appendChild(chip);
  }
}

function flashCard(sectionKey) {
  const card = document.getElementById(`sec-card-${sectionKey}`);
  if (!card) return;
  card.classList.add('just-updated');
  setTimeout(() => card.classList.remove('just-updated'), 800);
}

function renderAssemblyOrder() {
  const row = document.getElementById('assembly-row');
  const tokens = document.getElementById('assembly-tokens');
  tokens.innerHTML = '';
  if (!regState.assembly.length) { row.hidden = true; return; }

  row.hidden = false;
  for (const token of regState.assembly) {
    const span = document.createElement('span');
    span.className = 'cb-asm-token';
    span.textContent = token;
    tokens.appendChild(span);
  }
}

function renderExtras() {
  const row = document.getElementById('extras-row');
  row.innerHTML = '';

  const addPill = (label, val) => {
    const pill = document.createElement('div');
    pill.className = 'cb-extra-pill';
    pill.innerHTML = `<span class="pill-label">${label}</span><span class="pill-val">${escHtml(val)}</span>`;
    row.appendChild(pill);
  };

  const gen = regState.generation;
  if (gen.temperature !== undefined) addPill('temp', gen.temperature);
  if (gen.max_tokens   !== undefined) addPill('max_tokens', gen.max_tokens);
  if (gen.top_p        !== undefined) addPill('top_p', gen.top_p);

  const op = regState.output_policy;
  for (const [k, v] of Object.entries(op)) addPill(k, v);

  if (MEMORY_ENABLED) {
    const mc = regState.memory_config;
    if (mc.emotional_state_enabled) addPill('emotion', '✓');
    if (mc.working_notes_enabled)   addPill('notes', '✓');
    if (mc.classifier_model)        addPill('clf', mc.classifier_model);
    const rules = regState.memory_rules;
    if (rules.length) addPill('rules', rules.length);
  }

  const sb = regState.style_blend;
  for (const [sec, cfg] of Object.entries(sb)) {
    addPill(`blend:${sec}`, `${cfg.axis}>${cfg.threshold}`);
  }
}

// ── activity feed ──────────────────────────────────────────────────────────

function addToolEvent(name, args, result) {
  // chat panel chip
  const msgs = document.getElementById('messages');
  const chip = document.createElement('div');
  chip.className = 'cb-tool-event';
  const ok = !result.error;
  const argSummary = summarizeArgs(name, args);

  // for validate: show pass/fail badge based on result.ok
  const validateOk = name === 'registry.draft.validate' ? result.ok : null;
  const chipOk = validateOk !== null ? validateOk : ok;
  chip.innerHTML = `
    <span class="cb-tool-dot"></span>
    <span class="cb-tool-name">${escHtml(name)}</span>
    ${argSummary ? `<span style="color:var(--muted)">${escHtml(argSummary)}</span>` : ''}
    <span class="${chipOk ? 'cb-tool-ok' : 'cb-tool-err'}">${chipOk ? '✓' : '✗'}</span>
  `;
  msgs.appendChild(chip);

  // for validate: render error/warning list as a distinct bubble
  if (name === 'registry.draft.validate') {
    const errors   = result.errors   || [];
    const warnings = result.warnings || [];
    if (errors.length || warnings.length) {
      const bubble = document.createElement('div');
      bubble.className = 'cb-validate-bubble';
      const lines = [];
      for (const e of errors)   lines.push(`<div class="cb-vld-error">✗ ${escHtml(e.path)} — ${escHtml(e.message)}</div>`);
      for (const w of warnings) lines.push(`<div class="cb-vld-warn">⚠ ${escHtml(w.path)} — ${escHtml(w.message)}</div>`);
      bubble.innerHTML = `
        <div class="cb-vld-header">${errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : ''}${errors.length && warnings.length ? ', ' : ''}${warnings.length ? `${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}</div>
        ${lines.join('')}
      `;
      msgs.appendChild(bubble);
    }
  }

  msgs.scrollTop = msgs.scrollHeight;

  // activity strip
  const list = document.getElementById('activity-list');
  const empty = list.querySelector('.cb-activity-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'cb-activity-item';
  item.innerHTML = `
    <span class="act-arrow">→</span>
    <span class="act-tool">${escHtml(name)}</span>
    ${argSummary ? `<span style="color:var(--muted-soft);font-size:9px">${escHtml(argSummary)}</span>` : ''}
    <span class="${ok ? 'act-ok' : 'act-err'}">${ok ? '✓' : result.error || '✗'}</span>
  `;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function summarizeArgs(name, args) {
  if (!args) return '';
  if (name === 'registry.section.add_item') return `${args.section_key}/${args.item_id}`;
  if (name === 'registry.section.add_var')  return `${args.section_key}/{${args.var_name}}`;
  if (name === 'registry.item.add_fragment') return `${args.section_key}/${args.item_id}`;
  if (name === 'registry.item.add_group')    return `${args.section_key}/${args.item_id}/${args.group_id}`;
  if (name === 'registry.classifier_rule.add') return `tag:${args.tag}`;
  if (name === 'registry.meta.set') return args.title ? `"${args.title}"` : '';
  if (name === 'registry.style_blend.set') return `${args.section}/${args.axis}`;
  return '';
}

// ── chat DOM helpers ───────────────────────────────────────────────────────

function removeWelcome() {
  document.querySelector('.cb-welcome')?.remove();
  document.getElementById('intake-card')?.remove();
}

function _intakeCardHTML() {
  return `
    <div class="cb-intake" id="intake-card">
      <div class="cb-intake-head">
        <div class="cb-welcome-icon">✦</div>
        <p class="cb-intake-title">What are you building?</p>
        <p class="cb-intake-sub">Fill in what you know — leave anything blank and the assistant will decide.</p>
      </div>
      <div class="cb-intake-fields">
        <div class="cb-intake-field">
          <label class="cb-intake-label" for="intake-idea">Registry idea <span class="cb-intake-req">required</span></label>
          <textarea id="intake-idea" class="cb-intake-textarea" placeholder="Describe the scenario or model you want to build…" rows="3"></textarea>
        </div>
        <div class="cb-intake-row">
          <div class="cb-intake-field">
            <label class="cb-intake-label" for="intake-personas">Personas <span class="cb-intake-hint">who the model IS</span></label>
            <input id="intake-personas" class="cb-intake-input" type="text" placeholder="e.g. friendly guide, strict coach" />
          </div>
          <div class="cb-intake-field">
            <label class="cb-intake-label" for="intake-sentiment">Sentiment <span class="cb-intake-hint">tone or range</span></label>
            <input id="intake-sentiment" class="cb-intake-input" type="text" placeholder="e.g. impressed, unimpressed" />
          </div>
        </div>
        <div class="cb-intake-field">
          <label class="cb-intake-label">Scene variations <span class="cb-intake-hint">who/what the model talks to — each becomes a static injection</span></label>
          <div class="cb-intake-scene-list" id="intake-scene-list">
            <div class="cb-intake-scene-row">
              <input class="cb-intake-input cb-intake-scene-input" type="text" placeholder="e.g. good prospect" />
              <button type="button" class="cb-intake-scene-remove" onclick="removeSceneRow(this)" style="display:none">×</button>
            </div>
          </div>
          <button type="button" class="cb-intake-scene-add" onclick="addSceneRow()">+ Add variation</button>
        </div>
        <div class="cb-intake-row">
          <div class="cb-intake-field cb-intake-field--narrow">
            <label class="cb-intake-label">Memory system</label>
            <label class="cb-intake-toggle-row">
              <span class="cb-intake-toggle"><input type="checkbox" id="intake-memory" /></span>
              <span class="cb-intake-toggle-label">Include memory</span>
            </label>
          </div>
          <div class="cb-intake-field">
            <label class="cb-intake-label">Extra sections <span class="cb-intake-hint">optional</span></label>
            <div class="cb-intake-chips">
              <label class="cb-intake-chip"><input type="checkbox" value="runtime_injections" /> Runtime inject</label>
            </div>
          </div>
        </div>
        <div class="cb-intake-field">
          <label class="cb-intake-label" for="intake-notes">Additional notes <span class="cb-intake-hint">optional</span></label>
          <textarea id="intake-notes" class="cb-intake-textarea cb-intake-textarea--sm" placeholder="Anything else the assistant should know…" rows="2"></textarea>
        </div>
      </div>
      <div class="cb-intake-actions">
        <button type="button" class="cb-intake-submit" onclick="submitIntake()">Start Building →</button>
      </div>
    </div>
  `;
}

function addSceneRow() {
  const list = document.getElementById('intake-scene-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'cb-intake-scene-row';
  row.innerHTML = `
    <input class="cb-intake-input cb-intake-scene-input" type="text" placeholder="e.g. bad prospect" />
    <button type="button" class="cb-intake-scene-remove" onclick="removeSceneRow(this)">×</button>
  `;
  list.appendChild(row);
  row.querySelector('input').focus();
  _updateSceneRemoveBtns();
}

function removeSceneRow(btn) {
  const list = document.getElementById('intake-scene-list');
  if (!list) return;
  const rows = list.querySelectorAll('.cb-intake-scene-row');
  if (rows.length > 1) {
    btn.closest('.cb-intake-scene-row').remove();
    _updateSceneRemoveBtns();
  }
}

function _updateSceneRemoveBtns() {
  const list = document.getElementById('intake-scene-list');
  if (!list) return;
  const rows = list.querySelectorAll('.cb-intake-scene-row');
  rows.forEach(row => {
    const btn = row.querySelector('.cb-intake-scene-remove');
    if (btn) btn.style.display = rows.length > 1 ? '' : 'none';
  });
}

function submitIntake() {
  const idea = document.getElementById('intake-idea')?.value.trim();
  if (!idea) {
    document.getElementById('intake-idea')?.focus();
    return;
  }

  const personas  = document.getElementById('intake-personas')?.value.trim();
  const sentiment = document.getElementById('intake-sentiment')?.value.trim();
  const sceneInputEls = [...document.querySelectorAll('#intake-scene-list .cb-intake-scene-input')];
  const scenes    = sceneInputEls.map(el => el.value.trim()).filter(Boolean).join(',') || '';
  const memory    = document.getElementById('intake-memory')?.checked;
  const notes     = document.getElementById('intake-notes')?.value.trim();
  const extras    = [...document.querySelectorAll('.cb-intake-chips input:checked')].map(el => el.value);

  const personaList   = personas  ? personas.split(',').map(s => s.trim()).filter(Boolean)  : null;
  const sentimentList = sentiment ? sentiment.split(',').map(s => s.trim()).filter(Boolean) : null;
  const sceneList     = scenes    ? scenes.split(',').map(s => s.trim()).filter(Boolean)    : null;

  const personaLine = personaList
    ? `Create one separate item per persona: ${personaList.map(p => `"${p}"`).join(', ')} — do NOT combine them into one item. Personas describe who the model IS (its own character identity).`
    : '[you decide based on the idea — create one item per distinct persona, describing who the model IS]';
  const sentimentLine = sentimentList
    ? `Create one separate item per sentiment: ${sentimentList.map(s => `"${s}"`).join(', ')} — do NOT combine them into one item`
    : '[you decide based on the idea — create one item per distinct sentiment]';

  // if scenes are specified, auto-include static_injections
  const allExtras = sceneList ? [...new Set([...extras, 'static_injections'])] : extras;

  const sceneLine = sceneList
    ? `Create one separate item per scene in the static_injections section: ${sceneList.map(s => `"${s}"`).join(', ')} — do NOT combine them. Scene variation content describes who/what the model is talking to or the situational context, NOT the model's own character.`
    : null;

  const lines = [
    `Build a registry for the following idea:\n${idea}`,
    '',
    'Structural preferences — follow exactly what is specified; use your own judgment for anything marked [you decide]:',
    `- Personas (who the model IS): ${personaLine}`,
    `- Sentiment: ${sentimentLine}`,
    sceneLine ? `- Scene variations (static_injections): ${sceneLine}` : null,
    `- Memory system: ${memory ? 'yes — include memory_recall section and configure memory' : 'no'}`,
    `- Additional sections: ${allExtras.length ? allExtras.filter(e => e !== 'static_injections').join(', ') || 'none' : 'none'}`,
  ].filter(l => l !== null);

  if (notes) lines.push('', `Additional notes: ${notes}`);

  const memorySteps = memory
    ? [
        '',
        'Memory system is enabled. After the base build steps, complete ALL of the following memory wiring steps without stopping:',
        '1. Add a memory_recall section item: id="recall", text="{memory_recall}", template_vars=["memory_recall"].',
        '2. Update prompt_endings item text to include {system_summary} and {rule_ending} — format: "{system_summary}\\n\\n{rule_ending}\\n" followed by the chat prefix (e.g. "you say:"). Add template_vars ["system_summary", "rule_ending"] to the prompt_endings section.',
        '3. Include memory_recall.text in the assembly order immediately before output_prompt_directions — so the model reads recalled context before it reads the output instructions. Correct order: [..., sentiment.text, memory_recall.text, output_prompt_directions.text, prompt_endings.endings].',
        '4. Call registry.memory.configure with appropriate settings for the scenario.',
        '5. Call registry.classifier_rule.add for each sentiment item, mapping each tag to the correct emotional response.',
        '6. Validate and export.',
      ]
    : [];

  lines.push(
    '',
    `The user has confirmed all steps. Proceed through the full build sequence without stopping to ask for confirmation at each step: create draft, set meta, add all section items with real descriptive content, set assembly order, set generation params.${memory ? ' Then complete all memory wiring steps listed above.' : ' Validate and export when done.'}`,
    ...memorySteps,
  );

  const text = lines.join('\n');

  removeWelcome();
  addMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });
  runChat();
}

function addMessage(role, text) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `cb-msg ${role}`;
  div.innerHTML = `
    <span class="cb-msg-role">${role === 'user' ? 'You' : 'Assistant'}</span>
    <div class="cb-msg-body">${escHtml(text)}</div>
  `;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function setMessageText(el, text) {
  const body = el.querySelector('.cb-msg-body');
  if (body) body.textContent = text;
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
}

function addThinking() {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'cb-thinking';
  div.innerHTML = `
    <div class="cb-thinking-dots">
      <span></span><span></span><span></span>
    </div>
    <span style="font-size:11px;color:var(--muted)">Thinking…</span>
  `;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function addErrorBubble(msg) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'cb-msg assistant';
  div.innerHTML = `
    <span class="cb-msg-role" style="color:var(--error)">Error</span>
    <div class="cb-msg-body" style="border-color:rgba(196,88,88,0.3);color:var(--error)">${escHtml(msg)}</div>
  `;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function removeEl(el) {
  el?.parentNode?.removeChild(el);
}

function setInputEnabled(enabled) {
  document.getElementById('user-input').disabled = !enabled;
  document.getElementById('send-btn').disabled   = !enabled;
  document.getElementById('send-label').textContent = enabled ? 'Send' : '…';
}

function updateDraftBadge(id) {
  const badge = document.getElementById('draft-id-badge');
  badge.hidden = false;
  document.getElementById('draft-id-display').textContent = id;
}

// ── export ─────────────────────────────────────────────────────────────────

async function doExport() {
  if (!draftId) return;
  try {
    let serverRegistry = null;
    const resp = await fetch(`/api/builder/draft/${draftId}/export`, { method: 'POST' });
    if (resp.ok) {
      const serverData = await resp.json();
      serverRegistry = serverData.registry || null;
    }
    // Build registry from client-side regState, patching in any richer server data.
    // The client mirrors every successful tool call result, so it's the reliable
    // source when the server draft ID drifts (e.g. model called draft.create twice).
    const registry = _buildClientRegistry(serverRegistry);

    // Build state block from draftState.
    const stateBlock = _buildStateBlock();

    // Assemble final export matching the Builder file format.
    const slug = (regState.title || 'registry').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const out = {
      name: slug,
      savedAt: new Date().toISOString(),
      registry,
      state: stateBlock,
    };

    lastExportJSON = JSON.stringify(out, null, 2);
    document.getElementById('export-pre').textContent = lastExportJSON;
    document.getElementById('export-modal').hidden = false;
  } catch (err) {
    addErrorBubble(`Export failed: ${err.message}`);
  }
}

function _buildStateBlock() {
  const stateBlock = {};
  const allSecs = new Set([...Object.keys(draftState), ...Object.keys(regState.sections)]);
  for (const sec of allSecs) {
    const st = draftState[sec];
    const entry = {};
    if (st) {
      const selected = validSelectedForSection(sec, st.selected);
      if (selected !== null && selected !== undefined) entry.selected = selected;
      if (st.slider !== null && st.slider !== undefined) entry.slider = st.slider;
      if (st.array_modes && Object.keys(st.array_modes).length) {
        entry.array_modes = {};
        for (const [k, v] of Object.entries(st.array_modes)) entry.array_modes[k] = v;
      }
    }
    // Include template_vars for this section, using stored draftState values with empty-string fallback.
    const vars = regState.sections[sec]?.vars || [];
    const storedTvars = st?.template_vars || {};
    if (vars.length) {
      entry.template_vars = {};
      for (const v of vars) entry.template_vars[v] = storedTvars[v] ?? '';
    }
    if (Object.keys(entry).length) stateBlock[sec] = entry;
  }
  return stateBlock;
}

function _buildClientRegistry(serverRegistry) {
  const REQUIRED = new Set(['base_context', 'personas', 'sentiment', 'output_prompt_directions', 'prompt_endings']);

  const reg = {
    version: 2,
    title: regState.title || serverRegistry?.title || '',
    description: regState.description || serverRegistry?.description || '',
    assembly_order: normalizeAssemblyOrder(regState.assembly.length ? regState.assembly : (serverRegistry?.assembly_order || [])),
  };

  // Include generation/output_policy/memory_config/memory_rules/style_blend from regState first,
  // falling back to server data.
  if (Object.keys(regState.generation).length) reg.generation = sanitizeGeneration(regState.generation);
  else if (serverRegistry?.generation && Object.keys(serverRegistry.generation).length) reg.generation = sanitizeGeneration(serverRegistry.generation);

  if (Object.keys(regState.output_policy).length) reg.output_policy = regState.output_policy;
  else if (serverRegistry?.output_policy && Object.keys(serverRegistry.output_policy).length) reg.output_policy = serverRegistry.output_policy;

  if (Object.keys(regState.style_blend).length) reg.style_blend = regState.style_blend;
  else if (serverRegistry?.style_blend && Object.keys(serverRegistry.style_blend).length) reg.style_blend = serverRegistry.style_blend;

  if (regState.memory_rules.length) reg.memory_rules = regState.memory_rules;
  else if (serverRegistry?.memory_rules?.length) reg.memory_rules = serverRegistry.memory_rules;

  if (Object.keys(regState.memory_config).length) reg.memory_config = regState.memory_config;
  else if (serverRegistry?.memory_config && Object.keys(serverRegistry.memory_config).length) reg.memory_config = serverRegistry.memory_config;

  // prompt_endings must always carry system_summary + rule_ending so the
  // memory runtime can inject emotional state / classifier ending_text.
  const memoryOn = Object.keys(reg.memory_config || {}).length > 0
    || (regState.memory_rules && regState.memory_rules.length > 0);
  const MEMORY_ENDING_VARS = ['system_summary', 'rule_ending'];

  // Build default_state from current draftState (mirrors the state block but lives inside registry).
  const defaultState = _buildStateBlock();
  // Ensure prompt_endings state block carries memory vars when memory is on.
  if (memoryOn) {
    if (!defaultState.prompt_endings) defaultState.prompt_endings = {};
    const tvs = defaultState.prompt_endings.template_vars || {};
    for (const v of MEMORY_ENDING_VARS) if (!(v in tvs)) tvs[v] = '';
    defaultState.prompt_endings.template_vars = tvs;
  }
  if (Object.keys(defaultState).length) reg.default_state = defaultState;

  // Sections: prefer server data when it has items (server has fragments/groups from add_fragment/add_group);
  // fall back to client regState when server section is empty.
  for (const key of Object.keys(regState.sections)) {
    const serverSec = serverRegistry?.[key] || {};
    const clientSec = regState.sections[key] || { vars: [], items: [] };
    const serverHasItems = (serverSec.items || []).length > 0;
    const clientHasItems = clientSec.items.length > 0;

    if (!serverHasItems && !clientHasItems && !REQUIRED.has(key)) continue;

    const secOut = { required: REQUIRED.has(key) };

    let vars = serverHasItems
      ? (serverSec.template_vars || clientSec.vars)
      : clientSec.vars;
    // Enforce memory vars in prompt_endings whenever memory is configured.
    if (key === 'prompt_endings' && memoryOn) {
      vars = [...new Set([...(vars || []), ...MEMORY_ENDING_VARS])];
    }
    if (vars && vars.length) secOut.template_vars = vars;

    const items = serverHasItems ? serverSec.items : clientSec.items;
    if (items && items.length) secOut.items = items;

    reg[key] = secOut;
  }

  return reg;
}

function closeExportModal() {
  document.getElementById('export-modal').hidden = true;
}

function saveToLibrary() {
  if (!lastExportJSON) return;
  let parsed;
  try { parsed = JSON.parse(lastExportJSON); } catch { return; }

  const defaultName = regState.title || parsed.name || 'Untitled Registry';
  const name = window.prompt('Save to library as:', defaultName);
  if (!name) return;

  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch {}

  // Include state so the Builder can restore selection/slider defaults.
  const snap = {
    name,
    savedAt: new Date().toISOString(),
    registry: parsed.registry,
    state: parsed.state || {},
  };

  const existing = snaps.findIndex(s => s.name === name);
  if (existing >= 0) snaps[existing] = snap;
  else snaps.push(snap);

  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snaps));
    // Brief visual confirmation in the modal subtitle.
    const sub = document.querySelector('.cb-modal-sub');
    if (sub) {
      const prev = sub.textContent;
      sub.textContent = `Saved as "${name}" — open Builder to load it.`;
      sub.style.color = 'var(--green)';
      setTimeout(() => { sub.textContent = prev; sub.style.color = ''; }, 3000);
    }
  } catch (e) {
    alert('localStorage write failed: ' + e.message);
  }
}

function copyExport() {
  navigator.clipboard.writeText(lastExportJSON).catch(() => {});
}

// ── load from library ──────────────────────────────────────────────────────

function openLoadModal() {
  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch {}

  const list = document.getElementById('load-list');
  list.innerHTML = '';

  if (!snaps.length) {
    list.innerHTML = '<p class="cb-load-empty">No saved registries yet. Build one and use Save to Library.</p>';
  } else {
    for (const snap of [...snaps].reverse()) {
      const row = document.createElement('div');
      row.className = 'cb-load-row';
      const date = snap.savedAt ? new Date(snap.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const secCount = Object.keys(snap.registry || {}).filter(k => {
        const v = snap.registry[k];
        return !META_KEYS.has(k) && v && typeof v === 'object' && Array.isArray(v.items);
      }).length;
      row.innerHTML = `
        <div class="cb-load-row-main">
          <span class="cb-load-name">${escHtml(snap.name || 'Untitled')}</span>
          <span class="cb-load-meta">${secCount} section${secCount !== 1 ? 's' : ''} · ${date}</span>
        </div>
        <button type="button" class="primary-btn-sm cb-load-btn">Load</button>
      `;
      row.querySelector('.cb-load-btn').onclick = () => {
        loadRegistrySnap(snap);
        closeLoadModal();
      };
      list.appendChild(row);
    }
  }

  document.getElementById('load-modal').hidden = false;
}

function closeLoadModal() {
  document.getElementById('load-modal').hidden = true;
}

function loadRegistrySnap(snap) {
  // extract the inner registry object (handles both {registry:{...}} and bare registry)
  const reg = (snap.registry && snap.registry.registry) ? snap.registry.registry : (snap.registry || {});

  // reset all state first (rebuilds section cards too)
  resetConversation();
  removeWelcome();

  // populate top-level regState
  regState.title       = reg.title || '';
  regState.description = reg.description || '';
  regState.assembly    = reg.assembly_order || [];
  regState.generation  = reg.generation || {};
  regState.output_policy = reg.output_policy || {};
  regState.memory_config = reg.memory_config || {};
  regState.style_blend   = reg.style_blend || {};
  regState.memory_rules  = reg.memory_rules || [];

  // populate all section keys found in the registry (any non-meta key with an items array)
  for (const [key, val] of Object.entries(reg)) {
    if (META_KEYS.has(key)) continue;
    if (!val || typeof val !== 'object' || !Array.isArray(val.items)) continue;
    regState.sections[key] = {
      vars:  val.template_vars || [],
      items: val.items || [],
    };
  }

  buildSectionGrid();

  for (const key of Object.keys(regState.sections)) {
    refreshSectionItems(key);
    refreshSectionVars(key);
  }

  // populate draftState from snap.state or registry default_state
  const stateBlock = snap.state || reg.default_state || {};
  for (const [sec, st] of Object.entries(stateBlock)) {
    if (!st || typeof st !== 'object') continue;
    draftState[sec] = {
      selected:      st.selected    ?? null,
      array_modes:   st.array_modes || {},
      slider:        st.slider      ?? null,
      template_vars: st.template_vars && typeof st.template_vars === 'object' ? { ...st.template_vars } : {},
    };
  }

  // update overview DOM
  setRegTitle(regState.title);
  setRegDesc(regState.description);
  renderAssemblyOrder();
  renderExtras();

  // enable export
  document.getElementById('export-btn').disabled = false;

  // post a system note in the chat
  addMessage('assistant', `Registry "${regState.title || 'Untitled'}" loaded. Describe what you'd like to change and I'll help you update it.`);

  // import into a server draft so tool calls work, then inject context for the model
  _importRegistryDraft(reg);
}

async function _importRegistryDraft(reg) {
  try {
    const resp = await fetch('/api/builder/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registry: reg }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.draft_id) {
      draftId = data.draft_id;
      updateDraftBadge(draftId);
      document.getElementById('export-btn').disabled = false;
    }
  } catch {}

  // inject a context summary into conversation history so the model knows the registry contents
  const lines = [
    `[Registry loaded — current state for your reference]`,
    `Title: "${regState.title || 'Untitled'}"`,
    `Draft ID: ${draftId || '(pending)'}`,
    `Assembly order: ${regState.assembly.join(' → ') || '(none)'}`,
    '',
    'Sections:',
  ];
  for (const [key, sec] of Object.entries(regState.sections)) {
    const label = SECTION_LABELS[key] || key;
    const itemSummaries = sec.items.map(item => {
      const id = item.id || item.name || '?';
      const content = item.text || item.context || '';
      return `    - ${id}: "${content.slice(0, 100)}${content.length > 100 ? '…' : ''}"`;
    });
    lines.push(`  ${label} (${sec.items.length} item${sec.items.length !== 1 ? 's' : ''}):`);
    lines.push(...itemSummaries);
  }
  lines.push('', 'Make targeted edits using the builder tools. Do not recreate the registry from scratch.');

  conversationHistory.push({ role: 'user', content: lines.join('\n') });
  conversationHistory.push({ role: 'assistant', content: `Got it — I can see the full registry. What would you like to change?` });
}

function downloadExport() {
  const name = (regState.title || 'registry').toLowerCase().replace(/\s+/g, '_') + '.json';
  const blob = new Blob([lastExportJSON], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ── reset ──────────────────────────────────────────────────────────────────

function resetConversation() {
  draftId = null;
  conversationHistory = [];
  lastExportJSON = '';
  builderSession = null;

  // reset regState and draftState
  regState.title = ''; regState.description = '';
  Object.keys(draftState).forEach(k => delete draftState[k]);
  regState.assembly = []; regState.generation = {};
  regState.output_policy = {}; regState.memory_config = {};
  regState.style_blend = {}; regState.memory_rules = [];
  Object.keys(regState.sections).forEach(k => delete regState.sections[k]);

  // close detail view if open
  closeSectionDetail();

  // reset DOM
  document.getElementById('messages').innerHTML = _intakeCardHTML();
  document.getElementById('draft-id-badge').hidden = true;
  document.getElementById('export-btn').disabled = true;
  document.getElementById('reg-title').textContent = 'Untitled';
  document.getElementById('reg-title').classList.remove('populated');
  document.getElementById('reg-desc').textContent = 'No description yet.';
  document.getElementById('assembly-row').hidden = true;
  document.getElementById('assembly-tokens').innerHTML = '';
  document.getElementById('extras-row').innerHTML = '';
  document.getElementById('activity-list').innerHTML = '<span class="cb-activity-empty">No tool calls yet</span>';
  buildSectionGrid();
  document.getElementById('user-input').focus();
}

// ── keyboard ───────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeExportModal();
  }
});

// ── util ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
