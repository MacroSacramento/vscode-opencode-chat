// ── Chat layout (tabs + zones) ───────────────────────────────────────────
// Owns the chat tree: the layout lives in a JS tree (`tree`), and the DOM is
// a render of it. A zone (`.chat-group`) is a tab bar plus a pane container;
// a split (`.chat-split`) is a structural flex wrapper holding nested
// zones/splits side by side (horizontal) or stacked (vertical).
//
// Tree shape (source of truth, matches the host — no runtime validation):
//   { version: 2, root: <node|null>, focusedSessionId: <string|null> }
//   group: { type:'group', id, sessionIds: string[] }   // id = tab order
//   split: { type:'split', orientation, children: node[] }
//
// A group can hold N tabs; only the FOCUSED tab's pane is visible, but ALL
// panes stay in the DOM (inactive ones carry the `hidden` attribute) so the
// message/composer/cards modules can keep routing into non-focused panes.
//
// The webview keeps a local `zoneActive` map (groupId -> last active
// sessionId) so re-focusing a zone after a structural change restores its
// last tab. It is NOT persisted and NOT part of the protocol.
//
// ── JS CONTRACT (for the implementer wiring this into app.js/sessions.js) ─
//
// app.js init:
//   - call `initLayout()` AFTER the state.* DOM refs are assigned;
//   - the composer DOM refs (state.input, state.sendBtn, popups, menus,
//     cards) are re-pointed at the focused pane by focusPane on every focus
//     change (and nulled by clearFocus).
//
// app.js route():
//   - `case 'chatLayout': applyLayout(msg.layout); break;` — the host sends
//     the restored layout right after 'connected' (before 'sessions').
//   - 'sessionDeleted' handler: call `handleSessionDeleted(msg.sessionId)`.
//   - 'sessionMeta' handler: call `setSessionTitle(msg.sessionId, title)`.
//   - session-list click: call `openSession(id)`.
//
// sessions.js:
//   - applySessions: when the active session has no open pane, call
//     `openSession(state.activeSessionId)` BEFORE `clearConversation()`.
//   - updateEmptyStates: delegates to `syncEmptyStates()`.
//
// Persistence protocol:
//   - layout.js posts `{type:'setChatLayout', layout}` (debounced) on every
//     structural or focus change. The host stores it and replies
//     `{type:'chatLayout', layout}` on connect/restore.
//
// DOM contract (chat.html + per-pane, built by buildPane):
//   #chatGrid.chat-grid
//     .grid-empty-hint            (drag-only; drop target when grid is empty)
//     <root render>               (a .chat-split and/or .chat-group tree)
//       .chat-split[data-orientation]
//         .chat-group[data-group-id][data-panes]
//           .chat-tabbar
//             .chat-tab[data-session-id] (.active)
//               span.chat-tab-label
//               button.chat-tab-close
//           .chat-group-body
//             .chat-pane[data-session-id][data-focused] (visible) / [hidden]
//               .chat-pane-conversation (scrollable message list)
//                 .chat-pane-empty    (placeholder)
//               .chat-pane-composer   (per-pane chat footer; position:relative)
//                 #permissionCard.permission-card
//                 #questionCard.question-card
//                 #slashPopup.slash-popup
//                 #atPopup.slash-popup
//                 .meta-strip (agent/model/thinking badges + menus)
//                 .composer-row (textarea#input + button#sendBtn)
//                 .composer-hint
//                 #contextUsageLine.context-usage-line
//     .grid-drop-zone             (drag-only; dashed "new zone" strip)
//
// NOTE: session titles live on the pane + tab `title` attributes (hover
// tooltips) and in the session list; `setSessionTitle` updates both.
//
// Drag & drop (Phase 2+3: reorder, move between zones, edge-split):
//   - dataTransfer type: 'application/x-opencode-session' (value = session
//     id), plus 'text/plain' fallback with the same value. effectAllowed /
//     dropEffect are 'move' when the session is already open in the tree,
//     'copy' when not (dragged from the list).
//   - sources: .session-row in #sessionList and .chat-tab in the grid (both
//     delegated, no per-element wiring).
//   - targets: .chat-tabbar (reorder / insert-at-position, gap indicator on
//     the adjacent tab), .chat-group body (center → move into zone, edges →
//     split into a new zone via the 5-region drop overlay), and the empty
//     grid / .grid-drop-zone / .grid-empty-hint (create a new zone).
//   - visual states: .drag-over on the target, .tab-gap-left/right on the
//     adjacent tab, .active on the drop region, .dragging on the source,
//     body.dragging while any drag is live.

import { state } from './state.js';
import { post, cssEscape } from './utils.js';

const DRAG_TYPE = 'application/x-opencode-session';

const ICONS = {
  close:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  chat:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M4 4h16v12H8l-4 4V4z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  send:
    '<svg class="send-ico" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M14 2L1.8 6.6l4.9 2.1L9 13.8 14 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M6.7 8.7L14 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    '<svg class="stop-ico" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>' +
    '<span class="stop-label" hidden>Stopping\u2026</span>',
  thinking:
    '<svg class="thinking-eye" width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M8 3C4.5 3 1.7 5.3 1 8c.7 2.7 3.5 5 7 5s6.3-2.3 7-5c-.7-2.7-3.5-5-7-5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2"/></svg>',
};

let grid = null;
let dragSessionId = null;
let dragSourceEl = null;
let groupSeq = 0;
let persistTimer = null;
// Set while applyLayout is adopting the host tree. persist() is suppressed
// during that window so the webview never echoes the host's own layout back
// as setChatLayout (which would ping-pong forever).
let applyingLayout = false;
let onFocusChange = null;

// Tree source of truth.
let tree = null;
// Webview-local: groupId -> last active sessionId (NOT persisted, NOT in the
// protocol). Used only so re-focusing a zone after a structural change
// restores its last tab.
const zoneActive = new Map();

// Focus-change hook: app.js wires this to update the composer, meta badges,
// cards, and session-list subagent rows. A callback (not a direct import)
// avoids a circular import chain (layout -> composer -> sessions -> layout).
export function setOnFocusChange(cb) {
  onFocusChange = cb;
}

