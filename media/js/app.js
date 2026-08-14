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
} from './composer.js';
import {
  updateMetaBadges,
  renderAgentMenu,
  renderModelMenu,
  updateThinkingToggle,
  toggleThinking,
  openAgentMenu,
  closeAgentMenu,
  openModelMenu,
  closeModelMenu,
  selectAgent,
  selectModel,
  closeHelp,
  moveAgentIndex,
  moveModelIndex,
  selectCurrentAgent,
  selectCurrentModel,
} from './pickers.js';
import {
  dismissQuestion,
  sendQuestion,
  showPermissionCard,
  hidePermissionCard,
  showQuestionCard,
  hideQuestionCard,
} from './cards.js';

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
    case 'sessions':
      applySessions(msg);
      break;
    case 'history':
      if (msg.sessionId === state.activeSessionId) {
        renderHistory(msg);
      }
      break;
    case 'delta':
      if (msg.sessionId === state.activeSessionId) {
        onDelta(msg);
      }
      break;
    case 'message':
      if (msg.sessionId === state.activeSessionId) {
        upsertMessage(msg.message);
      }
      break;
    case 'busy':
      if (msg.sessionId === state.activeSessionId) {
        setBusy(msg.busy === true);
      }
      break;
    case 'sessionDeleted':
      removeSession(msg.sessionId);
      break;
    case 'catalog':
      state.catalog = msg;
      updateMetaBadges();
      if (!state.agentMenu.hidden) {
        renderAgentMenu();
      }
      if (!state.modelMenu.hidden) {
        renderModelMenu();
      }
      if (!state.atPopup.hidden) {
        renderAtPopup();
      }
      break;
    case 'files':
      state.files = Array.isArray(msg.files) ? msg.files : [];
      if (!state.atPopup.hidden) {
        renderAtPopup();
      }
      break;
    case 'sessionMeta':
      if (msg.sessionId === state.activeSessionId) {
        state.agent = typeof msg.agent === 'string' ? msg.agent : null;
        state.model = msg.model && typeof msg.model === 'object' ? { providerID: msg.model.providerID, modelID: msg.model.modelID } : null;
        updateMetaBadges();
        if (!state.agentMenu.hidden) {
          renderAgentMenu();
        }
        if (!state.modelMenu.hidden) {
          renderModelMenu();
        }
      }
      break;
    case 'nativeResult':
      if (msg.sessionId === state.activeSessionId) {
        appendNativeResult(msg);
      }
      break;
    case 'subagents':
      if (msg.sessionId === state.activeSessionId) {
        state.subagents = Array.isArray(msg.sessions) ? msg.sessions : [];
        renderSessionList();
      }
      break;
    case 'permission':
      if (msg.request && msg.request.sessionID === state.activeSessionId) {
        showPermissionCard(msg.request);
      }
      break;
    case 'permissionResolved':
      if (state.pendingPermission && msg.requestID === state.pendingPermission.id) {
        hidePermissionCard();
      }
      break;
    case 'question':
      if (msg.request && msg.request.sessionID === state.activeSessionId) {
        showQuestionCard(msg.request);
      }
      break;
    case 'questionResolved':
      if (state.pendingQuestion && msg.requestID === state.pendingQuestion.id) {
        hideQuestionCard();
      }
      break;
    case 'error':
      showToast(msg.message);
      // A failed abort (host surfaced an error) shouldn't strand the button
      // on the disabled "Stopping…" pill — restore the clickable Stop so the
      // user can retry while the stream is still running.
      if (state.stopping) {
        state.stopping = false;
        state.stoppedStream = false;
        updateComposerState();
      }
      break;
    default:
      break;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────

