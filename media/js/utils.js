import { state } from './state.js';

// ── Posting to the extension host ─────────────────────────────────────────

// `acquireVsCodeApi` is injected by the webview runtime before any script
// runs (declared in globals.d.ts for checkJs).
const vscode = acquireVsCodeApi();

export function post(message) {
  vscode.postMessage(message);
}

// ── Small utilities ──────────────────────────────────────────────────────

export function cssEscape(value) {
  const s = String(value);
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(s);
  }
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Message bubbles are HTMLElements (`.dataset`, `.classList`, ...).
/** @returns {HTMLElement | null} */
export function findMessageEl(id) {
  return document.querySelector('[data-message-id="' + cssEscape(id) + '"]');
}

export function relativeTime(ts) {
  if (!ts) {
    return '';
  }
  const diff = Date.now() - ts;
  if (diff < 60000) {
    return 'now';
  }
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return minutes + 'm';
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours + 'h';
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days + 'd';
  }
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatMessageTime(ts) {
  if (!ts) {
    return '';
  }
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function scrollToBottom() {
  state.conversation.scrollTop = state.conversation.scrollHeight;
}

export function maybeScrollBottom() {
  const conv = state.conversation;
  if (conv.scrollHeight - conv.scrollTop - conv.clientHeight < 120) {
    scrollToBottom();
  }
}

export function showProgress() {
  state.loading = true;
  state.progress.hidden = false;
}

export function hideProgress() {
  state.loading = false;
  state.progress.hidden = true;
}

// ── Toast ─────────────────────────────────────────────────────────────────

let toastTimer = null;

export function showToast(message) {
  state.toast.textContent = message || 'Something went wrong';
  state.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    state.toast.hidden = true;
  }, 5000);
}