function notifyFocusChange(sessionId) {
  if (onFocusChange) {
    onFocusChange(sessionId);
  }
}

// Keeps the session list's `.active` row in sync with the focused pane.
function updateSessionListHighlight() {
  if (!state.sessionList) {
    return;
  }
  state.sessionList.querySelectorAll('.session-row[data-session-id]').forEach(function (row) {
    row.classList.toggle('active', row.dataset.sessionId === state.activeSessionId);
  });
}

// ── Small helpers ────────────────────────────────────────────────────────

function $(sel, root) {
  return (root || document).querySelector(sel);
}

function $$(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

function nextGroupId() {
  groupSeq += 1;
  return 'group-' + Date.now().toString(36) + '-' + groupSeq;
}

function titleForSession(sessionId) {
  const s = state.sessions.find(function (item) {
    return item.id === sessionId;
  });
  return (s && s.title) || 'Untitled session';
}

function findPane(sessionId) {
  if (!grid) {
    return null;
  }
  return grid.querySelector('.chat-pane[data-session-id="' + cssEscape(sessionId) + '"]');
}

function dropZone() {
  return grid ? grid.querySelector('.grid-drop-zone') : null;
}

// ── Tree helpers ─────────────────────────────────────────────────────────

function collectSessionIds(node, out) {
  if (!node) {
    return;
  }
  if (node.type === 'group') {
    (node.sessionIds || []).forEach(function (sid) {
      out.push(sid);
    });
  } else if (node.type === 'split') {
    (node.children || []).forEach(function (c) {
      collectSessionIds(c, out);
    });
  }
}

function findGroupNode(node, gid) {
  if (!node) {
    return null;
  }
  if (node.type === 'group') {
    return node.id === gid ? node : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const r = findGroupNode(node.children[i], gid);
    if (r) {
      return r;
    }
  }
  return null;
}

function findZoneNodeContaining(node, sessionId) {
  if (!node) {
    return null;
  }
  if (node.type === 'group') {
    return node.sessionIds.indexOf(sessionId) !== -1 ? node : null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const r = findZoneNodeContaining(node.children[i], sessionId);
    if (r) {
      return r;
    }
  }
  return null;
}

// Returns { parent, index } for the split whose child is the group `gid`,
// or null when the group is the tree root.
function findParentNode(node, gid) {
  if (!node || node.type !== 'split') {
    return null;
  }
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'group') {
      if (child.id === gid) {
        return { parent: node, index: i };
      }
    } else {
      const r = findParentNode(child, gid);
      if (r) {
        return r;
      }
    }
  }
  return null;
}

function lastGroupNode(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'group') {
    return node;
  }
  let last = null;
  (node.children || []).forEach(function (c) {
    const g = lastGroupNode(c);
    if (g) {
      last = g;
    }
  });
  return last;
}

function collectGroupIds(node, out) {
  if (!node) {
    return;
  }
  if (node.type === 'group') {
    out.push(node.id);
  } else if (node.type === 'split') {
    (node.children || []).forEach(function (c) {
      collectGroupIds(c, out);
    });
  }
}

// Light normalization of a host-provided node into our internal shape.
function sanitizeTree(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'group') {
    return {
      type: 'group',
      id: typeof node.id === 'string' ? node.id : nextGroupId(),
      sessionIds: Array.isArray(node.sessionIds) ? node.sessionIds.slice() : [],
    };
  }
  if (node.type === 'split') {
    const children = Array.isArray(node.children) ? node.children : [];
    const kept = children.map(sanitizeTree).filter(Boolean);
    if (kept.length === 1) {
      return kept[0];
    }
    if (kept.length === 0) {
      return null;
    }
    return {
      type: 'split',
      orientation: node.orientation === 'vertical' ? 'vertical' : 'horizontal',
      children: kept,
    };
  }
  return null;
}

// ── Composer ref re-pointing ─────────────────────────────────────────────
// The per-pane composer IDs are not globally unique, so the shared state
// refs must point at the FOCUSED pane's elements. Re-point them on every
// focus change (and null them when nothing is focused).

function syncComposerRefs(pane) {
  const composer = pane.querySelector('.chat-pane-composer');
  if (!composer) {
    return;
  }
  state.input = composer.querySelector('#input');
  state.sendBtn = composer.querySelector('#sendBtn');
  state.slashPopup = composer.querySelector('#slashPopup');
  state.atPopup = composer.querySelector('#atPopup');
  state.agentPickerBtn = composer.querySelector('#agentPickerBtn');
  state.agentBadgeValue = composer.querySelector('#agentBadgeValue');
  state.agentMenu = composer.querySelector('#agentMenu');
  state.modelPickerBtn = composer.querySelector('#modelPickerBtn');
  state.modelBadgeValue = composer.querySelector('#modelBadgeValue');
  state.modelMenu = composer.querySelector('#modelMenu');
  state.thinkingToggle = composer.querySelector('#thinkingToggle');
  state.thinkingToggleValue = composer.querySelector('#thinkingToggleValue');
  state.contextUsageLine = composer.querySelector('#contextUsageLine');
  state.permissionCard = composer.querySelector('#permissionCard');
  state.questionCard = composer.querySelector('#questionCard');
}

function clearComposerRefs() {
  state.input = null;
  state.sendBtn = null;
  state.slashPopup = null;
  state.atPopup = null;
  state.agentPickerBtn = null;
  state.agentBadgeValue = null;
  state.agentMenu = null;
  state.modelPickerBtn = null;
  state.modelBadgeValue = null;
  state.modelMenu = null;
  state.thinkingToggle = null;
  state.thinkingToggleValue = null;
  state.contextUsageLine = null;
  state.permissionCard = null;
  state.questionCard = null;
}

// ── Builders ─────────────────────────────────────────────────────────────

// Zone: tab bar + pane container. No card chrome; the pane is the chat.
function buildTabBar() {
  const bar = document.createElement('div');
  bar.className = 'chat-tabbar';
  return bar;
}

