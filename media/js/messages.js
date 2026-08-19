import { state } from './state.js';
import { findMessageEl, maybeScrollBottomIn, scrollToBottomIn, hideProgress } from './utils.js';
import { appendParts, buildMessageEl } from './parts.js';
import { settleStoppedHistory } from './streaming.js';
import { syncEmptyStates, getPaneConversation } from './layout.js';
import { updateComposerState } from './composer.js';

// ── Message upserting ────────────────────────────────────────────────────

export function upsertMessage(message, sessionId) {
  if (!message || !message.id) {
    return;
  }
  const conv = getPaneConversation(sessionId);
  if (!conv) {
    // No open pane for this session — nothing to render into.
    return;
  }
  const existing = findMessageEl(message.id);
  if (existing) {
    // Empty parts = server metadata update only; keep streamed content.
    if (Array.isArray(message.parts) && message.parts.length > 0) {
      const content = existing.querySelector('.message-content');
      if (content) {
        content.textContent = '';
        appendParts(content, existing.dataset.role, message.parts);
      }
      existing._accText = undefined;
      existing.classList.remove('streaming');
    }
    // The real message arrived for an onDelta-synthesized bubble (deltas
    // landed before the host's optimistic bubble) — stop treating that id
    // as pending so a later turn's deltas can't be misdirected to it.
    if (message.id === state.panePendingAssistantId[sessionId]) {
      state.panePendingAssistantId[sessionId] = null;
    }
    // An update for an optimistic user bubble (`local-user-*` id) means
    // that bubble is being finalized. If pendingUserEl parks a DIFFERENT
    // bubble, that one is stale — a second prompt overwrote the pointer
    // before the first turn's real message arrived — so drop it. Otherwise
    // a late real user message would be adopted into the wrong bubble (or
    // render as a duplicate beside the leftover ghost).
    if (String(existing.dataset.messageId).indexOf('local-user-') === 0 && state.panePendingUserEl[sessionId] && state.panePendingUserEl[sessionId] !== existing) {
      state.panePendingUserEl[sessionId].remove();
      state.panePendingUserEl[sessionId] = null;
    }
    return;
  }

  // Adoption: the server's real message id arrives for an optimistic bubble.
  if (message.role === 'user' && state.panePendingUserEl[sessionId] && document.contains(state.panePendingUserEl[sessionId])) {
    state.panePendingUserEl[sessionId].dataset.messageId = message.id;
    if (Array.isArray(message.parts) && message.parts.length > 0) {
      const content = state.panePendingUserEl[sessionId].querySelector('.message-content');
      if (content) {
        content.textContent = '';
        appendParts(content, 'user', message.parts);
      }
    }
    state.panePendingUserEl[sessionId] = null;
    return;
  }
  if (message.role === 'assistant' && state.panePendingAssistantId[sessionId]) {
    const pending = findMessageEl(state.panePendingAssistantId[sessionId]);
    if (pending && document.contains(pending)) {
      pending.dataset.messageId = message.id;
      state.panePendingAssistantId[sessionId] = null;
      if (Array.isArray(message.parts) && message.parts.length > 0) {
        const content = pending.querySelector('.message-content');
        if (content) {
          content.textContent = '';
          appendParts(content, 'assistant', message.parts);
        }
        pending._accText = undefined;
        pending.classList.remove('streaming');
      }
      return;
    }
  }

  // Brand-new message.
  const el = buildMessageEl(message);
  if (message.role === 'user' && String(message.id).indexOf('local-user-') === 0) {
    state.panePendingUserEl[sessionId] = el;
  }
  if (message.role === 'assistant' && String(message.id).indexOf('pending-') === 0) {
    state.panePendingAssistantId[sessionId] = message.id;
    el.classList.add('streaming');
  }
  conv.appendChild(el);
  maybeScrollBottomIn(conv);
}

// ── History / conversation ───────────────────────────────────────────────

// Clears a pane's conversation. Kept for compatibility; the multi-pane grid
// no longer wipes conversations on session-list refreshes. Accepts an
// optional sessionId — defaults to the focused pane.
export function clearConversation(sessionId) {
  const conv = sessionId ? getPaneConversation(sessionId) : state.conversation;
  if (!conv) {
    return;
  }
  conv.textContent = '';
  const sid = sessionId || state.activeSessionId;
  if (sid) {
    state.panePendingAssistantId[sid] = null;
    state.panePendingUserEl[sid] = null;
  }
}

export function renderHistory(msg, sessionId) {
  const conv = getPaneConversation(sessionId);
  if (!conv) {
    return;
  }
  const nearBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
  const savedTop = conv.scrollTop;
  conv.textContent = '';
  (msg.messages || []).forEach(function (m) {
    conv.appendChild(buildMessageEl(m));
  });
  // A history reload that lands right after an abort rebuilds the pending
  // bubble from server state — re-apply the stopped marker to any empty
  // assistant turn so it doesn't sit on "Thinking…" forever.
  if (state.paneStoppedStream[sessionId]) {
    settleStoppedHistory(conv);
    state.paneStoppedStream[sessionId] = false;
  }
  state.panePendingAssistantId[sessionId] = null;
  state.panePendingUserEl[sessionId] = null;
  hideProgress();
  if (nearBottom) {
    scrollToBottomIn(conv);
  } else {
    // Rebuilding wipes scrollTop — restore it so a history reload while the
    // user is mid-conversation doesn't jump to the top (or past the end).
    // The near-bottom case is handled by scrollToBottomIn above.
    conv.scrollTop = Math.min(savedTop, conv.scrollHeight);
  }
  syncEmptyStates();
  updateComposerState();
}