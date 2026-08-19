import * as vscode from 'vscode';
import type { Message, Part } from '@opencode-ai/sdk/dist/v2/client';

/**
 * Webview message protocol. No runtime validation — both sides must stay in
 * sync manually when adding messages.
 *
 * host → webview: `connected`, `sessions`, `history`, `delta`, `message`,
 * `busy`, `sessionDeleted`, `catalog`, `sessionMeta`, `nativeResult`,
 * `subagents`, `files`, `permission`, `permissionResolved`, `question`,
 * `questionResolved`, `error`, `insertContext`, `chatLayout`
 *
 * webview → host: `ready`, `selectSession`, `prompt` (optional `files`:
 * workspace-relative posix paths, and `agent`: per-prompt override),
 * `newSession` (same optional `files`/`agent`), `deleteSession`,
 * `refreshSessions`, `executeCommand`, `nativeCommand`, `setAgent`, `setModel`,
 * `getCatalog`, `getFiles`, `setSubagentsVisible`, `permissionReply`,
 * `questionReply`, `setChatLayout`
 */

/**
 * A minimal projection of a session row sent to the webview.
 */
export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
}

/**
 * A workspace file entry for @-mentions sent to the webview.
 */
export interface WorkspaceFile {
  path: string;
  name: string;
}

export type ChatOrientation = 'horizontal' | 'vertical';

/**
 * A group of session panes sharing one pane DOM. `sessionIds` order is the tab
 * order (left→right / top→bottom); the webview shows only the focused tab's
 * pane but keeps every pane mounted. Groups are the only nodes that carry an
 * `id` — splits are purely structural.
 */
export interface ChatGroup {
  type: 'group';
  id: string;
  sessionIds: string[];
}

/**
 * A structural split: children laid out side-by-side ('horizontal') or stacked
 * ('vertical'). Splits carry no id.
 */
export interface ChatSplit {
  type: 'split';
  orientation: ChatOrientation;
  children: ChatLayoutNode[];
}

export type ChatLayoutNode = ChatGroup | ChatSplit;

/**
 * The nested split-tree layout of open chat sessions (v2). The webview is the
 * layout source of truth during a session; the host persists it and uses it to
 * decide which sessions receive forwarded SSE events and history loads.
 */
export interface ChatLayout {
  version: 2;
  root: ChatLayoutNode | null;
  focusedSessionId: string | null;
}

/**
 * A projection of a conversation message sent to the webview. `parts` are the
 * raw SDK Part objects; the webview knows how to render them.
 */
export interface HistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  time: number;
  parts: Part[];
}

/** A catalog command entry sent to the webview. */
export interface CatalogCommand {
  name: string;
  description?: string;
  source?: 'command' | 'mcp' | 'skill';
}

/** A catalog agent entry sent to the webview. */
export interface CatalogAgent {
  name: string;
  description?: string;
}

/** A flattened provider model entry sent to the webview. */
export interface CatalogModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  contextLimit?: number;
}

/** Session usage stats sent with `sessionMeta`. */
export interface SessionUsage {
  cost: number;
  contextTokens: number;
  contextLimit?: number;
}

/**
 * A flattened question entry sent to the webview. Mirrors the SDK's
 * QuestionInfo / QuestionV2Info shape (question = full text, header = short
 * label, options = label + description pairs).
 */
export interface QuestionEntry {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

/** A webview message handler, keyed by `message.type` in `handlers`. */
export type Handler = (msg: Record<string, unknown>) => Promise<void> | void;

/**
 * The provider-facing API the extracted modules consume: webview posting,
 * connection status, the active session id and workspace-state persistence.
 * `getActiveSessionId` is provided by SessionManager; `workspaceState` is only
 * consumed by SessionManager (active-session persistence across reloads).
 */
export interface ProviderContext {
  post(msg: Record<string, unknown>): void;
  isConnected(): boolean;
  getActiveSessionId(): string | undefined;
  getOpenSessionIds(): string[];
  isPaneOpen(sessionId: string): boolean;
  get workspaceState(): vscode.Memento;
}

/** Builds the webview projection of a conversation message. */
export function toHistoryMessage(info: Message, parts: Part[] = []): HistoryMessage {
  const created = info.time && typeof info.time.created === 'number' ? info.time.created : Date.now();
  return { id: info.id, role: info.role, time: created, parts };
}