function buildTab(sessionId) {
  const tab = document.createElement('div');
  tab.className = 'chat-tab';
  tab.dataset.sessionId = sessionId;
  tab.title = titleForSession(sessionId);
  tab.setAttribute('role', 'tab');
  // Drag source for tab reorder / move / split (delegated in the grid).
  tab.draggable = true;

  const label = document.createElement('span');
  label.className = 'chat-tab-label';
  label.textContent = titleForSession(sessionId);

  const close = document.createElement('button');
  close.className = 'chat-tab-close';
  close.type = 'button';
  close.title = 'Close chat';
  close.setAttribute('aria-label', 'Close chat');
  close.innerHTML = ICONS.close;

  tab.appendChild(label);
  tab.appendChild(close);
  return tab;
}

// Flat pane: a full chat window — scrollable conversation + its own composer
// footer. The session title lives on the pane's title attribute (hover
// tooltip); the tab bar carries the visible label.
function buildPane(sessionId, title) {
  const pane = document.createElement('div');
  pane.className = 'chat-pane';
  pane.dataset.sessionId = sessionId;
  pane.title = title || 'Untitled session';

  const conv = document.createElement('div');
  conv.className = 'chat-pane-conversation';
  conv.appendChild(buildPaneEmpty());

  const composer = buildComposer();

  pane.appendChild(conv);
  pane.appendChild(composer);
  return pane;
}

// Builds the per-pane composer. Cards come first so they stack above the
// input row; popups are absolute and anchor to .chat-pane-composer
// (position:relative), so DOM order doesn't affect them. All IDs are
// per-pane; layout.js re-points the state refs on focus.
function buildComposer() {
  const composer = document.createElement('div');
  composer.className = 'chat-pane-composer';

  const permissionCard = document.createElement('div');
  permissionCard.id = 'permissionCard';
  permissionCard.className = 'permission-card';
  permissionCard.setAttribute('role', 'alertdialog');
  permissionCard.setAttribute('aria-label', 'Permission required');
  permissionCard.hidden = true;

  const questionCard = document.createElement('div');
  questionCard.id = 'questionCard';
  questionCard.className = 'question-card';
  questionCard.setAttribute('role', 'dialog');
  questionCard.setAttribute('aria-label', 'OpenCode question');
  questionCard.tabIndex = -1;
  questionCard.hidden = true;

  const slashPopup = document.createElement('div');
  slashPopup.id = 'slashPopup';
  slashPopup.className = 'slash-popup';
  slashPopup.hidden = true;

  const atPopup = document.createElement('div');
  atPopup.id = 'atPopup';
  atPopup.className = 'slash-popup';
  atPopup.hidden = true;

  const metaStrip = document.createElement('div');
  metaStrip.className = 'meta-strip';

  const agentWrap = document.createElement('span');
  agentWrap.className = 'meta-badge-wrap';
  const agentBtn = document.createElement('button');
  agentBtn.id = 'agentPickerBtn';
  agentBtn.className = 'meta-badge';
  agentBtn.type = 'button';
  agentBtn.title = 'Agent: default';
  agentBtn.disabled = true;
  const agentLabel = document.createElement('span');
  agentLabel.className = 'meta-badge-label';
  agentLabel.textContent = 'agent';
  const agentValue = document.createElement('span');
  agentValue.id = 'agentBadgeValue';
  agentValue.className = 'meta-badge-value';
  agentValue.textContent = 'default';
  const agentMenu = document.createElement('div');
  agentMenu.id = 'agentMenu';
  agentMenu.className = 'menu-popup';
  agentMenu.hidden = true;
  agentMenu.tabIndex = -1;
  agentBtn.appendChild(agentLabel);
  agentBtn.appendChild(agentValue);
  agentWrap.appendChild(agentBtn);
  agentWrap.appendChild(agentMenu);

  const modelWrap = document.createElement('span');
  modelWrap.className = 'meta-badge-wrap';
  const modelBtn = document.createElement('button');
  modelBtn.id = 'modelPickerBtn';
  modelBtn.className = 'meta-badge';
  modelBtn.type = 'button';
  modelBtn.title = 'Model: default';
  modelBtn.disabled = true;
  const modelLabel = document.createElement('span');
  modelLabel.className = 'meta-badge-label';
  modelLabel.textContent = 'model';
  const modelValue = document.createElement('span');
  modelValue.id = 'modelBadgeValue';
  modelValue.className = 'meta-badge-value';
  modelValue.textContent = 'model';
  const modelMenu = document.createElement('div');
  modelMenu.id = 'modelMenu';
  modelMenu.className = 'menu-popup';
  modelMenu.hidden = true;
  modelMenu.tabIndex = -1;
  modelBtn.appendChild(modelLabel);
  modelBtn.appendChild(modelValue);
  modelWrap.appendChild(modelBtn);
  modelWrap.appendChild(modelMenu);

  const thinkWrap = document.createElement('span');
  thinkWrap.className = 'meta-badge-wrap';
  const thinkBtn = document.createElement('button');
  thinkBtn.id = 'thinkingToggle';
  thinkBtn.className = 'meta-badge thinking-toggle';
  thinkBtn.type = 'button';
  thinkBtn.title = 'Show model thinking';
  thinkBtn.setAttribute('aria-pressed', 'false');
  thinkBtn.innerHTML = ICONS.thinking;
  const thinkLabel = document.createElement('span');
  thinkLabel.className = 'meta-badge-label';
  thinkLabel.textContent = 'thinking';
  const thinkValue = document.createElement('span');
  thinkValue.id = 'thinkingToggleValue';
  thinkValue.className = 'meta-badge-value thinking-toggle-value';
  thinkValue.textContent = 'off';
  thinkBtn.appendChild(thinkLabel);
  thinkBtn.appendChild(thinkValue);
  thinkWrap.appendChild(thinkBtn);

  metaStrip.appendChild(agentWrap);
  metaStrip.appendChild(modelWrap);
  metaStrip.appendChild(thinkWrap);

  const composerRow = document.createElement('div');
  composerRow.className = 'composer-row';
  const input = document.createElement('textarea');
  input.id = 'input';
  input.rows = 1;
  input.placeholder = 'Ask OpenCode\u2026';
  input.spellcheck = false;
  const sendBtn = document.createElement('button');
  sendBtn.id = 'sendBtn';
  sendBtn.className = 'send-btn';
  sendBtn.type = 'button';
  sendBtn.title = 'Send (Enter)';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.disabled = true;
  sendBtn.innerHTML = ICONS.send;
  composerRow.appendChild(input);
  composerRow.appendChild(sendBtn);

  const hint = document.createElement('div');
  hint.className = 'composer-hint';
  hint.textContent = 'Enter to send \u00B7 Shift+Enter for a new line';

  const contextUsage = document.createElement('div');
  contextUsage.id = 'contextUsageLine';
  contextUsage.className = 'context-usage-line';
  contextUsage.hidden = true;

  composer.appendChild(permissionCard);
  composer.appendChild(questionCard);
  composer.appendChild(slashPopup);
  composer.appendChild(atPopup);
  composer.appendChild(metaStrip);
  composer.appendChild(composerRow);
  composer.appendChild(hint);
  composer.appendChild(contextUsage);
  return composer;
}

