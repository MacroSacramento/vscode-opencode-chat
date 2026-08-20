import { state } from './state.js';
import { post, showProgress, relativeTime, showToast } from './utils.js';
import { onDelta } from './streaming.js';
import { upsertMessage, renderHistory } from './messages.js';
import {
  applyConnected,
  applySessions,
  removeSession,
  renderSessionList,
  setSubagentsToggle,
  updateSubagentsToggle,
  updateEmptyStates,
} from './sessions.js';
import {
  updateComposerState,
  autoGrow,
  handleSlashTyping,
  moveSlashIndex,
  selectSlashItem,
  closeSlashPopup,
  send,
  stop,
  setBusy,
  appendNativeResult,
  slashItems,
  slashIndex,
  atItems,
  atIndex,
  handleAtTyping,
  moveAtIndex,
  selectAtItem,
  closeAtPopup,
  renderAtPopup,
  insertContext,
} from './composer.js';
import {
  updateMetaBadges,
  renderAgentMenu,
  renderModelMenu,
  renderVariantMenu,
  updateThinkingToggle,
  toggleThinking,
  openAgentMenu,
  closeAgentMenu,
  openModelMenu,
  closeModelMenu,
  openVariantMenu,
  closeVariantMenu,
  selectAgent,
  selectModel,
  selectVariant,
  closeHelp,
  moveAgentIndex,
  moveModelIndex,
  moveVariantIndex,
  selectCurrentAgent,
  selectCurrentModel,
  selectCurrentVariant,
  clearModelSearch,
  focusModelSearch,
} from './pickers.js';
import {
  dismissQuestion,
  sendQuestion,
  showPermissionCard,
  hidePermissionCard,
  showQuestionCard,
  hideQuestionCard,
} from './cards.js';
import { initCodeCopy } from './copy.js';
import {
  initLayout,
  applyLayout,
  openSession,
  handleSessionDeleted,
  getPaneConversation,
  setOnFocusChange,
  focusPane,
  getGrid,
} from './layout.js';

function $(id) {
  return document.getElementById(id);
}

// ── Host message routing ─────────────────────────────────────────────────

function route(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return;
  }
  switch (msg.type) {
    case 'connected':
      applyConnected(msg.connected === true);
      break;
    case 'chatLayout':
      applyLayout(msg.layout);
      break;
    case 'sessions':
      applySessions(msg);
      break;
    case 'history':
      // Route into the session's pane; drop if no pane is open for it.
      if (getPaneConversation(msg.sessionId)) {
        renderHistory(msg, msg.sessionId);
      }
      break;
    case 'delta':
      onDelta(msg, msg.sessionId);
      break;
    case 'message':
      upsertMessage(msg.message, msg.sessionId);
      break;
    case 'busy':
      setBusy(msg.busy === true, msg.sessionId);
      break;
    case 'sessionDeleted':
      // Remove the pane first (repairs focus), then the list row + per-pane
      // state.
      handleSessionDeleted(msg.sessionId);
      removeSession(msg.sessionId);
      break;
    case 'catalog':
      state.catalog = msg;
      updateMetaBadges();
      if (state.agentMenu && !state.agentMenu.hidden) {
        renderAgentMenu();
      }
      if (state.modelMenu && !state.modelMenu.hidden) {
        renderModelMenu();
        focusModelSearch();
      }
      if (state.variantMenu && !state.variantMenu.hidden) {
        renderVariantMenu();
      }
      if (state.atPopup && !state.atPopup.hidden) {
        renderAtPopup();
      }
      break;
    case 'files':
      state.files = Array.isArray(msg.files) ? msg.files : [];
      if (state.atPopup && !state.atPopup.hidden) {
        renderAtPopup();
      }
      break;
    case 'sessionMeta':
      if (msg.sessionId) {
        if (typeof msg.agent === 'string') {
          state.paneAgent[msg.sessionId] = msg.agent;
        }
        if (msg.model && typeof msg.model === 'object') {
          state.paneModel[msg.sessionId] = { providerID: msg.model.providerID, modelID: msg.model.modelID };
        }
        if (typeof msg.variant === 'string') {
          state.paneVariant[msg.sessionId] = msg.variant;
        }
        // Only update usage when present: setAgent/setModel echoes omit it,
        // and nulling it here would wipe the value between updates.
        if (msg.usage) {
          state.paneUsage[msg.sessionId] = msg.usage;
        }
        // Badges are per-pane — refresh all of them.
        updateMetaBadges();
        if (msg.sessionId === state.activeSessionId) {
          if (state.agentMenu && !state.agentMenu.hidden) {
            renderAgentMenu();
          }
          if (state.modelMenu && !state.modelMenu.hidden) {
            renderModelMenu();
            focusModelSearch();
          }
          if (state.variantMenu && !state.variantMenu.hidden) {
            renderVariantMenu();
          }
        }
      }
      break;
    case 'nativeResult':
      appendNativeResult(msg, msg.sessionId);
      break;
    case 'subagents':
      if (msg.sessionId) {
        state.paneSubagents[msg.sessionId] = Array.isArray(msg.sessions) ? msg.sessions : [];
        if (msg.sessionId === state.activeSessionId) {
          state.subagents = state.paneSubagents[msg.sessionId];
          renderSessionList();
        }
      }
      break;
    case 'permission':
      // Store per-pane and render into the OWNING pane's card (not the
      // focused one) — the card stays visible in its pane regardless of
      // focus.
      if (msg.request) {
        const sid = msg.sessionId || msg.request.sessionID;
        if (sid) {
          state.panePendingPermission[sid] = msg.request;
          showPermissionCard(msg.request, sid);
        }
      }
      break;
    case 'permissionResolved':
      for (const sid in state.panePendingPermission) {
        if (state.panePendingPermission[sid] && state.panePendingPermission[sid].id === msg.requestID) {
          delete state.panePendingPermission[sid];
          hidePermissionCard(sid);
          break;
        }
      }
      break;
    case 'question':
      if (msg.request) {
        const sid = msg.sessionId || msg.request.sessionID;
        if (sid) {
          state.panePendingQuestion[sid] = msg.request;
          showQuestionCard(msg.request, sid);
        }
      }
      break;
    case 'questionResolved':
      for (const sid in state.panePendingQuestion) {
        if (state.panePendingQuestion[sid] && state.panePendingQuestion[sid].id === msg.requestID) {
          delete state.panePendingQuestion[sid];
          hideQuestionCard(sid);
          break;
        }
      }
      break;
    case 'error':
      showToast(msg.message);
      // A failed abort (host surfaced an error) shouldn't strand the button
      // on the disabled "Stopping…" pill — restore the clickable Stop so the
      // user can retry while the stream is still running.
      if (state.stopping) {
        const sid = state.activeSessionId;
        if (sid) {
          state.paneStopping[sid] = false;
          state.paneStoppedStream[sid] = false;
        }
        state.stopping = false;
        state.stoppedStream = false;
        updateComposerState();
      }
      break;
    case 'insertContext':
      insertContext(typeof msg.text === 'string' ? msg.text : '', typeof msg.label === 'string' ? msg.label : '');
      break;
    case 'sessionPanelCollapsed':
      applySessionPanelCollapsed(msg.collapsed === true);
      break;
    default:
      break;
  }
}

