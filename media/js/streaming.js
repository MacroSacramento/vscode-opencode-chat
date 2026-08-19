import { state } from './state.js';
import { findMessageEl, maybeScrollBottomIn } from './utils.js';
import { buildMessageEl } from './parts.js';
import { renderMarkdown } from './markdown.js';
import { getPaneConversation } from './layout.js';

// ── Streaming ────────────────────────────────────────────────────────────

let renderQueued = false;
// A Set of render targets: two panes streaming concurrently must both be
// flushed in the same rAF pass — a single slot would drop one stream.
const queuedTargets = new Set();

// Per-stream render throttle: each stream element carries `_lastRenderAt`
// (ms timestamp of the last actual render) and `_lastRenderedLen` (length of
// `_accText` at that render). Rapid deltas skip re-rendering until either
// 50ms pass or 400 more characters accumulate — avoids O(n²) markdown
// re-renders as the streamed text grows.
export function renderStreamNow(t, force) {
  const acc = t._accText || '';
  const now = performance.now();
  if (!force && now - (t._lastRenderAt || 0) < 50 && acc.length - (t._lastRenderedLen || 0) < 400) {
    return false;
  }
  // Detach the live thinking block so the innerHTML replacement below
  // doesn't wipe it, then re-insert it above the streamed text.
  const live = t.querySelector('.reasoning-live');
  if (live) {
    live.remove();
  }
  t.querySelector('.thinking')?.remove();
  if (acc) {
    const inner = renderMarkdown(acc);
    // Streamed text needs the `.markdown` scope for paragraph/list styles.
    t.innerHTML = t.classList.contains('markdown') || t.closest('.markdown') ? inner : '<div class="markdown">' + inner + '</div>';
  }
  if (live) {
    t.insertBefore(live, t.firstChild);
    updateLiveThinking(t);
  }
  t._lastRenderAt = now;
  t._lastRenderedLen = acc.length;
  return true;
}

function scheduleStreamRender(target) {
  queuedTargets.add(target);
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(function () {
    renderQueued = false;
    const targets = Array.from(queuedTargets);
    queuedTargets.clear();
    targets.forEach(function (t) {
      if (!document.contains(t)) {
        return;
      }
      if (renderStreamNow(t, false)) {
        maybeScrollBottomIn(t.closest('.chat-pane-conversation'));
      }
    });
  });
}

// ── Live thinking (streamed reasoning) ──────────────────────────────────

let thinkRenderQueued = false;
const thinkQueuedTargets = new Set();

// Per-stream reasoning render throttle, mirroring the text path: the body
// element carries `_lastThinkRenderAt` (ms of last actual render) and
// `_lastThinkRenderedLen` (length of `_accThinking` then). Rapid reasoning
// deltas skip re-rendering until either 50ms pass or 400 more characters
// accumulate — reasoning can be huge raw JSON/tool output, so the markdown
// re-render must not run on every delta.
function renderThinkingNow(body, force) {
  const acc = body._accThinking || '';
  const now = performance.now();
  if (!force && now - (body._lastThinkRenderAt || 0) < 50 && acc.length - (body._lastThinkRenderedLen || 0) < 400) {
    return false;
  }
  body.innerHTML = renderMarkdown(acc);
  body._lastThinkRenderAt = now;
  body._lastThinkRenderedLen = acc.length;
  return true;
}

function scheduleThinkingRender(stream) {
  thinkQueuedTargets.add(stream);
  if (thinkRenderQueued) {
    return;
  }
  thinkRenderQueued = true;
  requestAnimationFrame(function () {
    thinkRenderQueued = false;
    const streams = Array.from(thinkQueuedTargets);
    thinkQueuedTargets.clear();
    streams.forEach(function (s) {
      if (!document.contains(s)) {
        return;
      }
      const body = s.querySelector('.reasoning-live .reasoning-body');
      if (!body) {
        return;
      }
      if (renderThinkingNow(body, false)) {
        maybeScrollBottomIn(s.closest('.chat-pane-conversation'));
      }
    });
  });
}

function createLiveThinking() {
  const block = document.createElement('div');
  block.className = 'reasoning reasoning-live';
  block.hidden = true;
  const summary = document.createElement('span');
  summary.className = 'reasoning-summary';
  summary.textContent = 'Thinking\u2026';
  const body = document.createElement('div');
  body.className = 'reasoning-body markdown';
  block.appendChild(summary);
  block.appendChild(body);
  return block;
}

// Applies accumulated reasoning (`_accThinking`) to the pending bubble's
// live thinking block. Reasoning always accumulates; the block is only
// revealed when `showThinking` is on, so toggling mid-think shows the
// reasoning gathered so far. With the toggle on, the block is also shown
// eagerly (empty "Thinking…") so the thinking state is visible from the
// first delta, before any reasoning text has arrived.
export function updateLiveThinking(stream) {
  const acc = stream._accThinking || '';
  let live = stream.querySelector('.reasoning-live');
  // Nothing to reveal and nothing to hide — leave the DOM untouched. The
  // `!live` term keeps the hide path live for an empty-but-visible block
  // when the toggle flips off mid-stream.
  if (acc === '' && !state.showThinking && !live) {
    return;
  }
  if (!live) {
    live = createLiveThinking();
    stream.insertBefore(live, stream.firstChild);
  }
  const body = live.querySelector('.reasoning-body');
  if (body && acc !== '') {
    body._accThinking = acc;
    scheduleThinkingRender(stream);
  }
  if (state.showThinking) {
    const placeholder = stream.querySelector('.thinking');
    if (placeholder) {
      placeholder.remove();
    }
  }
  live.hidden = !state.showThinking;
}

