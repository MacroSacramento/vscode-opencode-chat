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
let variantItems = [];
let variantIndex = -1;
// Live model-menu search filter (cleared whenever the menu closes).
let modelQuery = '';

// ── Agent / model pickers ───────────────────────────────────────────────

function formatModel(model) {
  if (!model) {
    return '';
  }
  return model.modelID;
}

// Updates EVERY pane's agent/model badges and usage line from its own
// per-session state. Each pane's badges show that session's agent/model, so
// this iterates all panes rather than just the focused one. Null-safe: no
// panes (or a pane missing a badge) is fine.
export function updateMetaBadges() {
  const can = state.connected;
  document.querySelectorAll('.chat-pane').forEach(function (p) {
    const pane = /** @type {HTMLElement} */ (p);
    const sid = pane.dataset.sessionId;
    const agent = sid ? state.paneAgent[sid] : null;
    const model = sid ? state.paneModel[sid] : null;
    const usage = sid ? state.paneUsage[sid] : null;

    const agentBtn = /** @type {HTMLButtonElement | null} */ (pane.querySelector('#agentPickerBtn'));
    const modelBtn = /** @type {HTMLButtonElement | null} */ (pane.querySelector('#modelPickerBtn'));
    const variantBtn = /** @type {HTMLButtonElement | null} */ (pane.querySelector('#variantPickerBtn'));
    const agentValue = /** @type {HTMLElement | null} */ (pane.querySelector('#agentBadgeValue'));
    const modelValue = /** @type {HTMLElement | null} */ (pane.querySelector('#modelBadgeValue'));
    const variantValue = /** @type {HTMLElement | null} */ (pane.querySelector('#variantBadgeValue'));
    const usageLine = /** @type {HTMLElement | null} */ (pane.querySelector('#contextUsageLine'));

    if (agentBtn) {
      agentBtn.disabled = !can || !sid;
    }
    if (modelBtn) {
      modelBtn.disabled = !can || !sid;
    }
    if (agentValue) {
      const defaultAgent = state.catalog && state.catalog.defaultAgent;
      agentValue.textContent = agent ? agent : defaultAgent || 'default';
      if (agentBtn) {
        agentBtn.title = 'Agent: ' + (agent || defaultAgent || 'default');
      }
    }
    let modelText = model ? formatModel(model) : '';
    if (!modelText && state.catalog && state.catalog.defaultModel) {
      modelText = state.catalog.defaultModel.modelID;
    }
    if (modelValue) {
      modelValue.textContent = modelText || 'default';
      if (modelBtn) {
        modelBtn.title = 'Model: ' + (modelText || 'default');
      }
    }
    // Variant badge: enabled only when the current model declares variants.
    // The catalog entry is matched by providerID+modelID; the badge shows the
    // session's variant (or 'default' when unset). A new session has no model
    // yet, so fall back to the server's default model to decide visibility.
    const effectiveModel = model || (state.catalog && state.catalog.defaultModel) || null;
    let hasVariants = false;
    if (effectiveModel && state.catalog && Array.isArray(state.catalog.models)) {
      const entry = state.catalog.models.find(function (m) {
        return m.providerID === effectiveModel.providerID && m.modelID === effectiveModel.modelID;
      });
      hasVariants = !!(entry && Array.isArray(entry.variants) && entry.variants.length > 0);
    }
    if (variantBtn) {
      variantBtn.disabled = !can || !sid || !hasVariants;
      // Hide the badge entirely when the model has no variants — a disabled
      // "variant: default" badge is noise for a control that can't do anything.
      const wrap = /** @type {HTMLElement | null} */ (variantBtn.closest('.meta-badge-wrap'));
      if (wrap) {
        wrap.hidden = !hasVariants;
      }
    }
    if (variantValue) {
      const variant = sid ? state.paneVariant[sid] : null;
      variantValue.textContent = variant ? variant : 'default';
      if (variantBtn) {
        variantBtn.title = 'Variant: ' + (variant || 'default');
      }
    }
    renderUsageLine(usageLine, usage);
  });
}

// Context usage descriptor: a muted caption under the composer bar. Shows
// tokens in context, % of the context window (when the model reports a
// limit), and cost in dollars.
function renderUsageLine(line, usage) {
  if (!line) {
    return;
  }
  if (!usage) {
    line.hidden = true;
    line.textContent = '';
    return;
  }
  const tokens = typeof usage.contextTokens === 'number' && isFinite(usage.contextTokens) ? usage.contextTokens : 0;
  const cost = typeof usage.cost === 'number' && isFinite(usage.cost) ? usage.cost : 0;
  const limit = typeof usage.contextLimit === 'number' && isFinite(usage.contextLimit) && usage.contextLimit > 0 ? usage.contextLimit : null;

  const bits = ['Context: ' + formatCount(tokens) + ' tokens'];
  if (limit !== null) {
    bits.push(Math.round((tokens / limit) * 100) + '% used');
  }
  bits.push('$' + cost.toFixed(2) + ' spent');

  line.textContent = bits.join(' \u00b7 ');
  line.hidden = false;
}

