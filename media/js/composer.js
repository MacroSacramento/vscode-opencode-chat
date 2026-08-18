import { state } from './state.js';
import { post, maybeScrollBottom, showToast } from './utils.js';
import { escapeHtml, linkify } from './markdown.js';
import { updateEmptyStates } from './sessions.js';
import { updateMetaBadges, openAgentMenu, openModelMenu, showHelp } from './pickers.js';
import { settleStoppedStream, finalizeLiveThinking, renderStreamNow } from './streaming.js';

// Built-in slash commands. `local: true` are handled entirely in the
// webview; the rest map to the host's `nativeCommand` protocol.
export const NATIVE_COMMANDS = [
  { name: 'sessions', description: 'Show session list', local: true },
  { name: 'skills', description: 'Filter commands to skills', local: true },
  { name: 'models', description: 'Pick a model', local: true },
  { name: 'agents', description: 'Pick an agent', local: true },
  { name: 'new', description: 'Start a new session', local: true },
  { name: 'help', description: 'List all commands', local: true },
  { name: 'undo', description: 'Revert the last assistant turn', local: false },
  { name: 'redo', description: 'Restore reverted turns', local: false },
  { name: 'diff', description: 'Review session file changes', local: false },
  { name: 'fork', description: 'Fork this session', local: false },
  { name: 'share', description: 'Create a share link', local: false },
  { name: 'abort', description: 'Stop the current response', local: false },
  { name: 'compact', description: 'Compact the conversation', local: false },
];

// Slash popup navigation state.
export let slashItems = [];
export let slashIndex = -1;
let slashFilter = '';
let slashSourceFilter = null;

// At-mention popup navigation state.
export let atItems = [];
export let atIndex = -1;
let atFilter = '';

// ── Connection / empty states / composer ─────────────────────────────────

export function updateComposerState() {
  const canType = state.connected;
  const textEmpty = state.input.value.trim() === '';
  const showStop = state.busy && !state.stopping;
  state.input.disabled = !canType;
  state.sendBtn.classList.toggle('busy', showStop);
  state.sendBtn.classList.toggle('stopping', state.stopping);
  // Send is gated on idle+text; the stop control stays clickable while a
  // stream runs. The brief "Stopping…" pill is disabled to prevent spam.
  state.sendBtn.disabled = !canType || state.stopping || (!showStop && textEmpty);
  if (showStop) {
    state.sendBtn.title = 'Stop (abort response)';
    state.sendBtn.setAttribute('aria-label', 'Stop');
  } else if (state.stopping) {
    state.sendBtn.title = 'Stopping\u2026';
    state.sendBtn.setAttribute('aria-label', 'Stopping');
  } else {
    state.sendBtn.title = 'Send (Enter)';
    state.sendBtn.setAttribute('aria-label', 'Send');
  }
  // First message with no session creates one — say so in the placeholder.
  state.input.placeholder = state.activeSessionId === null
    ? 'Ask OpenCode\u2026 (starts a new chat)'
    : 'Ask OpenCode\u2026';
  updateMetaBadges();
}

export function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('.message .typing').forEach(function (n) {
    n.hidden = true;
  });
  if (busy) {
    // A fresh stream is running — any prior stop state is stale.
    state.stopping = false;
    state.stoppedStream = false;
    const assistants = state.conversation.querySelectorAll('.message[data-role="assistant"]');
    if (assistants.length > 0) {
      const typing = assistants[assistants.length - 1].querySelector('.typing');
      if (typing) {
        typing.hidden = false;
      }
    }
  } else {
    // The stream settled. If this unwind was user-initiated, collapse the
    // pending bubble cleanly before finalizing reasoning.
    if (state.stopping) {
      settleStoppedStream();
      state.stopping = false;
    }
    // Stream finished — any live thinking block is now a settled thought.
    finalizeLiveThinking();
    // Reasoning is done: pin to the bottom so the answer (or final state)
    // is visible — only when the user is already at the bottom.
    maybeScrollBottom();
    // No more deltas are coming once the stream settles — flush any text
    // the render throttle skipped so the final answer is fully rendered.
    document.querySelectorAll('[data-part="stream"]').forEach(function (stream) {
      const acc = stream._accText || '';
      if (acc.length > (stream._lastRenderedLen || 0)) {
        renderStreamNow(stream, true);
      }
    });
    maybeScrollBottom();
  }
  updateComposerState();
}

// ── Composer ─────────────────────────────────────────────────────────────

export function autoGrow() {
  const input = state.input;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
}