// The pending bubble's reasoning is done (stream ended): the live block
// reads "Thinking…" while streaming and "Thought" once complete.
export function finalizeLiveThinking() {
  document.querySelectorAll('.reasoning-live .reasoning-summary').forEach(function (summary) {
    summary.textContent = 'Thought';
  });
}

export function onDelta(msg, sessionId) {
  if (typeof msg.text !== 'string') {
    return;
  }
  const conv = getPaneConversation(sessionId);
  if (!conv) {
    return;
  }
  // The stream was torn down by a Stop — ignore stragglers so they can't
  // resurrect a settled bubble. Scoped per pane: one pane stopping must not
  // suppress another pane's live stream.
  if (state.paneStoppedStream[sessionId]) {
    return;
  }
  let el = findMessageEl(msg.messageId);
  if (!el && state.panePendingAssistantId[sessionId]) {
    el = findMessageEl(state.panePendingAssistantId[sessionId]);
  }
  if (!el) {
    // Deltas can land before the host's optimistic bubble does (resume/
    // retry) — synthesize an assistant bubble on demand.
    const bubble = buildMessageEl({ id: msg.messageId, role: 'assistant', time: Date.now(), parts: [] });
    bubble.classList.add('streaming');
    state.panePendingAssistantId[sessionId] = state.panePendingAssistantId[sessionId] || msg.messageId;
    conv.appendChild(bubble);
    el = bubble;
    maybeScrollBottomIn(conv);
  }
  el.classList.add('streaming');

  const stream = el.querySelector('[data-part="stream"]');
  if (stream) {
    if (msg.partType === 'reasoning') {
      // Cumulative `replace` deltas carry the full part text — replace the
      // accumulated reasoning instead of appending.
      stream._accThinking = msg.replace ? msg.text : (stream._accThinking || '') + msg.text;
      updateLiveThinking(stream);
      return;
    }
    stream._accText = msg.replace ? msg.text : (stream._accText || '') + msg.text;
    // With the toggle on, surface the "Thinking…" state on the very first
    // streamed text delta — even if no reasoning delta ever arrives — so
    // the model's thinking phase is visible from the start.
    if (state.showThinking) {
      updateLiveThinking(stream);
    }
    scheduleStreamRender(stream);
    // Follow the stream while the user is at the bottom: each text delta
    // keeps the view pinned to the answer as it grows.
    maybeScrollBottomIn(conv);
    return;
  }
  // A settled message receiving deltas (resume/retry) — patch in place.
  if (msg.partType === 'reasoning') {
    const body = el.querySelector('.markdown .reasoning-body');
    if (body) {
      const base = body._accThinking || body.textContent || '';
      body._accThinking = msg.replace ? msg.text : base + msg.text;
      body.innerHTML = renderMarkdown(body._accThinking);
      if (state.showThinking) {
        const details = body.closest('details');
        if (details) {
          details.open = true;
        }
      }
    }
    return;
  }
  const textPart = el.querySelector('.markdown .part-text');
  if (textPart) {
    const base = textPart._accText || textPart.textContent || '';
    textPart._accText = msg.replace ? msg.text : base + msg.text;
    scheduleStreamRender(textPart);
  }
}

// ── Stop settling ────────────────────────────────────────────────────────

// Post-abort settle for a single stream container. A bubble that never
// produced text or reasoning collapses to a dimmed "Stopped" note; anything
// with content keeps it (the "Aborted" system message documents the stop).
function markStreamStopped(stream) {
  if (!stream) {
    return;
  }
  const hasContent = stream.querySelector('.markdown, .reasoning-live') !== null;
  if (!hasContent) {
    stream.classList.add('stopped');
    stream.textContent = 'Stopped';
  }
}

// Settle stopped assistant bubbles: drop the streaming affordance (streams
// only), then let markStreamStopped decide marker vs. content.
function markStoppedPass(container, includeStreamingOnly) {
  const selector = includeStreamingOnly
    ? '.message[data-role="assistant"].streaming'
    : '.message[data-role="assistant"]';
  container.querySelectorAll(selector).forEach(function (bubble) {
    if (includeStreamingOnly) {
      bubble.classList.remove('streaming');
    }
    markStreamStopped(bubble.querySelector('[data-part="stream"]'));
  });
}

// Settle the live pending bubble(s) when a stop lands. Scoped to the pane
// that stopped — a stop in one pane must not settle another pane's stream.
export function settleStoppedStream(sessionId) {
  const conv = getPaneConversation(sessionId) || state.conversation;
  markStoppedPass(conv, true);
}

// Same pass over freshly-rebuilt history (idle triggers loadHistory right
// after the abort), catching empty assistant turns the server persisted.
export function settleStoppedHistory(conv) {
  markStoppedPass(conv, false);
}