function buildPaneEmpty() {
  const empty = document.createElement('div');
  empty.className = 'chat-pane-empty';
  empty.hidden = true;
  const icon = document.createElement('div');
  icon.className = 'chat-pane-empty-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = ICONS.chat;
  const title = document.createElement('div');
  title.className = 'chat-pane-empty-title';
  title.textContent = 'No messages yet';
  const sub = document.createElement('div');
  sub.className = 'chat-pane-empty-sub';
  sub.textContent = 'Ask from the composer below.';
  empty.appendChild(icon);
  empty.appendChild(title);
  empty.appendChild(sub);
  return empty;
}

function buildEmptyHint() {
  const hint = document.createElement('div');
  hint.className = 'grid-empty-hint';
  hint.hidden = true;
  const icon = document.createElement('div');
  icon.className = 'grid-empty-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 24 24" fill="none">' +
    '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const title = document.createElement('p');
  title.className = 'grid-empty-title';
  title.textContent = 'No chats in view';
  const sub = document.createElement('p');
  sub.className = 'grid-empty-sub';
  sub.textContent = 'Drop a session here to compare side by side.';
  hint.appendChild(icon);
  hint.appendChild(title);
  hint.appendChild(sub);
  return hint;
}

function buildDropZone() {
  const zone = document.createElement('div');
  zone.className = 'grid-drop-zone';
  zone.hidden = true;
  zone.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
    '<path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    '<span>Drop here to create a new group</span>';
  return zone;
}

// Drag-only 5-region overlay for edge-splitting. Hidden unless a drag is
// live (CSS: body.dragging .chat-drop-overlay); regions are fixed EDGE px
// bands with the center being everything inside them. Only the region under
// the pointer gets .active — no per-region event wiring.
function buildDropOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'chat-drop-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  ['top', 'bottom', 'left', 'right', 'center'].forEach(function (r) {
    const region = document.createElement('div');
    region.className = 'chat-drop-region ' + r;
    region.dataset.region = r;
    overlay.appendChild(region);
  });
  return overlay;
}

// Static chrome is in chat.html; re-create defensively if a full
// conversation wipe (clearConversation on the grid) removed it. Both start
// hidden — they are drag-only.
function ensureGridChrome() {
  if (!grid) {
    return;
  }
  if (!grid.querySelector('.grid-empty-hint')) {
    grid.insertBefore(buildEmptyHint(), grid.firstChild);
  }
  if (!grid.querySelector('.grid-drop-zone')) {
    grid.appendChild(buildDropZone());
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

// Rebuilds the structural DOM (splits + zones + tab bars) from `tree`,
// reusing existing pane elements by sessionId so rendered conversations
// survive. Panes no longer in the tree are removed.
function render() {
  if (!grid) {
    return;
  }
  ensureGridChrome();
  // Capture existing panes by sessionId before tearing down the structure.
  const panes = new Map();
  $$('.chat-pane', grid).forEach(function (p) {
    panes.set(p.dataset.sessionId, p);
  });
  $$('.chat-split, .chat-group', grid).forEach(function (el) {
    el.remove();
  });
  const zone = dropZone();
  let rootEl = null;
  if (tree) {
    rootEl = renderNode(tree, panes);
    if (zone) {
      grid.insertBefore(rootEl, zone);
    } else {
      grid.appendChild(rootEl);
    }
  }
  // Remove panes no longer referenced by the tree.
  const referenced = [];
  collectSessionIds(tree, referenced);
  panes.forEach(function (p, sid) {
    if (referenced.indexOf(sid) === -1) {
      p.remove();
    }
  });
  applyVisibility();
  syncDropZone();
  syncEmptyStates();
}

function renderNode(node, panes) {
  if (node.type === 'group') {
    const group = document.createElement('div');
    group.className = 'chat-group';
    group.dataset.groupId = node.id;
    group.dataset.panes = String(node.sessionIds.length);

    const tabbar = buildTabBar();
    group.appendChild(tabbar);

    const body = document.createElement('div');
    body.className = 'chat-group-body';
    group.appendChild(body);

    node.sessionIds.forEach(function (sid) {
      let pane = panes.get(sid);
      if (!pane) {
        pane = buildPane(sid, titleForSession(sid));
        panes.set(sid, pane);
      }
      body.appendChild(pane);
      tabbar.appendChild(buildTab(sid));
    });
    group.appendChild(buildDropOverlay());
    return group;
  }
  const split = document.createElement('div');
  split.className = 'chat-split';
  split.dataset.orientation = node.orientation === 'vertical' ? 'vertical' : 'horizontal';
  node.children.forEach(function (child) {
    split.appendChild(renderNode(child, panes));
  });
  return split;
}

// Shows the active tab's pane per zone (hides the rest) and marks the active
// tab. Driven by the webview-local zoneActive map (fallback: first tab).
function applyVisibility() {
  if (!grid) {
    return;
  }
  $$('.chat-group', grid).forEach(function (group) {
    const gid = group.dataset.groupId;
    const sids = $$('.chat-tab', group).map(function (t) {
      return t.dataset.sessionId;
    });
    let active = zoneActive.get(gid);
    if (!active || sids.indexOf(active) === -1) {
      active = sids[0] || null;
    }
    $$('.chat-pane', group).forEach(function (pane) {
      pane.hidden = pane.dataset.sessionId !== active;
    });
    $$('.chat-tab', group).forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.sessionId === active);
    });
  });
}