// Inserts host-provided editor context (keybind) at the caret, or appends
// when the composer is not focused. Popups are closed first so the insert
// never lands inside an open menu.
export function insertContext(text, label) {
  if (typeof text !== 'string' || text === '') {
    return;
  }
  closeSlashPopup();
  closeAtPopup();
  const input = state.input;
  const focused = document.activeElement === input;
  const start = focused && input.selectionStart != null ? input.selectionStart : input.value.length;
  const end = focused && input.selectionEnd != null ? input.selectionEnd : start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  autoGrow();
  updateComposerState();
  if (typeof label === 'string' && label !== '') {
    showToast('Inserted ' + label);
  }
  input.focus();
}

export function send() {
  const text = state.input.value.trim();
  if (!state.connected || state.busy || !text) {
    return;
  }
  // Extract @-mentions typed at fresh positions (start of input or after
  // whitespace). Exact-match only: an agent name overrides the per-prompt
  // agent, known file paths are attached so the host can scope the prompt.
  // The picker inserts a trailing space, so `@src/foo.ts ` scans as the
  // token `src/foo.ts`. Emails like `foo@bar.com` never match anything.
  const files = [];
  let agent = null;
  const mentionRe = /(?:^|\s)@([^\s@]+)/g;
  const catalogAgents = (state.catalog && state.catalog.agents) || [];
  let m = mentionRe.exec(text);
  while (m !== null) {
    const token = m[1];
    for (let i = 0; i < catalogAgents.length; i++) {
      if (catalogAgents[i].name === token) {
        agent = token;
        break;
      }
    }
    if (Array.isArray(state.files)) {
      for (let j = 0; j < state.files.length; j++) {
        if (state.files[j].path === token && files.indexOf(token) === -1) {
          files.push(token);
          break;
        }
      }
    }
    m = mentionRe.exec(text);
  }
  if (state.activeSessionId) {
    post({
      type: 'prompt',
      sessionId: state.activeSessionId,
      text: text,
      ...(files.length ? { files: files } : {}),
      ...(agent ? { agent: agent } : {}),
    });
  } else {
    post({
      type: 'newSession',
      prompt: text,
      ...(files.length ? { files: files } : {}),
      ...(agent ? { agent: agent } : {}),
    });
  }
  state.input.value = '';
  autoGrow();
  updateComposerState();
}

// ── Stop control ─────────────────────────────────────────────────────────

// Swaps the composer button to a Stop control while a response streams.
// Posts the host's abort command; a brief disabled "Stopping…" state keeps
// the user from double-firing while the stream unwinds.
export function stop() {
  if (!state.connected || !state.busy || state.stopping || !state.activeSessionId) {
    return;
  }
  state.stopping = true;
  state.stoppedStream = true;
  post({ type: 'nativeCommand', sessionId: state.activeSessionId, command: 'abort' });
  updateComposerState();
}

// ── Slash command popup ──────────────────────────────────────────────────

// Matches a `/command rest` token: the slash must sit at the start of the
// input or after whitespace (a "fresh position").
function slashTokenInfo(text) {
  const m = text.match(/(?:^|\s)\/([A-Za-z0-9-]*)([\s\S]*)$/);
  if (!m) {
    return null;
  }
  const slashAt = m[0].indexOf('/');
  return {
    command: m[1],
    rest: m[2],
    start: m.index + slashAt,
    end: m.index + m[0].length,
  };
}

// The slash token currently being typed (used to open/filter the popup).
function slashTokenBeforeCaret() {
  const text = state.input.value;
  const pos = state.input.selectionStart != null ? state.input.selectionStart : text.length;
  const m = text.slice(0, pos).match(/(?:^|\s)\/([A-Za-z0-9-]*)$/);
  return m ? m[1] : null;
}

function rebuildSlashItems() {
  slashItems = [];
  if (!slashSourceFilter) {
    NATIVE_COMMANDS.forEach(function (c) {
      slashItems.push({ name: c.name, description: c.description, source: 'native', kind: 'native', local: c.local });
    });
  }
  const catalog = state.catalog;
  if (catalog && Array.isArray(catalog.commands)) {
    catalog.commands.forEach(function (c) {
      if (slashSourceFilter && c.source !== slashSourceFilter) {
        return;
      }
      slashItems.push({ name: c.name, description: c.description, source: c.source || 'command', kind: 'catalog' });
    });
  }
  const filter = slashFilter.toLowerCase();
  if (filter) {
    slashItems = slashItems.filter(function (it) {
      return it.name.toLowerCase().indexOf(filter) === 0;
    });
  }
  slashIndex = slashItems.length > 0 ? 0 : -1;
}

