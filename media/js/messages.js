import { state } from './state.js';
import { findMessageEl, maybeScrollBottom, scrollToBottom, hideProgress } from './utils.js';
import { appendParts, buildMessageEl } from './parts.js';
import { settleStoppedHistory } from './streaming.js';
import { updateEmptyStates } from './sessions.js';
import { updateComposerState } from './composer.js';

// ── Message upserting ────────────────────────────────────────────────────

export function upsertMessage(message) {
  if (!message || !message.id) {
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
    if (message.id === state.pendingAssistantId) {
      state.pendingAssistantId = null;
    }
    // An update for an optimistic user bubble (`local-user-*` id) means
    // that bubble is being finalized. If pendingUserEl parks a DIFFERENT
    // bubble, that one is stale — a second prompt overwrote the pointer
    // before the first turn's real message arrived — so drop it. Otherwise
    // a late real user message would be adopted into the wrong bubble (or
    // render as a duplicate beside the leftover ghost).
    if (String(existing.dataset.messageId).indexOf('local-user-') === 0 && state.pendingUserEl && state.pendingUserEl !== existing) {
      state.pendingUserEl.remove();
      state.pendingUserEl = null;
    }
    return;
  }

  // Adoption: the server's real message id arrives for an optimistic bubble.
  if (message.role === 'user' && state.pendingUserEl && document.contains(state.pendingUserEl)) {
    state.pendingUserEl.dataset.messageId = message.id;
    if (Array.isArray(message.parts) && message.parts.length > 0) {
      const content = state.pendingUserEl.querySelector('.message-content');
      if (content) {
        content.textContent = '';
        appendParts(content, 'user', message.parts);
      }
    }
    state.pendingUserEl = null;
    return;
  }
  if (message.role === 'assistant' && state.pendingAssistantId) {
    const pending = findMessageEl(state.pendingAssistantId);
    if (pending && document.contains(pending)) {
      pending.dataset.messageId = message.id;
      state.pendingAssistantId = null;
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
    state.pendingUserEl = el;
  }
  if (message.role === 'assistant' && String(message.id).indexOf('pending-') === 0) {
    state.pendingAssistantId = message.id;
    el.classList.add('streaming');
  }
  state.conversation.appendChild(el);
  maybeScrollBottom();
}

// ── History / conversation ───────────────────────────────────────────────

export function clearConversation() {
  state.conversation.textContent = '';
  state.pendingAssistantId = null;
  state.pendingUserEl = null;
}

export function renderHistory(msg) {
  const conv = state.conversation;
  const nearBottom = conv.scrollHeight - conv.scrollTop - conv.clientHeight < 80;
  const savedTop = conv.scrollTop;
  conv.textContent = '';
  (msg.messages || []).forEach(function (m) {
    conv.appendChild(buildMessageEl(m));
  });
  // A history reload that lands right after an abort rebuilds the pending
  // bubble from server state — re-apply the stopped marker to any empty
  // assistant turn so it doesn't sit on "Thinking…" forever.
  if (state.stoppedStream) {
    settleStoppedHistory(conv);
    state.stoppedStream = false;
  }
  state.pendingAssistantId = null;
  state.pendingUserEl = null;
  hideProgress();
  if (nearBottom) {
    scrollToBottom();
  } else {
    // Rebuilding wipes scrollTop — restore it so a history reload while the
    // user is mid-conversation doesn't jump to the top (or past the end).
    // The near-bottom case is handled by scrollToBottom above.
    conv.scrollTop = Math.min(savedTop, conv.scrollHeight);
  }
  updateEmptyStates();
  updateComposerState();
}
