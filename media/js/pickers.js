import { state } from './state.js';
import { post, maybeScrollBottom } from './utils.js';
import { updateLiveThinking } from './streaming.js';
import { closeSlashPopup, NATIVE_COMMANDS } from './composer.js';
import { formatCount } from './parts.js';

// Picker menu navigation state.
let agentItems = [];
let agentIndex = -1;
let modelFlat = [];
let modelIndex = -1;

// ── Agent / model pickers ───────────────────────────────────────────────

function formatModel(model) {
  if (!model) {
    return '';
  }
  return model.modelID;
}

export function updateMetaBadges() {
  const can = state.connected && state.activeSessionId !== null;
  state.agentPickerBtn.disabled = !can;
  state.modelPickerBtn.disabled = !can;
  state.agentBadgeValue.textContent = state.agent ? state.agent : 'default';
  state.agentPickerBtn.title = 'Agent: ' + (state.agent || 'default');
  let modelText = state.model ? formatModel(state.model) : '';
  if (!modelText && state.catalog && state.catalog.defaultModel) {
    modelText = state.catalog.defaultModel.modelID;
  }
  state.modelBadgeValue.textContent = modelText || 'default';
  state.modelPickerBtn.title = 'Model: ' + (modelText || 'default');
  renderUsageLine();
}

// Context usage descriptor: a muted caption under the composer bar. Shows
// tokens in context, % of the context window (when the model reports a
// limit), and cost in dollars.
function renderUsageLine() {
  const line = state.contextUsageLine;
  if (!state.usage) {
    line.hidden = true;
    line.textContent = '';
    return;
  }
  const tokens = typeof state.usage.contextTokens === 'number' && isFinite(state.usage.contextTokens) ? state.usage.contextTokens : 0;
  const cost = typeof state.usage.cost === 'number' && isFinite(state.usage.cost) ? state.usage.cost : 0;
  const limit = typeof state.usage.contextLimit === 'number' && isFinite(state.usage.contextLimit) && state.usage.contextLimit > 0 ? state.usage.contextLimit : null;

  const bits = ['Context: ' + formatCount(tokens) + ' tokens'];
  if (limit !== null) {
    bits.push(Math.round((tokens / limit) * 100) + '% used');
  }
  bits.push('$' + cost.toFixed(2) + ' spent');

  line.textContent = bits.join(' \u00b7 ');
  line.hidden = false;
}

// ── Thinking toggle ─────────────────────────────────────────────────────

export function updateThinkingToggle() {
  state.thinkingToggle.classList.toggle('on', state.showThinking);
  state.thinkingToggle.setAttribute('aria-pressed', state.showThinking ? 'true' : 'false');
  state.thinkingToggle.title = state.showThinking ? 'Hide model thinking' : 'Show model thinking';
  state.thinkingToggleValue.textContent = state.showThinking ? 'on' : 'off';
}

export function toggleThinking() {
  state.showThinking = !state.showThinking;
  try {
    localStorage.setItem('opencodeChat.showThinking', state.showThinking ? '1' : '0');
  } catch (e) {
    // Storage can be unavailable in some webview contexts — the toggle must
    // still work; persistence is best-effort only.
  }
  updateThinkingToggle();
  // Completed reasoning details: open when the flag is on, collapsed when
  // off (existing default). Applied live so no reload is needed.
  document.querySelectorAll('.reasoning:not(.reasoning-live)').forEach(function (details) {
    details.open = state.showThinking;
  });
  // Pending bubble: reveal (or hide) the accumulated live reasoning.
  const stream = state.conversation.querySelector('[data-part="stream"]');
  if (stream) {
    updateLiveThinking(stream);
  }
  maybeScrollBottom();
}

export function renderAgentMenu() {
  state.agentMenu.textContent = '';
  agentItems = [];
  const agents = (state.catalog && state.catalog.agents) || [];
  if (agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No agents available';
    state.agentMenu.appendChild(empty);
    return;
  }
  agents.forEach(function (a) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.agent = a.name;

    if (a.name === state.agent) {
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = '\u2713';
      row.appendChild(check);
    }

    const name = document.createElement('span');
    name.className = 'menu-name';
    name.textContent = a.name;
    row.appendChild(name);

    if (a.description) {
      const desc = document.createElement('span');
      desc.className = 'menu-desc';
      desc.textContent = a.description;
      row.appendChild(desc);
    }

    state.agentMenu.appendChild(row);
    agentItems.push({ name: a.name, row: row });
  });
  const current = agentItems.findIndex(function (it) {
    return it.name === state.agent;
  });
  agentIndex = current >= 0 ? current : 0;
}

function highlightAgentItem() {
  agentItems.forEach(function (it) {
    it.row.classList.toggle('active', it === agentItems[agentIndex]);
  });
  const row = agentItems[agentIndex] && agentItems[agentIndex].row;
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
  }
}

