import { state } from './state.js';
import { relativeTime, showProgress, hideProgress } from './utils.js';
import { hidePermissionCard, hideQuestionCard } from './cards.js';
import { closeSlashPopup, updateComposerState } from './composer.js';
import { closeAgentMenu, closeModelMenu, updateMetaBadges } from './pickers.js';
import { setSessionTitle, syncEmptyStates, openSession, getPaneConversation } from './layout.js';

// ── Session list ─────────────────────────────────────────────────────────

export function buildSessionRow(session, isSubagent) {
  const row = document.createElement('div');
  row.className = 'session-row' + (session.id === state.activeSessionId ? ' active' : '') + (isSubagent ? ' subagent-row' : '');
  row.dataset.sessionId = session.id;
  // Drag source for the chat grid (layout.js wires the delegated handlers).
  row.draggable = true;

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
    state.subagents = [];
    setSubagentsToggle(false);
    closeSlashPopup();
    closeAgentMenu();
    closeModelMenu();
    updateMetaBadges();
  }
  // Ensure the active session has a pane (e.g. on first load when the
  // restored layout is empty) so its history isn't dropped by the routing
  // gate. No-op when the pane already exists.
  if (state.activeSessionId && !getPaneConversation(state.activeSessionId)) {
    openSession(state.activeSessionId);
  }
  // Update pane titles from the session list (layout.js no-ops for sessions
  // without panes).
  state.sessions.forEach(function (s) {
    setSessionTitle(s.id, s.title);
  });
  updateSubagentsToggle();
  syncEmptyStates();
  updateComposerState();
}

export function removeSession(sessionId) {
  state.sessions = state.sessions.filter(function (s) {
    return s.id !== sessionId;
  });
  // Clean up per-pane state for the removed session. Pane removal + focus
  // repair is handled by layout.js handleSessionDeleted (runs first).
  delete state.paneBusy[sessionId];
  delete state.paneStopping[sessionId];
  delete state.paneStoppedStream[sessionId];
  delete state.panePendingAssistantId[sessionId];
  delete state.panePendingUserEl[sessionId];
  delete state.paneAgent[sessionId];
  delete state.paneModel[sessionId];
  delete state.paneUsage[sessionId];
  delete state.paneSubagents[sessionId];
  delete state.panePendingPermission[sessionId];
  delete state.panePendingQuestion[sessionId];
  renderSessionList();
  updateSubagentsToggle();
  syncEmptyStates();
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
  // Empty-state coordination now lives in layout.js (grid hint, per-pane
  // placeholders, and the absolute overlays all stay in sync there).
  syncEmptyStates();
}