// The drop strip is drag-only: always hidden here, revealed by onGridDragOver.
function syncDropZone() {
  const zone = dropZone();
  if (zone) {
    zone.hidden = true;
  }
}

// ── Focus ────────────────────────────────────────────────────────────────

function clearFocus() {
  if (!grid) {
    return;
  }
  $$('.chat-pane', grid).forEach(function (pane) {
    pane.removeAttribute('data-focused');
  });
  state.conversation = grid;
  state.activeSessionId = null;
  clearComposerRefs();
  updateSessionListHighlight();
  applyVisibility();
  notifyFocusChange(null);
}

// Focuses a pane: re-points state.conversation at its message list and the
// composer refs at its own composer, then scrolls it into view. All message
// rendering (messages/streaming/composer/cards/pickers) reads these shared
// refs, so this single re-point keeps them pane-aware.
export function focusPane(sessionId) {
  const pane = findPane(sessionId);
  if (!pane) {
    return false;
  }
  $$('.chat-pane', grid).forEach(function (p) {
    p.removeAttribute('data-focused');
  });
  pane.setAttribute('data-focused', '');
  // Remember the zone's active tab (webview-local, not persisted).
  const group = pane.closest('.chat-group');
  if (group) {
    zoneActive.set(group.dataset.groupId, sessionId);
  }
  const conv = pane.querySelector('.chat-pane-conversation');
  if (conv) {
    state.conversation = conv;
  }
  syncComposerRefs(pane);
  state.activeSessionId = sessionId;
  syncPaneEmpty(pane);
  updateSessionListHighlight();
  applyVisibility();
  // Bring the newly focused pane into view ('nearest' avoids jumping when it
  // is already fully visible; smooth during interaction, instant on restore).
  pane.scrollIntoView({ block: 'nearest', behavior: applyingLayout ? 'auto' : 'smooth' });
  notifyFocusChange(sessionId);
  persist();
  return true;
}

// ── Open / close sessions ────────────────────────────────────────────────

// Opens a session: if its pane already exists, focus it; else add it as a tab
// to the zone containing the focused session (else the last zone, else create
// the first zone as root).
export function openSession(sessionId) {
  if (!grid) {
    return null;
  }
  const pane = findPane(sessionId);
  if (pane) {
    focusPane(sessionId);
    return pane;
  }
  let gid = null;
  if (state.activeSessionId) {
    const fp = findPane(state.activeSessionId);
    if (fp && fp.closest('.chat-group')) {
      gid = fp.closest('.chat-group').dataset.groupId;
    }
  }
  if (!gid) {
    const last = lastGroupNode(tree);
    if (last) {
      gid = last.id;
    }
  }
  if (gid && findGroupNode(tree, gid)) {
    findGroupNode(tree, gid).sessionIds.push(sessionId);
  } else {
    createNewZone(sessionId);
  }
  render();
  focusPane(sessionId);
  syncEmptyStates();
  persist();
  return findPane(sessionId);
}

function createNewZone(sessionId) {
  const g = { type: 'group', id: nextGroupId(), sessionIds: [sessionId] };
  if (!tree) {
    tree = g;
  } else if (tree.type === 'split') {
    tree.children.push(g);
  } else {
    tree = { type: 'split', orientation: 'vertical', children: [tree, g] };
  }
}

// Removes a session from the tree, collapsing empty groups and single-child
// splits. Returns true if anything changed.
function removeFromNode(node, sessionId) {
  if (node.type === 'group') {
    const idx = node.sessionIds.indexOf(sessionId);
    if (idx === -1) {
      return { node: node, changed: false };
    }
    node.sessionIds.splice(idx, 1);
    return { node: node.sessionIds.length ? node : null, changed: true };
  }
  let changed = false;
  const kept = [];
  (node.children || []).forEach(function (child) {
    const r = removeFromNode(child, sessionId);
    if (r.changed) {
      changed = true;
    }
    if (r.node) {
      kept.push(r.node);
    }
  });
  node.children = kept;
  let result = node;
  if (kept.length === 1) {
    result = kept[0];
  } else if (kept.length === 0) {
    result = null;
  }
  return { node: result, changed: changed };
}

// Closes a tab (tab close × or session deleted). Tab close != delete: the
// session stays in the Sessions list. Focus repair: right neighbor, else
// left neighbor, else last session in the tree, else clear.
function closeSession(sessionId) {
  if (!tree) {
    return;
  }
  // Capture the closed tab's zone order for focus repair.
  const zoneNode = findZoneNodeContaining(tree, sessionId);
  const tabs = zoneNode ? zoneNode.sessionIds.slice() : [];
  const idx = tabs.indexOf(sessionId);
  const right = idx >= 0 ? tabs[idx + 1] : null;
  const left = idx > 0 ? tabs[idx - 1] : null;

  const r = removeFromNode(tree, sessionId);
  if (!r.changed) {
    return;
  }
  tree = r.node;
  render();

  if (state.activeSessionId === sessionId || !findPane(state.activeSessionId)) {
    let next = right;
    if (!next || !findPane(next)) {
      next = left;
    }
    if (!next || !findPane(next)) {
      next = lastSessionInTree();
    }
    if (next && findPane(next)) {
      focusPane(next);
    } else {
      clearFocus();
    }
  }
  syncEmptyStates();
  persist();
}

function lastSessionInTree() {
  const ids = [];
  collectSessionIds(tree, ids);
  return ids.length ? ids[ids.length - 1] : null;
}