// Applies the session-panel collapsed state (class + toggle title). Callers
// pass the host's persisted value on restore, or the new value on toggle.
function applySessionPanelCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', collapsed);
  if (state.sessionToggle) {
    state.sessionToggle.title = collapsed ? 'Show session list' : 'Hide session list';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

function init() {
  state.app = $('app');
  state.disconnected = $('disconnected');
  state.sessionList = $('sessionList');
  state.sessionCount = $('sessionCount');
  state.sessionToggle = $('sessionToggle');
  state.progress = $('progress');
  state.emptyNoSessions = $('emptyNoSessions');
  state.emptyConversation = $('emptyConversation');
  state.newSessionBtn = $('newSessionBtn');
  state.retryBtn = $('retryBtn');
  state.emptyNewBtn = $('emptyNewBtn');
  state.toast = $('toast');
  state.subagentsToggle = $('subagentsToggle');
  state.helpOverlay = $('helpOverlay');
  state.helpList = $('helpList');
  // NOTE: the composer DOM refs (state.input, state.sendBtn, the popups,
  // meta badges, menus, cards) are NOT assigned here — those elements no
  // longer exist globally. layout.js's syncComposerRefs re-points them at the
  // focused pane's composer on every focus change (and nulls them otherwise).

  // The chat grid owns pane rendering/focus; it re-points state.conversation
  // at the focused pane's message list. Must run after the state.* DOM refs
  // above are assigned.
  initLayout();

  // On pane focus change: refresh the composer, meta badges, and the
  // session-list subagent rows for the newly focused session. Cards are
  // per-pane (rendered in their owning pane) so they need no focus gating.
  setOnFocusChange(function (sessionId) {
    updateComposerState();
    updateMetaBadges();
    // Newly created panes start with the toggle's default "off" markup; sync
    // it to the persisted preference whenever focus lands on a pane.
    updateThinkingToggle();
    state.subagents = sessionId ? (state.paneSubagents[sessionId] || []) : [];
    setSubagentsToggle(false);
    renderSessionList();
  });

  // Delegated listener for code-block copy buttons (survives streaming
  // re-renders; wired once, never re-wired).
  initCodeCopy();

  // Restore the thinking preference; off by default. Storage can be
  // unavailable in some webview contexts — fall back to the default rather
  // than letting a read failure kill the whole webview.
  let showThinking = false;
  try {
    showThinking = localStorage.getItem('opencodeChat.showThinking') === '1';
  } catch (e) {
    showThinking = false;
  }
  state.showThinking = showThinking;
  updateThinkingToggle();

  window.addEventListener('message', function (e) {
    // NOTE: no `e.source === window` check — VS Code delivers host messages
    // (webview.postMessage) through its own bridge, where event.source is not
    // the window. A source guard here silently drops every host message
    // (connected/sessions/delta), leaving the panel stuck on the retry
    // screen. Trust the origin: the webview is sandboxed + nonce-CSP'd, and
    // only the host can post into it.
    route(e.data);
  });

  state.sessionToggle.addEventListener('click', function () {
    const collapsed = !document.body.classList.contains('collapsed');
    applySessionPanelCollapsed(collapsed);
    post({ type: 'setSessionPanelCollapsed', collapsed });
  });

  state.sessionList.addEventListener('click', function (e) {
    const row = e.target.closest('[data-session-id]');
    if (!row) {
      return;
    }
    const id = row.dataset.sessionId;
    if (e.target.closest('[data-delete]')) {
      post({ type: 'deleteSession', sessionId: id });
      return;
    }
    if (id !== state.activeSessionId) {
      // Opening a brand-new pane triggers a host history load; show the
      // progress bar only then (an already-open pane needs no reload).
      if (!getPaneConversation(id)) {
        showProgress();
      }
      openSession(id);
    }
  });

  state.newSessionBtn.addEventListener('click', function () {
    post({ type: 'newSession' });
  });
  state.emptyNewBtn.addEventListener('click', function () {
    post({ type: 'newSession' });
  });
  state.retryBtn.addEventListener('click', function () {
    post({ type: 'refreshSessions' });
  });

  state.subagentsToggle.addEventListener('click', function () {
    const sessionId = state.activeSessionId;
    if (!sessionId) {
      return;
    }
    const next = !state.subagentsVisible;
    setSubagentsToggle(next);
    if (!next) {
      state.subagents = [];
      renderSessionList();
    }
    post({ type: 'setSubagentsVisible', sessionId: sessionId, visible: next });
  });

  // ── Delegated composer listeners ────────────────────────────────────────
  // The composer DOM lives per-pane (IDs are not globally unique), so these
  // are delegated on the grid. layout.js's onGridClick (registered first)
  // focuses the clicked pane BEFORE these run, re-pointing the state.*
  // composer refs at that pane — so the handlers below operate on the right
  // pane's elements. The input/keydown handlers also focus-first defensively.

  const grid = getGrid();

  grid.addEventListener('input', function (e) {
    const ta = e.target.closest('.chat-pane-composer textarea');
    if (!ta) {
      return;
    }
    const pane = ta.closest('.chat-pane');
    if (pane && pane.dataset.sessionId && !pane.hasAttribute('data-focused')) {
      focusPane(pane.dataset.sessionId);
    }
    autoGrow();
    updateComposerState();
    handleSlashTyping();
    handleAtTyping();
  });

  grid.addEventListener('keydown', function (e) {
    const ta = e.target.closest('.chat-pane-composer textarea');
    if (ta) {
      const pane = ta.closest('.chat-pane');
      if (pane && pane.dataset.sessionId && !pane.hasAttribute('data-focused')) {
        focusPane(pane.dataset.sessionId);
      }
      if (state.slashPopup && !state.slashPopup.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveSlashIndex(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const item = slashItems[slashIndex];
          if (item) {
            selectSlashItem(item);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlashPopup();
          return;
        }
        return;
      }
      if (state.atPopup && !state.atPopup.hidden) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveAtIndex(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const item = atItems[atIndex];
          if (item) {
            selectAtItem(item);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeAtPopup();
          return;
        }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
      return;
    }
    const qcard = e.target.closest('.question-card');
    if (qcard) {
      if (qcard.hidden) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissQuestion();
        return;
      }
      if (e.key === 'Enter' && !e.isComposing) {
        const send = qcard.querySelector('.question-btn.send');
        if (send && !send.disabled) {
          e.preventDefault();
          sendQuestion();
        }
      }
      return;
    }
    const menu = e.target.closest('.menu-popup');
    if (menu) {
      if (menu.id === 'agentMenu') {
        if (menu.hidden) {
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveAgentIndex(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          selectCurrentAgent();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeAgentMenu();
          if (state.input) {
            state.input.focus();
          }
        }
      } else if (menu.id === 'modelMenu') {
        if (menu.hidden) {
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveModelIndex(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          selectCurrentModel();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          // First Escape clears a non-empty search (menu stays open); a
          // second Escape (empty search) closes the menu.
          const search = menu.querySelector('.menu-search');
          if (search && search.value) {
            clearModelSearch();
          } else {
            closeModelMenu();
            if (state.input) {
              state.input.focus();
            }
          }
        }
      } else if (menu.id === 'variantMenu') {
        if (menu.hidden) {
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          moveVariantIndex(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          selectCurrentVariant();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeVariantMenu();
          if (state.input) {
            state.input.focus();
          }
        }
      }
      return;
    }
  });

  // The composer button is dual-purpose: send when idle, stop while busy.
  grid.addEventListener('click', function (e) {
    const sendBtn = e.target.closest('.send-btn');
    if (sendBtn) {
      if (state.busy && !state.stopping) {
        stop();
      } else {
        send();
      }
      return;
    }
    const agentBtn = e.target.closest('#agentPickerBtn');
    if (agentBtn) {
      if (state.agentMenu && state.agentMenu.hidden) {
        openAgentMenu();
      } else {
        closeAgentMenu();
      }
      return;
    }
    const modelBtn = e.target.closest('#modelPickerBtn');
    if (modelBtn) {
      if (state.modelMenu && state.modelMenu.hidden) {
        openModelMenu();
      } else {
        closeModelMenu();
      }
      return;
    }
    const variantBtn = e.target.closest('#variantPickerBtn');
    if (variantBtn) {
      if (state.variantMenu && state.variantMenu.hidden) {
        openVariantMenu();
      } else {
        closeVariantMenu();
      }
      return;
    }
    const thinkBtn = e.target.closest('#thinkingToggle');
    if (thinkBtn) {
      toggleThinking();
      return;
    }
    const agentMenu = e.target.closest('#agentMenu');
    if (agentMenu) {
      const row = e.target.closest('[data-agent]');
      if (row) {
        selectAgent(row.dataset.agent);
      }
      return;
    }
    const modelMenu = e.target.closest('#modelMenu');
    if (modelMenu) {
      const row = e.target.closest('[data-model]');
      if (row) {
        selectModel(row.dataset.provider, row.dataset.model);
      }
      return;
    }
    const variantMenu = e.target.closest('#variantMenu');
    if (variantMenu) {
      const row = e.target.closest('[data-variant]');
      if (row) {
        selectVariant(row.dataset.variant);
      }
      return;
    }
    const slashPopup = e.target.closest('#slashPopup');
    if (slashPopup) {
      const row = e.target.closest('[data-index]');
      if (row) {
        const item = slashItems[Number(row.dataset.index)];
        if (item) {
          selectSlashItem(item);
        }
      }
      return;
    }
    const atPopup = e.target.closest('#atPopup');
    if (atPopup) {
      const row = e.target.closest('[data-index]');
      if (row) {
        const item = atItems[Number(row.dataset.index)];
        if (item) {
          selectAtItem(item);
        }
      }
      return;
    }
  });

  state.helpOverlay.addEventListener('click', function (e) {
    if (e.target === state.helpOverlay) {
      closeHelp();
    }
  });
  state.helpOverlay.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeHelp();
      if (state.input) {
        state.input.focus();
      }
    }
  });
  $('helpClose').addEventListener('click', function () {
    closeHelp();
    if (state.input) {
      state.input.focus();
    }
  });

  // Close popups/dropdowns when the pointer lands elsewhere. The composer
  // refs are null when no pane is focused — guard each.
  document.addEventListener('pointerdown', function (e) {
    const t = e.target;
    if (state.slashPopup && !state.slashPopup.hidden && t !== state.input && !state.input.contains(t) && !state.slashPopup.contains(t)) {
      closeSlashPopup();
    }
    if (state.atPopup && !state.atPopup.hidden && t !== state.input && !state.input.contains(t) && !state.atPopup.contains(t)) {
      closeAtPopup();
    }
    if (state.agentMenu && !state.agentMenu.hidden && t !== state.agentPickerBtn && !state.agentPickerBtn.contains(t) && !state.agentMenu.contains(t)) {
      closeAgentMenu();
    }
    if (state.modelMenu && !state.modelMenu.hidden && t !== state.modelPickerBtn && !state.modelPickerBtn.contains(t) && !state.modelMenu.contains(t)) {
      closeModelMenu();
    }
    if (state.variantMenu && !state.variantMenu.hidden && t !== state.variantPickerBtn && !state.variantPickerBtn.contains(t) && !state.variantMenu.contains(t)) {
      closeVariantMenu();
    }
  });

  // Keep relative timestamps fresh.
  setInterval(function () {
    state.sessionList.querySelectorAll('.session-time').forEach(function (node) {
      const ts = Number(node.dataset.ts);
      if (ts) {
        node.textContent = relativeTime(ts);
      }
    });
  }, 60000);

  showProgress();
  updateSubagentsToggle();
  updateComposerState();
  updateEmptyStates();
  post({ type: 'ready' });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