function renderSlashPopup() {
  state.slashPopup.textContent = '';
  if (slashItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No matching commands';
    state.slashPopup.appendChild(empty);
    return;
  }
  slashItems.forEach(function (item, i) {
    const row = document.createElement('div');
    row.className = 'slash-row' + (i === slashIndex ? ' active' : '');
    row.dataset.index = String(i);

    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = '/' + item.name;

    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = item.description || '';

    row.appendChild(name);
    row.appendChild(desc);
    state.slashPopup.appendChild(row);
  });
}

function openSlashPopup(filter) {
  closeAtPopup();
  slashFilter = filter || '';
  rebuildSlashItems();
  renderSlashPopup();
  state.slashPopup.hidden = false;
}

export function closeSlashPopup() {
  state.slashPopup.hidden = true;
  slashItems = [];
  slashIndex = -1;
  slashFilter = '';
  slashSourceFilter = null;
}

function updateSlashHighlight() {
  state.slashPopup.querySelectorAll('.slash-row').forEach(function (row) {
    row.classList.toggle('active', Number(row.dataset.index) === slashIndex);
  });
  const active = state.slashPopup.querySelector('.slash-row.active');
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

export function moveSlashIndex(delta) {
  if (slashItems.length === 0) {
    return;
  }
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  updateSlashHighlight();
}

export function handleSlashTyping() {
  const command = slashTokenBeforeCaret();
  if (command !== null) {
    openSlashPopup(command);
  } else {
    closeSlashPopup();
  }
}

function finishSlashSelect(before) {
  closeSlashPopup();
  state.input.value = before;
  autoGrow();
  updateComposerState();
  state.input.focus();
}

export function selectSlashItem(item) {
  const info = slashTokenInfo(state.input.value) || { command: '', rest: '', start: 0 };
  const before = state.input.value.slice(0, info.start);
  const rest = info.rest.replace(/^\s+/, '');
  const sessionId = state.activeSessionId;

  if (item.kind === 'catalog') {
    if (sessionId) {
      post({ type: 'executeCommand', sessionId: sessionId, command: item.name, arguments: rest });
    }
    finishSlashSelect(before);
    return;
  }

  if (item.kind === 'native' && item.local) {
    switch (item.name) {
      case 'sessions':
        flashSessionList();
        finishSlashSelect(before);
        return;
      case 'skills':
        slashSourceFilter = 'skill';
        state.input.value = before + '/';
        state.input.setSelectionRange(state.input.value.length, state.input.value.length);
        autoGrow();
        openSlashPopup('');
        state.input.focus();
        return;
      case 'models':
        closeSlashPopup();
        state.input.value = before;
        autoGrow();
        updateComposerState();
        openModelMenu();
        state.input.focus();
        return;
      case 'agents':
        closeSlashPopup();
        state.input.value = before;
        autoGrow();
        updateComposerState();
        openAgentMenu();
        state.input.focus();
        return;
      case 'new':
        if (sessionId) {
          post({ type: 'newSession', ...(rest !== '' ? { prompt: rest } : {}) });
        }
        finishSlashSelect(before);
        return;
      case 'help':
        closeSlashPopup();
        state.input.value = before;
        autoGrow();
        updateComposerState();
        showHelp();
        return;
      default:
        finishSlashSelect(before);
        return;
    }
  }

  if (item.kind === 'native') {
    if (sessionId) {
      post({ type: 'nativeCommand', sessionId: sessionId, command: item.name });
    }
    finishSlashSelect(before);
    return;
  }

  finishSlashSelect(before);
}

// ── At-mention popup ─────────────────────────────────────────────────────

// Matches an `@mention` token at a fresh position (start of input or after
// whitespace). Token chars include path characters so file mentions like
// `@src/foo.ts` type naturally.
function atTokenInfo(text) {
  const m = text.match(/(?:^|\s)@([A-Za-z0-9._/-]*)([\s\S]*)$/);
  if (!m) {
    return null;
  }
  const atAt = m[0].indexOf('@');
  return {
    command: m[1],
    rest: m[2],
    start: m.index + atAt,
    end: m.index + m[0].length,
  };
}

// The @ token currently being typed (used to open/filter the popup).
function atTokenBeforeCaret() {
  const text = state.input.value;
  const pos = state.input.selectionStart != null ? state.input.selectionStart : text.length;
  const m = text.slice(0, pos).match(/(?:^|\s)@([A-Za-z0-9._/-]*)$/);
  return m ? m[1] : null;
}

function rebuildAtItems() {
  atItems = [];
  const catalog = state.catalog;
  if (catalog && Array.isArray(catalog.agents)) {
    catalog.agents.forEach(function (a) {
      atItems.push({ name: a.name, description: a.description || '', kind: 'agent', value: a.name });
    });
  }
  if (Array.isArray(state.files)) {
    state.files.forEach(function (f) {
      atItems.push({ name: f.name, description: f.path, kind: 'file', value: f.path });
    });
  }
  const filter = atFilter.toLowerCase();
  if (filter) {
    atItems = atItems.filter(function (it) {
      return it.name.toLowerCase().indexOf(filter) === 0;
    });
  }
  atIndex = atItems.length > 0 ? 0 : -1;
}

export function renderAtPopup() {
  // Rebuild from live state so late-arriving files/catalog show up when the
  // host posts while the popup is open.
  rebuildAtItems();
  state.atPopup.textContent = '';
  if (atItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'menu-empty';
    empty.textContent = 'No matching files or agents';
    state.atPopup.appendChild(empty);
    return;
  }
  atItems.forEach(function (item, i) {
    const row = document.createElement('div');
    row.className = 'slash-row' + (i === atIndex ? ' active' : '');
    row.dataset.index = String(i);

    const name = document.createElement('span');
    name.className = 'slash-name';
    name.textContent = '@' + item.name;

    const desc = document.createElement('span');
    desc.className = 'slash-desc';
    desc.textContent = item.description || '';

    row.appendChild(name);
    row.appendChild(desc);
    state.atPopup.appendChild(row);
  });
  // The file list is still in flight — hint so the popup doesn't look broken.
  if (state.files === null && atFilter === '') {
    const hint = document.createElement('div');
    hint.className = 'menu-empty';
    hint.textContent = 'Loading files\u2026';
    state.atPopup.appendChild(hint);
  }
}

function openAtPopup(filter) {
  closeSlashPopup();
  atFilter = filter || '';
  renderAtPopup();
  state.atPopup.hidden = false;
  if (state.files === null) {
    post({ type: 'getFiles' });
  }
}

export function closeAtPopup() {
  state.atPopup.hidden = true;
  atItems = [];
  atIndex = -1;
  atFilter = '';
}

function updateAtHighlight() {
  state.atPopup.querySelectorAll('.slash-row').forEach(function (row) {
    row.classList.toggle('active', Number(row.dataset.index) === atIndex);
  });
  const active = state.atPopup.querySelector('.slash-row.active');
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

export function moveAtIndex(delta) {
  if (atItems.length === 0) {
    return;
  }
  atIndex = (atIndex + delta + atItems.length) % atItems.length;
  updateAtHighlight();
}

export function handleAtTyping() {
  const mention = atTokenBeforeCaret();
  if (mention !== null) {
    openAtPopup(mention);
  } else {
    closeAtPopup();
  }
}

function finishAtSelect(before) {
  closeAtPopup();
  state.input.value = before;
  autoGrow();
  updateComposerState();
  state.input.focus();
}

export function selectAtItem(item) {
  const info = atTokenInfo(state.input.value) || { command: '', rest: '', start: 0, end: 0 };
  const text = state.input.value;
  const before = text.slice(0, info.start) + '@' + item.value + ' ' + text.slice(info.end);
  finishAtSelect(before);
}

let flashTimer = null;

function flashSessionList() {
  const list = state.sessionList;
  document.body.classList.remove('collapsed');
  state.sessionToggle.title = 'Hide session list';
  list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  list.classList.remove('flash');
  void list.offsetWidth; // restart the animation
  list.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(function () {
    list.classList.remove('flash');
  }, 1100);
}

// ── Native command results ───────────────────────────────────────────────

export function appendNativeResult(msg) {
  const el = document.createElement('div');
  el.className = 'message native-message';
  el.dataset.role = 'system';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const roleLabel = document.createElement('span');
  roleLabel.className = 'message-role';
  roleLabel.textContent = 'System';
  meta.appendChild(roleLabel);
  el.appendChild(meta);

  const content = document.createElement('div');
  content.className = 'message-content';
  const text = document.createElement('div');
  text.className = 'part-text native-text';
  text.innerHTML = linkify(escapeHtml(msg.text || ''));
  content.appendChild(text);
  el.appendChild(content);

  state.conversation.appendChild(el);
  maybeScrollBottom();
  updateEmptyStates();
}