// ── Drag & drop ──────────────────────────────────────────────────────────
// Sources: .session-row (session list) and .chat-tab (grid). Both delegated;
// the shared startDrag() sets the dataTransfer payload, the move/copy effect
// (open in tree → move, else copy), and the source visuals.
//
// Targets are resolved from pointer coordinates, not e.target: while a drag
// is live the drop overlay covers each zone, so the event target is a region
// child rather than the underlying tab bar / body.
//   - .chat-tabbar          → reorder / insert-at-position (tab-gap)
//   - .chat-group body      → center: move into zone; edges: split
//   - empty grid / strip    → create a new zone

const EDGE = 22; // px — split-band depth; keep in sync with .chat-drop-region CSS

function onDragStart(e) {
  const row = e.target.closest('.session-row');
  if (!row || !row.dataset.sessionId) {
    return;
  }
  // Dragging from the delete button would be a mis-gesture — ignore it.
  if (e.target.closest('[data-delete]')) {
    e.preventDefault();
    return;
  }
  startDrag(e, row.dataset.sessionId, row);
}

function onTabDragStart(e) {
  const tab = e.target.closest('.chat-tab');
  if (!tab || !tab.dataset.sessionId) {
    return;
  }
  // Dragging from the close button would be a mis-gesture — ignore it.
  if (e.target.closest('.chat-tab-close')) {
    e.preventDefault();
    return;
  }
  startDrag(e, tab.dataset.sessionId, tab);
}

function startDrag(e, sessionId, sourceEl) {
  e.dataTransfer.setData(DRAG_TYPE, sessionId);
  e.dataTransfer.setData('text/plain', sessionId);
  const isOpen = findZoneNodeContaining(tree, sessionId) !== null;
  e.dataTransfer.effectAllowed = isOpen ? 'move' : 'copy';
  dragSessionId = sessionId;
  dragSourceEl = sourceEl;
  sourceEl.classList.add('dragging');
  document.body.classList.add('dragging');
  // Guarantee cleanup even when a drop re-renders and detaches the source:
  // `dragend` then fires on the detached node and no longer bubbles to the
  // grid/session-list, which would leave `body.dragging` stuck — and the
  // `body.dragging .chat-tab:not(.dragging) { pointer-events: none }` rule
  // would permanently disable dragging. A direct once-listener always runs.
  sourceEl.addEventListener('dragend', onDragEnd, { once: true });
}

function onDragEnd() {
  dragSessionId = null;
  document.body.classList.remove('dragging');
  if (dragSourceEl) {
    // The element may already be detached (a drop re-rendered the grid) —
    // removing a class from a detached node is harmless.
    dragSourceEl.classList.remove('dragging');
    dragSourceEl = null;
  }
  if (grid) {
    $$('.session-row.dragging', document).forEach(function (row) {
      row.classList.remove('dragging');
    });
    resetDragTargets();
  }
}

function isGridDrag(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) {
    return false;
  }
  return Array.prototype.indexOf.call(e.dataTransfer.types, DRAG_TYPE) !== -1;
}

function clearDragOver() {
  if (!grid) {
    return;
  }
  grid.classList.remove('drag-over');
  $$('.drag-over', grid).forEach(function (el) {
    el.classList.remove('drag-over');
  });
  $$('.chat-tab.tab-gap-left, .chat-tab.tab-gap-right', grid).forEach(function (tab) {
    tab.classList.remove('tab-gap-left', 'tab-gap-right');
  });
  $$('.chat-drop-region.active', grid).forEach(function (region) {
    region.classList.remove('active');
  });
}

// Hides the drag-only empty targets (hint + drop strip).
function hideEmptyDragTarget() {
  const hint = grid.querySelector('.grid-empty-hint');
  const zone = dropZone();
  if (hint) {
    hint.hidden = true;
  }
  if (zone) {
    zone.hidden = true;
  }
}

// Full teardown of drag visuals: clear highlights, hide the drag-only empty
// targets, and restore the normal empty-state overlays.
function resetDragTargets() {
  clearDragOver();
  hideEmptyDragTarget();
  syncEmptyStates();
}

// ── Drop geometry ────────────────────────────────────────────────────────

// Insert index in a tab bar from the pointer X: each tab's left half inserts
// before it, right half after; past the last tab appends.
function computeTabInsertIndex(tabbar, clientX) {
  const tabs = $$('.chat-tab', tabbar);
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i].getBoundingClientRect();
    if (clientX < r.left + r.width / 2) {
      return i;
    }
  }
  return tabs.length;
}

// Gap indicator on the adjacent tab: insert-before at i → tab-gap-left on
// tab i; append (i === length) → tab-gap-right on the last tab.
function highlightTabGap(tabbar, index) {
  const tabs = $$('.chat-tab', tabbar);
  tabs.forEach(function (tab, i) {
    tab.classList.remove('tab-gap-left', 'tab-gap-right');
    if (i === index) {
      tab.classList.add('tab-gap-left');
    } else if (i === index - 1) {
      tab.classList.add('tab-gap-right');
    }
  });
}

// What a drop on a zone means, from the pointer position. The tab bar wins
// its whole band (reorder); the body is the 5-region split/move overlay.
function dropTargetMode(group, e) {
  const r = group.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const tabbar = group.querySelector('.chat-tabbar');
  if (tabbar) {
    const tb = tabbar.getBoundingClientRect();
    if (e.clientY >= tb.top && e.clientY <= tb.bottom) {
      return { mode: 'tabbar' };
    }
  }
  if (y < EDGE) {
    return { mode: 'region', region: 'top' };
  }
  if (y > r.height - EDGE) {
    return { mode: 'region', region: 'bottom' };
  }
  if (x < EDGE) {
    return { mode: 'region', region: 'left' };
  }
  if (x > r.width - EDGE) {
    return { mode: 'region', region: 'right' };
  }
  return { mode: 'region', region: 'center' };
}

function highlightRegion(group, region) {
  $$('.chat-drop-region', group).forEach(function (el) {
    el.classList.toggle('active', el.dataset.region === region);
  });
}

// ── Drag-over / drop ─────────────────────────────────────────────────────

