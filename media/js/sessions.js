import { state } from './state.js';
import { relativeTime, showProgress, hideProgress } from './utils.js';
import { clearConversation } from './messages.js';
import { hidePermissionCard, hideQuestionCard } from './cards.js';
import { closeSlashPopup, updateComposerState } from './composer.js';
import { closeAgentMenu, closeModelMenu, updateMetaBadges } from './pickers.js';

// ── Session list ─────────────────────────────────────────────────────────

export function buildSessionRow(session, isSubagent) {
  const row = document.createElement('div');
  row.className = 'session-row' + (session.id === state.activeSessionId ? ' active' : '') + (isSubagent ? ' subagent-row' : '');
  row.dataset.sessionId = session.id;

  if (isSubagent) {
    const tag = document.createElement('span');
    tag.className = 'subagent-tag';
    tag.textContent = 'sub';
    row.appendChild(tag);
  }

  const title = document.createElement('span');
  title.className = 'session-title';
  title.textContent = session.title || 'Untitled session';
  title.title = session.title || '';

  const time = document.createElement('span');
  time.className = 'session-time';
  time.dataset.ts = String(session.updated || 0);
  time.textContent = relativeTime(session.updated);

  const del = document.createElement('button');
  del.className = 'session-delete';
  del.dataset.delete = '';
  del.title = 'Delete session';
  del.setAttribute('aria-label', 'Delete session');
  del.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6l.7-9.5M6.5 6.5v4.5M9.5 6.5v4.5" ' +
    'stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  row.appendChild(title);
  row.appendChild(time);
  row.appendChild(del);
  return row;
}

export function renderSessionList() {
  const list = state.sessionList;
  list.textContent = '';
  state.sessions.forEach(function (session) {
    list.appendChild(buildSessionRow(session, false));
    // Subagent rows render directly under their parent session.
    if (session.id === state.activeSessionId) {
      state.subagents.forEach(function (sub) {
        list.appendChild(buildSessionRow(sub, true));
      });
    }
  });

  const count = state.sessionCount;
  count.hidden = state.sessions.length === 0;
  count.textContent = String(state.sessions.length);
}

export function setSubagentsToggle(visible) {
  state.subagentsVisible = visible;
  state.subagentsToggle.classList.toggle('on', visible);
  state.subagentsToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
  state.subagentsToggle.title = visible ? 'Hide subagent sessions' : 'Show subagent sessions of this session';
}

export function updateSubagentsToggle() {
  state.subagentsToggle.disabled = !state.connected || state.activeSessionId === null;
}

export function applySessions(msg) {
  state.sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
  const newActive = typeof msg.activeSessionId === 'string' ? msg.activeSessionId : null;
  const changed = newActive !== state.activeSessionId;
  state.activeSessionId = newActive;

  if (state.activeSessionId === null) {
    hideProgress();
  }
  renderSessionList();

  if (changed) {
    clearConversation();
    state.busy = false;
    state.stopping = false;
    state.stoppedStream = false;
    state.agent = null;
    state.model = null;
    state.usage = null;
    state.subagents = [];
    hidePermissionCard();
    hideQuestionCard();
    setSubagentsToggle(false);
    closeSlashPopup();
    closeAgentMenu();
    closeModelMenu();
    updateMetaBadges();
  }
  updateSubagentsToggle();
  updateEmptyStates();
  updateComposerState();
}

export function removeSession(sessionId) {
  state.sessions = state.sessions.filter(function (s) {
    return s.id !== sessionId;
  });
  if (state.activeSessionId === sessionId) {
    state.activeSessionId = null;
    state.busy = false;
    state.stopping = false;
    state.stoppedStream = false;
    state.agent = null;
    state.model = null;
    state.usage = null;
    state.subagents = [];
    hidePermissionCard();
    hideQuestionCard();
    setSubagentsToggle(false);
    clearConversation();
    hideProgress();
    updateMetaBadges();
  }
  renderSessionList();
  updateSubagentsToggle();
  updateEmptyStates();
  updateComposerState();
}

// ── Connection / empty states ─────────────────────────────────────────────

export function applyConnected(connected) {
  state.connected = connected;
  state.disconnected.hidden = connected;
  state.app.hidden = !connected;
  if (!connected) {
    hidePermissionCard();
    hideQuestionCard();
  }
  updateSubagentsToggle();
  updateEmptyStates();
  updateComposerState();
}

export function updateEmptyStates() {
  const convEmpty = state.conversation.querySelectorAll('.message').length === 0;
  let showNoSessions = false;
  let showNoConv = false;
  if (state.connected && state.sessions.length === 0) {
    showNoSessions = true;
  } else if (state.connected && !state.loading && state.activeSessionId !== null && convEmpty) {
    showNoConv = true;
  }
  state.emptyNoSessions.hidden = !showNoSessions;
  state.emptyConversation.hidden = !showNoConv;
}
