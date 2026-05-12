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

// section keys discovered from the loaded registry that aren't in SECTION_KEYS
let extraSectionKeys = [];

let currentDetailSection = null; // section currently open in the detail panel

const SECTION_KEYS = [
  'base_context', 'personas', 'sentiment',
  'static_injections', 'runtime_injections', 'output_prompt_directions',
  ...(MEMORY_ENABLED ? ['memory_recall'] : []),
  'user_message', 'prompt_endings',
];

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
  personas: 'personas.context',
  sentiment: 'sentiment.context',
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

function buildSectionGrid() {
  const grid = document.getElementById('sections-grid');
  grid.innerHTML = '';
  for (const key of SECTION_KEYS) {
    regState.sections[key] = { vars: [], items: [] };
    const card = document.createElement('div');
    card.className = 'cb-section-card';
    card.id = `sec-card-${key}`;
    card.innerHTML = `
      <div class="cb-section-name">${SECTION_LABELS[key]}</div>
      <div class="cb-section-items" id="sec-items-${key}">
        <span class="cb-sec-empty">Empty</span>
      </div>
      <div class="cb-section-vars" id="sec-vars-${key}"></div>
    `;
    card.onclick = () => openSectionDetail(key);
    grid.appendChild(card);
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
        regState.sections[section].vars = template_vars;
        refreshSectionVars(section);
      }
      break;
    }

    case 'registry.section.add_item': {
      const { section, item } = result;
      if (section && item) {
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
    const textField = item.context !== undefined ? 'context' : 'text';
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

function normalizeAssemblyOrder(order) {
  return (order || []).map(token => ASSEMBLY_TOKEN_ALIASES[token] || token);
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
  const preview = item.context || item.text || '';
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
  chip.innerHTML = `
    <span class="cb-tool-dot"></span>
    <span class="cb-tool-name">${escHtml(name)}</span>
    ${argSummary ? `<span style="color:var(--muted)">${escHtml(argSummary)}</span>` : ''}
    <span class="${ok ? 'cb-tool-ok' : 'cb-tool-err'}">${ok ? '✓' : '✗'}</span>
  `;
  msgs.appendChild(chip);
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
  for (const key of [...SECTION_KEYS, ...extraSectionKeys]) {
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
      const secCount = Object.keys(snap.registry || {}).filter(k => SECTION_KEYS.includes(k)).length;
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

  // populate top-level regState
  regState.title       = reg.title || '';
  regState.description = reg.description || '';
  regState.assembly    = reg.assembly_order || [];
  regState.generation  = reg.generation || {};
  regState.output_policy = reg.output_policy || {};
  regState.memory_config = reg.memory_config || {};
  regState.style_blend   = reg.style_blend || {};
  regState.memory_rules  = reg.memory_rules || [];

  // detect registry section keys not in SECTION_KEYS and create cards for them
  const META_KEYS = new Set([
    'version', 'title', 'description', 'assembly_order', 'default_state',
    'generation', 'output_policy', 'memory_config', 'memory_rules', 'style_blend',
  ]);
  const knownKeys = new Set(SECTION_KEYS);
  extraSectionKeys = Object.keys(reg).filter(
    k => !META_KEYS.has(k) && !knownKeys.has(k) && reg[k] && typeof reg[k] === 'object' && Array.isArray(reg[k].items)
  );
  if (extraSectionKeys.length) {
    const grid = document.getElementById('sections-grid');
    for (const key of extraSectionKeys) {
      regState.sections[key] = { vars: [], items: [] };
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
      grid.appendChild(card);
    }
  }

  // populate sections (buildSectionGrid already reset them to empty)
  for (const key of [...SECTION_KEYS, ...extraSectionKeys]) {
    const sec = reg[key];
    if (!sec) continue;
    regState.sections[key] = {
      vars:  sec.template_vars || [],
      items: sec.items || [],
    };
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

  // post a system note in the chat so the user knows what was loaded
  addMessage('assistant', `Registry "${regState.title || 'Untitled'}" loaded. Describe what you'd like to change and I'll help you update it.`);
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
  extraSectionKeys = [];
  for (const k of SECTION_KEYS) regState.sections[k] = { vars: [], items: [] };

  // close detail view if open
  closeSectionDetail();

  // reset DOM
  document.getElementById('messages').innerHTML = `
    <div class="cb-welcome">
      <div class="cb-welcome-icon">✦</div>
      <p class="cb-welcome-head">Build a registry through conversation.</p>
      <p class="cb-welcome-sub">Describe the model you want to create — the assistant will ask the right questions and build the registry structure for you, one step at a time.</p>
    </div>
  `;
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