function onGridDragOver(e) {
  if (!isGridDrag(e)) {
    return;
  }
  e.preventDefault();
  const isOpen = dragSessionId && findZoneNodeContaining(tree, dragSessionId) !== null;
  e.dataTransfer.dropEffect = isOpen ? 'move' : 'copy';
  const group = e.target.closest('.chat-group');
  clearDragOver();
  hideEmptyDragTarget();
  if (group) {
    group.classList.add('drag-over');
    const mode = dropTargetMode(group, e);
    if (mode.mode === 'tabbar') {
      const tabbar = group.querySelector('.chat-tabbar');
      highlightTabGap(tabbar, computeTabInsertIndex(tabbar, e.clientX));
    } else {
      highlightRegion(group, mode.region);
    }
    return;
  }
  // Over empty grid space: reveal the create-a-zone affordance. The hint
  // covers a pane-less grid; the drop strip covers a grid with zones.
  const hasGroups = grid.querySelector('.chat-group') !== null;
  if (hasGroups) {
    const zone = dropZone();
    if (zone) {
      zone.hidden = false;
      zone.classList.add('drag-over');
    }
  } else {
    const hint = grid.querySelector('.grid-empty-hint');
    if (hint) {
      hint.hidden = false;
      hint.classList.add('drag-over');
    }
    // The absolute empty-state overlays would cover the hint — hide them
    // for the duration of the drag.
    state.emptyNoSessions.hidden = true;
    state.emptyConversation.hidden = true;
  }
}

function onGridDragLeave(e) {
  const to = e.relatedTarget;
  if (to && grid.contains(to)) {
    return;
  }
  resetDragTargets();
}

// Unified drop: one handler decides semantics by membership. A session that
// is already open moves / splits / reorders; one that is not (dragged from
// the list) opens as a tab at the drop point.
function onGridDrop(e) {
  if (!isGridDrag(e)) {
    return;
  }
  e.preventDefault();
  const sessionId = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain');
  if (!sessionId) {
    resetDragTargets();
    return;
  }
  const group = e.target.closest('.chat-group');
  if (!group) {
    // Empty grid / drop strip → create the first (or another) zone.
    removeSessionIfOpen(sessionId);
    createNewZone(sessionId);
    render();
    focusPane(sessionId);
    resetDragTargets();
    syncEmptyStates();
    persist();
    return;
  }
  const gid = group.dataset.groupId;
  const target = findGroupNode(tree, gid);
  const inZone = target !== null && target.sessionIds.indexOf(sessionId) !== -1;
  const isOpen = findZoneNodeContaining(tree, sessionId) !== null;
  const mode = dropTargetMode(group, e);
  if (mode.mode === 'tabbar') {
    const tabbar = group.querySelector('.chat-tabbar');
    const index = computeTabInsertIndex(tabbar, e.clientX);
    if (inZone) {
      reorderTab(gid, target.sessionIds.indexOf(sessionId), index);
    } else if (isOpen) {
      moveTab(sessionId, gid, index);
    } else {
      openTabInZone(sessionId, gid, index);
    }
  } else if (mode.region === 'center') {
    if (inZone) {
      focusPane(sessionId);
    } else if (isOpen) {
      moveTab(sessionId, gid, -1); // append
    } else {
      openTabInZone(sessionId, gid, -1);
    }
  } else {
    splitZone(gid, mode.region, sessionId);
  }
  resetDragTargets();
  syncEmptyStates();
  persist();
}

// Reorders a tab within its own zone. `index` is the insert position in the
// ORIGINAL tab order; removal shifts it, so adjust before splicing.
function reorderTab(gid, fromIndex, index) {
  const g = findGroupNode(tree, gid);
  if (!g || fromIndex < 0 || fromIndex >= g.sessionIds.length) {
    return;
  }
  const ids = g.sessionIds;
  const sid = ids[fromIndex];
  ids.splice(fromIndex, 1);
  if (index > fromIndex) {
    index -= 1;
  }
  index = Math.max(0, Math.min(index, ids.length));
  ids.splice(index, 0, sid);
  render();
  focusPane(sid);
}

// Moves an open session into another zone at `index` (-1 appends). The
// source zone collapses via removeFromNode if it empties.
function moveTab(sessionId, gid, index) {
  removeSessionIfOpen(sessionId);
  const g = findGroupNode(tree, gid);
  if (!g) {
    return;
  }
  if (index < 0 || index > g.sessionIds.length) {
    index = g.sessionIds.length;
  }
  g.sessionIds.splice(index, 0, sessionId);
  render();
  focusPane(sessionId);
}

// Opens a not-yet-open session as a tab at `index` (-1 appends).
function openTabInZone(sessionId, gid, index) {
  const g = findGroupNode(tree, gid);
  if (!g) {
    return;
  }
  if (index < 0 || index > g.sessionIds.length) {
    index = g.sessionIds.length;
  }
  g.sessionIds.splice(index, 0, sessionId);
  render();
  focusPane(sessionId);
}

// Edge-split: wraps the target zone and a fresh zone (holding the dragged
// session) in a new split. top/bottom → vertical (new zone above/below);
// left/right → horizontal (new zone left/right). If the target zone holds
// only the dragged session it collapses away and the new zone simply takes
// its place (self-heal — no empty zone is left behind).
function splitZone(groupId, edge, sessionId) {
  const g = findGroupNode(tree, groupId);
  if (!g) {
    return;
  }
  const newGroup = { type: 'group', id: nextGroupId(), sessionIds: [sessionId] };
  const onlyTab = g.sessionIds.length === 1 && g.sessionIds[0] === sessionId;
  if (onlyTab) {
    const parent = findParentNode(tree, groupId);
    if (parent) {
      parent.children[parent.index] = newGroup;
    } else {
      tree = newGroup;
    }
  } else {
    removeSessionIfOpen(sessionId);
    const g2 = findGroupNode(tree, groupId);
    if (!g2) {
      return;
    }
    const orientation = edge === 'top' || edge === 'bottom' ? 'vertical' : 'horizontal';
    const before = edge === 'top' || edge === 'left';
    const split = {
      type: 'split',
      orientation: orientation,
      children: before ? [newGroup, g2] : [g2, newGroup],
    };
    const parent = findParentNode(tree, groupId);
    if (parent) {
      parent.children[parent.index] = split;
    } else {
      tree = split;
    }
  }
  render();
  focusPane(sessionId);
}