// ── Thinking toggle ─────────────────────────────────────────────────────

// Thinking is a global preference — reflect it on EVERY pane's toggle (the
// per-pane IDs are not globally unique, so iterate all panes). Null-safe.
export function updateThinkingToggle() {
  document.querySelectorAll('.chat-pane #thinkingToggle').forEach(function (btn) {
    const el = /** @type {HTMLElement} */ (btn);
    el.classList.toggle('on', state.showThinking);
    el.setAttribute('aria-pressed', state.showThinking ? 'true' : 'false');
    el.title = state.showThinking ? 'Hide model thinking' : 'Show model thinking';
    const value = /** @type {HTMLElement | null} */ (el.querySelector('#thinkingToggleValue'));
    if (value) {
      value.textContent = state.showThinking ? 'on' : 'off';
    }
  });
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
  if (!state.agentMenu) {
    return;
  }
  state.agentMenu.textContent = '';
  agentItems = [];
  const currentAgent = state.paneAgent[state.activeSessionId];
  const agents = (state.catalog && state.catalog.agents) || [];
  if (agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    // Catalog load is async — "Loading…" while it's still in flight, so a
    // fresh session doesn't flash a misleading "No agents available".
    empty.textContent = state.catalog ? 'No agents available' : 'Loading\u2026';
    state.agentMenu.appendChild(empty);
    return;
  }
  agents.forEach(function (a) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.agent = a.name;

    if (a.name === currentAgent) {
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
    return it.name === currentAgent;
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
  if (!state.agentMenu) {
    return;
  }
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
  if (state.agentMenu) {
    state.agentMenu.hidden = true;
  }
}

export function selectAgent(name) {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return;
  }
  state.paneAgent[sessionId] = name;
  updateMetaBadges();
  closeAgentMenu();
  post({ type: 'setAgent', sessionId: sessionId, agent: name });
  if (state.input) {
    state.input.focus();
  }
}

export function renderModelMenu() {
  if (!state.modelMenu) {
    return;
  }
  state.modelMenu.textContent = '';
  modelFlat = [];
  const currentModel = state.paneModel[state.activeSessionId];
  const models = (state.catalog && state.catalog.models) || [];
  if (models.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = state.catalog ? 'No models available' : 'Loading\u2026';
    state.modelMenu.appendChild(empty);
    return;
  }
  // Search bar — only rendered when there are models to filter. Rebuilt on
  // every render; the input handler re-renders + refocuses so typing stays
  // live without losing focus to the re-created input.
  const search = document.createElement('input');
  search.className = 'menu-search';
  search.type = 'text';
  search.placeholder = 'Search models\u2026';
  search.spellcheck = false;
  search.value = modelQuery;
  search.addEventListener('input', function () {
    modelQuery = search.value;
    renderModelMenu();
    const fresh = state.modelMenu && state.modelMenu.querySelector('.menu-search');
    if (fresh) {
      fresh.focus();
      try {
        fresh.setSelectionRange(fresh.value.length, fresh.value.length);
      } catch (e) {
        // Non-text inputs can throw on setSelectionRange — best-effort only.
      }
    }
  });
  state.modelMenu.appendChild(search);

  // Filter against modelID, providerName, and modelName (case-insensitive
  // substring). Empty/whitespace query shows everything.
  const q = modelQuery.trim().toLowerCase();
  const groups = [];
  const groupMap = {};
  models.forEach(function (m) {
    if (q) {
      const hay = (m.modelID + ' ' + (m.providerName || '') + ' ' + (m.modelName || '')).toLowerCase();
      if (hay.indexOf(q) === -1) {
        return;
      }
    }
    let group = groupMap[m.providerID];
    if (!group) {
      group = { providerID: m.providerID, providerName: m.providerName, items: [] };
      groupMap[m.providerID] = group;
      groups.push(group);
    }
    group.items.push(m);
  });
  if (groups.length === 0) {
    // Query filtered everything out — distinct from "No models available"
    // (no catalog models at all).
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No models match';
    state.modelMenu.appendChild(empty);
    return;
  }
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

      const isCurrent = currentModel && currentModel.providerID === group.providerID && currentModel.modelID === m.modelID;
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
    return currentModel && it.providerID === currentModel.providerID && it.modelID === currentModel.modelID;
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

// Focuses the model menu's search input (falling back to the menu itself) so
// the user can type immediately after open or re-render.
export function focusModelSearch() {
  if (!state.modelMenu) {
    return;
  }
  const search = state.modelMenu.querySelector('.menu-search');
  if (search) {
    search.focus();
  } else {
    state.modelMenu.focus();
  }
}

export function openModelMenu() {
  if (!state.modelMenu) {
    return;
  }
  closeSlashPopup();
  closeAgentMenu();
  if (!state.catalog) {
    post({ type: 'getCatalog' });
  }
  renderModelMenu();
  state.modelMenu.hidden = false;
  focusModelSearch();
  highlightModelItem();
}

export function closeModelMenu() {
  if (state.modelMenu) {
    state.modelMenu.hidden = true;
  }
  // Clear the search so reopening starts fresh.
  modelQuery = '';
}

// Clears the model search filter and re-renders the full list, keeping the
// menu open and the search input focused. Wired to the first Escape press;
// a second Escape (with an empty search) closes the menu.
export function clearModelSearch() {
  modelQuery = '';
  renderModelMenu();
  focusModelSearch();
}

export function selectModel(providerID, modelID) {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return;
  }
  state.paneModel[sessionId] = { providerID: providerID, modelID: modelID };
  updateMetaBadges();
  closeModelMenu();
  post({ type: 'setModel', sessionId: sessionId, providerID: providerID, modelID: modelID });
  if (state.input) {
    state.input.focus();
  }
}

// ── Variant picker ───────────────────────────────────────────────────────
// Variants are reasoning-effort levels (high/low/max/minimal) declared per
// model. The menu is flat (no provider groups) and lists the current model's
// variants; selecting one posts `setVariant` (empty string clears → default).

function currentModelVariants() {
  // A new session has no explicit model yet — fall back to the server's
  // default model so the variant menu isn't empty on first load (matches the
  // effective-model logic in updateMetaBadges).
  const currentModel = state.paneModel[state.activeSessionId] || (state.catalog && state.catalog.defaultModel) || null;
  if (!currentModel || !state.catalog || !Array.isArray(state.catalog.models)) {
    return [];
  }
  const entry = state.catalog.models.find(function (m) {
    return m.providerID === currentModel.providerID && m.modelID === currentModel.modelID;
  });
  return entry && Array.isArray(entry.variants) ? entry.variants : [];
}

export function renderVariantMenu() {
  if (!state.variantMenu) {
    return;
  }
  state.variantMenu.textContent = '';
  variantItems = [];
  const currentVariant = state.paneVariant[state.activeSessionId];
  const variants = currentModelVariants();
  if (variants.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = state.catalog ? 'No variants' : 'Loading\u2026';
    state.variantMenu.appendChild(empty);
    return;
  }
  // "default" (no variant / base behavior) is always selectable so a chosen
  // variant can be cleared again.
  const defaultRow = document.createElement('div');
  defaultRow.className = 'menu-item';
  defaultRow.dataset.variant = 'default';
  if (!currentVariant) {
    const check = document.createElement('span');
    check.className = 'menu-check';
    check.textContent = '\u2713';
    defaultRow.appendChild(check);
  }
  const defaultName = document.createElement('span');
  defaultName.className = 'menu-name';
  defaultName.textContent = 'default';
  defaultRow.appendChild(defaultName);
  state.variantMenu.appendChild(defaultRow);
  variantItems.push({ variant: 'default', row: defaultRow });

  variants.forEach(function (v) {
    const row = document.createElement('div');
    row.className = 'menu-item';
    row.dataset.variant = v;

    if (v === currentVariant) {
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.textContent = '\u2713';
      row.appendChild(check);
    }

    const name = document.createElement('span');
    name.className = 'menu-name';
    name.textContent = v;
    row.appendChild(name);

    state.variantMenu.appendChild(row);
    variantItems.push({ variant: v, row: row });
  });
  const current = variantItems.findIndex(function (it) {
    return it.variant === (currentVariant || 'default');
  });
  variantIndex = current >= 0 ? current : 0;
}

function highlightVariantItem() {
  variantItems.forEach(function (it) {
    it.row.classList.toggle('active', it === variantItems[variantIndex]);
  });
  const row = variantItems[variantIndex] && variantItems[variantIndex].row;
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
  }
}