function init() {
  state.app = $('app');
  state.disconnected = $('disconnected');
  state.conversation = $('conversation');
  state.sessionList = $('sessionList');
  state.sessionCount = $('sessionCount');
  state.sessionToggle = $('sessionToggle');
  state.progress = $('progress');
  state.emptyNoSessions = $('emptyNoSessions');
  state.emptyConversation = $('emptyConversation');
  state.input = $('input');
  state.sendBtn = $('sendBtn');
  state.newSessionBtn = $('newSessionBtn');
  state.retryBtn = $('retryBtn');
  state.emptyNewBtn = $('emptyNewBtn');
  state.toast = $('toast');
  state.agentPickerBtn = $('agentPickerBtn');
  state.agentBadgeValue = $('agentBadgeValue');
  state.modelPickerBtn = $('modelPickerBtn');
  state.modelBadgeValue = $('modelBadgeValue');
  state.thinkingToggle = $('thinkingToggle');
  state.thinkingToggleValue = $('thinkingToggleValue');
  state.subagentsToggle = $('subagentsToggle');
  state.permissionCard = $('permissionCard');
  state.questionCard = $('questionCard');
  state.slashPopup = $('slashPopup');
  state.atPopup = $('atPopup');
  state.agentMenu = $('agentMenu');
  state.modelMenu = $('modelMenu');
  state.helpOverlay = $('helpOverlay');
  state.helpList = $('helpList');

  // Restore the thinking preference; off by default.
  state.showThinking = localStorage.getItem('opencodeChat.showThinking') === '1';
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
    const collapsed = document.body.classList.toggle('collapsed');
    state.sessionToggle.title = collapsed ? 'Show session list' : 'Hide session list';
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
      showProgress();
      post({ type: 'selectSession', sessionId: id });
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

  state.thinkingToggle.addEventListener('click', toggleThinking);

  state.input.addEventListener('input', function () {
    autoGrow();
    updateComposerState();
    handleSlashTyping();
    handleAtTyping();
  });
  state.input.addEventListener('keydown', function (e) {
    if (!state.slashPopup.hidden) {
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
    if (!state.atPopup.hidden) {
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
  });
  // The composer button is dual-purpose: send when idle, stop while busy.
  state.sendBtn.addEventListener('click', function () {
    if (state.busy && !state.stopping) {
      stop();
    } else {
      send();
    }
  });

  // Question card keyboard: Escape dismisses, Enter sends once answered.
  state.questionCard.addEventListener('keydown', function (e) {
    if (state.questionCard.hidden) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissQuestion();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      const send = state.questionCard.querySelector('.question-btn.send');
      if (send && !send.disabled) {
        e.preventDefault();
        sendQuestion();
      }
    }
  });

  state.slashPopup.addEventListener('click', function (e) {
    const row = e.target.closest('[data-index]');
    if (!row) {
      return;
    }
    const item = slashItems[Number(row.dataset.index)];
    if (item) {
      selectSlashItem(item);
    }
  });

  state.atPopup.addEventListener('click', function (e) {
    const row = e.target.closest('[data-index]');
    if (!row) {
      return;
    }
    const item = atItems[Number(row.dataset.index)];
    if (item) {
      selectAtItem(item);
    }
  });

  state.agentPickerBtn.addEventListener('click', function () {
    if (state.agentMenu.hidden) {
      openAgentMenu();
    } else {
      closeAgentMenu();
    }
  });
  state.agentMenu.addEventListener('keydown', function (e) {
    if (state.agentMenu.hidden) {
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
      state.input.focus();
    }
  });
  state.agentMenu.addEventListener('click', function (e) {
    const row = e.target.closest('[data-agent]');
    if (row) {
      selectAgent(row.dataset.agent);
    }
  });

  state.modelPickerBtn.addEventListener('click', function () {
    if (state.modelMenu.hidden) {
      openModelMenu();
    } else {
      closeModelMenu();
    }
  });
  state.modelMenu.addEventListener('keydown', function (e) {
    if (state.modelMenu.hidden) {
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
      closeModelMenu();
      state.input.focus();
    }
  });
  state.modelMenu.addEventListener('click', function (e) {
    const row = e.target.closest('[data-model]');
    if (row) {
      selectModel(row.dataset.provider, row.dataset.model);
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
      state.input.focus();
    }
  });
  $('helpClose').addEventListener('click', function () {
    closeHelp();
    state.input.focus();
  });

  // Close popups/dropdowns when the pointer lands elsewhere.
  document.addEventListener('pointerdown', function (e) {
    const t = e.target;
    if (!state.slashPopup.hidden && t !== state.input && !state.input.contains(t) && !state.slashPopup.contains(t)) {
      closeSlashPopup();
    }
    if (!state.atPopup.hidden && t !== state.input && !state.input.contains(t) && !state.atPopup.contains(t)) {
      closeAtPopup();
    }
    if (!state.agentMenu.hidden && t !== state.agentPickerBtn && !state.agentPickerBtn.contains(t) && !state.agentMenu.contains(t)) {
      closeAgentMenu();
    }
    if (!state.modelMenu.hidden && t !== state.modelPickerBtn && !state.modelPickerBtn.contains(t) && !state.modelMenu.contains(t)) {
      closeModelMenu();
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