export function openAgentMenu() {
  closeSlashPopup();
  closeModelMenu();
  if (!state.catalog) {
    post({ type: 'getCatalog' });
  }
  renderAgentMenu();
  state.agentMenu.hidden = false;
  state.agentMenu.focus();
  highlightAgentItem();
}

export function closeAgentMenu() {
  state.agentMenu.hidden = true;
}

export function selectAgent(name) {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return;
  }
  state.agent = name;
  updateMetaBadges();
  closeAgentMenu();
  post({ type: 'setAgent', sessionId: sessionId, agent: name });
  state.input.focus();
}

export function renderModelMenu() {
  state.modelMenu.textContent = '';
  modelFlat = [];
  const models = (state.catalog && state.catalog.models) || [];
  if (models.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No models available';
    state.modelMenu.appendChild(empty);
    return;
  }
  const groups = [];
  const groupMap = {};
  models.forEach(function (m) {
    let group = groupMap[m.providerID];
    if (!group) {
      group = { providerID: m.providerID, providerName: m.providerName, items: [] };
      groupMap[m.providerID] = group;
      groups.push(group);
    }
    group.items.push(m);
  });
  groups.forEach(function (group) {
    const header = document.createElement('div');
    header.className = 'menu-group';
    header.textContent = group.providerName || group.providerID;
    state.modelMenu.appendChild(header);

    group.items.forEach(function (m) {
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.dataset.provider = group.providerID;
      row.dataset.model = m.modelID;

      const isCurrent = state.model && state.model.providerID === group.providerID && state.model.modelID === m.modelID;
      if (isCurrent) {
        const check = document.createElement('span');
        check.className = 'menu-check';
        check.textContent = '\u2713';
        row.appendChild(check);
      }

      const name = document.createElement('span');
      name.className = 'menu-name';
      name.textContent = m.modelID;
      row.appendChild(name);

      state.modelMenu.appendChild(row);
      modelFlat.push({ providerID: group.providerID, modelID: m.modelID, row: row });
    });
  });
  const current = modelFlat.findIndex(function (it) {
    return state.model && it.providerID === state.model.providerID && it.modelID === state.model.modelID;
  });
  modelIndex = current >= 0 ? current : 0;
}

function highlightModelItem() {
  modelFlat.forEach(function (it) {
    it.row.classList.toggle('active', it === modelFlat[modelIndex]);
  });
  const row = modelFlat[modelIndex] && modelFlat[modelIndex].row;
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
  }
}

export function openModelMenu() {
  closeSlashPopup();
  closeAgentMenu();
  if (!state.catalog) {
    post({ type: 'getCatalog' });
  }
  renderModelMenu();
  state.modelMenu.hidden = false;
  state.modelMenu.focus();
  highlightModelItem();
}

export function closeModelMenu() {
  state.modelMenu.hidden = true;
}

export function selectModel(providerID, modelID) {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return;
  }
  state.model = { providerID: providerID, modelID: modelID };
  updateMetaBadges();
  closeModelMenu();
  post({ type: 'setModel', sessionId: sessionId, providerID: providerID, modelID: modelID });
  state.input.focus();
}

// Keyboard navigation helpers for the picker menus (wired from app.js).
// They own the module-scope `agentIndex`/`modelIndex` state, which app.js
// can read but not reassign across the ESM boundary.

export function moveAgentIndex(delta) {
  if (agentItems.length > 0) {
    agentIndex = (agentIndex + delta + agentItems.length) % agentItems.length;
    highlightAgentItem();
  }
}

export function moveModelIndex(delta) {
  if (modelFlat.length > 0) {
    modelIndex = (modelIndex + delta + modelFlat.length) % modelFlat.length;
    highlightModelItem();
  }
}

export function selectCurrentAgent() {
  const item = agentItems[agentIndex];
  if (item) {
    selectAgent(item.name);
  }
}

export function selectCurrentModel() {
  const item = modelFlat[modelIndex];
  if (item) {
    selectModel(item.providerID, item.modelID);
  }
}

// ── Help overlay ─────────────────────────────────────────────────────────

export function showHelp() {
  const list = state.helpList;
  list.textContent = '';
  const rows = [];
  NATIVE_COMMANDS.forEach(function (c) {
    rows.push({ name: c.name, description: c.description, source: 'native' });
  });
  const catalog = state.catalog;
  if (catalog && Array.isArray(catalog.commands)) {
    catalog.commands.forEach(function (c) {
      rows.push({ name: c.name, description: c.description, source: c.source || 'command' });
    });
  }
  rows.forEach(function (r) {
    const row = document.createElement('div');
    row.className = 'slash-row';

    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = '/' + r.name;

    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = r.description || '';

    row.appendChild(name);
    row.appendChild(desc);
    list.appendChild(row);
  });
  state.helpOverlay.hidden = false;
  state.helpOverlay.focus();
}

export function closeHelp() {
  state.helpOverlay.hidden = true;
}