function removeSessionIfOpen(sessionId) {
  if (!tree) {
    return;
  }
  const r = removeFromNode(tree, sessionId);
  if (r.changed) {
    tree = r.node;
  }
}

// ── Grid clicks (delegated; survives re-renders) ─────────────────────────

function onGridClick(e) {
  const tabClose = e.target.closest('.chat-tab-close');
  if (tabClose) {
    const tab = tabClose.closest('.chat-tab');
    if (tab && tab.dataset.sessionId) {
      closeSession(tab.dataset.sessionId);
    }
    return;
  }
  const tab = e.target.closest('.chat-tab');
  if (tab && tab.dataset.sessionId) {
    if (tab.dataset.sessionId !== state.activeSessionId) {
      focusPane(tab.dataset.sessionId);
    }
    return;
  }
  const pane = e.target.closest('.chat-pane');
  if (pane && pane.dataset.sessionId && !pane.hasAttribute('data-focused')) {
    focusPane(pane.dataset.sessionId);
  }
}

// ── Empty states ─────────────────────────────────────────────────────────

function syncPaneEmpty(pane) {
  const conv = pane.querySelector('.chat-pane-conversation');
  if (!conv) {
    return;
  }
  let empty = conv.querySelector('.chat-pane-empty');
  if (!empty) {
    empty = buildPaneEmpty();
    conv.appendChild(empty);
  }
  empty.hidden = conv.querySelector('.message') !== null;
}

// Coordinates the non-drag empty surfaces: #emptyNoSessions /
// #emptyConversation (absolute overlays) and per-pane placeholders. The
// grid hint / drop strip are drag-only and are NOT touched here.
export function syncEmptyStates() {
  if (!grid) {
    return;
  }
  ensureGridChrome();
  const hasPanes = grid.querySelector('.chat-pane') !== null;
  const showNoSessions = state.connected && state.sessions.length === 0;
  const showNoConv = state.connected && !state.loading && state.activeSessionId !== null && !hasPanes;

  state.emptyNoSessions.hidden = !showNoSessions;
  state.emptyConversation.hidden = !showNoConv;
  $$('.chat-pane', grid).forEach(syncPaneEmpty);
}

// ── Serialization / persistence ──────────────────────────────────────────

export function getLayout() {
  return {
    version: 2,
    root: tree,
    focusedSessionId: state.activeSessionId,
  };
}

function persist() {
  if (applyingLayout) {
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(function () {
    post({ type: 'setChatLayout', layout: getLayout() });
  }, 100);
}

// ── Public API ───────────────────────────────────────────────────────────

export function getGrid() {
  return grid;
}

// Routing helper: the `.chat-pane-conversation` message list for a session's
// pane, or null when the session has no open pane. All session-scoped message
// handlers (history/delta/message/busy/nativeResult/...) resolve their target
// container through this so non-focused panes render in place.
export function getPaneConversation(sessionId) {
  const pane = findPane(sessionId);
  if (!pane) {
    return null;
  }
  return pane.querySelector('.chat-pane-conversation');
}

// The currently focused session id (null when no pane is focused). The
// composer and pickers read this instead of the legacy global fields.
export function getFocusedSessionId() {
  return state.activeSessionId;
}

// Adopts a host-provided layout ({version, root, focusedSessionId}): replaces
// `tree`, re-renders (preserving existing pane DOM by sessionId so rendered
// conversations survive), then focuses. persist() is suppressed during the
// rebuild so the webview never echoes the host's own layout back.
export function applyLayout(layout) {
  if (!grid) {
    return;
  }
  applyingLayout = true;
  try {
    ensureGridChrome();
    tree = sanitizeTree(layout && layout.root);
    // Prune webview-local zoneActive entries for zones that no longer exist.
    const gids = [];
    collectGroupIds(tree, gids);
    zoneActive.forEach(function (_v, gid) {
      if (gids.indexOf(gid) === -1) {
        zoneActive.delete(gid);
      }
    });
    render();
    const focused = layout && layout.focusedSessionId;
    if (focused && findPane(focused)) {
      focusPane(focused);
    } else {
      const first = grid.querySelector('.chat-pane');
      if (first) {
        focusPane(first.dataset.sessionId);
      } else {
        clearFocus();
      }
    }
    syncEmptyStates();
  } finally {
    applyingLayout = false;
  }
}

// Closes the tab for a deleted session (session stays in the list; the host
// removes the row separately). Repairs focus.
export function handleSessionDeleted(sessionId) {
  closeSession(sessionId);
}

// Updates a session's pane tooltip and its tab's label + tooltip.
export function setSessionTitle(sessionId, title) {
  const label = title || titleForSession(sessionId);
  const pane = findPane(sessionId);
  if (pane) {
    pane.title = label;
  }
  if (grid) {
    const tab = grid.querySelector('.chat-tab[data-session-id="' + cssEscape(sessionId) + '"]');
    if (tab) {
      const lbl = tab.querySelector('.chat-tab-label');
      if (lbl) {
        lbl.textContent = label;
      }
      tab.title = label;
    }
  }
}

// Wires drag & drop + delegated grid clicks. Call once from app.js init
// after the state.* DOM refs are set. state.conversation starts on the grid
// itself (a safe scroll target) and composer refs start null until a pane is
// focused (focusPane re-points them).
export function initLayout() {
  grid = document.getElementById('chatGrid');
  state.conversation = grid;
  if (!grid) {
    return;
  }
  clearComposerRefs();
  ensureGridChrome();
  syncDropZone();
  syncEmptyStates();

  state.sessionList.addEventListener('dragstart', onDragStart);
  state.sessionList.addEventListener('dragend', onDragEnd);
  grid.addEventListener('dragstart', onTabDragStart);
  grid.addEventListener('dragend', onDragEnd);
  grid.addEventListener('dragover', onGridDragOver);
  grid.addEventListener('dragleave', onGridDragLeave);
  grid.addEventListener('drop', onGridDrop);
  grid.addEventListener('click', onGridClick);
}