export function openVariantMenu() {
  if (!state.variantMenu) {
    return;
  }
  closeSlashPopup();
  closeAgentMenu();
  closeModelMenu();
  if (!state.catalog) {
    post({ type: 'getCatalog' });
  }
  renderVariantMenu();
  state.variantMenu.hidden = false;
  state.variantMenu.focus();
  highlightVariantItem();
}

export function closeVariantMenu() {
  if (state.variantMenu) {
    state.variantMenu.hidden = true;
  }
}

export function selectVariant(variant) {
  const sessionId = state.activeSessionId;
  if (!sessionId) {
    return;
  }
  if (variant === '' || variant === 'default') {
    delete state.paneVariant[sessionId];
  } else {
    state.paneVariant[sessionId] = variant;
  }
  updateMetaBadges();
  closeVariantMenu();
  // The host treats '' as "clear"; 'default' is a menu label, not a real
  // variant — normalize it so the server never receives a bogus variant.
  post({ type: 'setVariant', sessionId: sessionId, variant: variant === 'default' ? '' : variant });
  if (state.input) {
    state.input.focus();
  }
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

export function moveVariantIndex(delta) {
  if (variantItems.length > 0) {
    variantIndex = (variantIndex + delta + variantItems.length) % variantItems.length;
    highlightVariantItem();
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

export function selectCurrentVariant() {
  const item = variantItems[variantIndex];
  if (item) {
    selectVariant(item.variant);
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
