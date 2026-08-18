import * as path from 'path';
import * as vscode from 'vscode';
import { getClient, getServerUrl, isConnected } from './opencodeClient';
import { isEventStreamRunning, startEventStream } from './events';
import type { Message, Part } from '@opencode-ai/sdk/dist/v2/client';
import { toHistoryMessage } from './webview/types';
import type { Handler, ProviderContext } from './webview/types';
import { renderWebviewShell } from './webview/html';
import { QuestionLifecycle } from './questions/lifecycle';
import { SessionManager } from './sessions/manager';
import { HistoryService } from './sessions/history';
import { MetaState } from './catalog';
import { runNativeCommand } from './nativeCommands';

const VIEW_ID = 'opencode.chat';
const STREAM_ARM_INTERVAL_MS = 10000;

/**
 * Maps a file extension to the mime type the opencode server uses to decide
 * how a file part is handled: text/plain files are read as text via the Read
 * tool, everything else is embedded as a base64 data URL. Unrecognized
 * extensions default to text/plain so source files are always read as text.
 */
function guessMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.mp3':
      return 'audio/mpeg';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'text/plain';
  }
}

/**
 * Registers the `opencode.chat` sidebar webview and subscribes to the SSE
 * event stream. Returns the provider instance so callers can drive it (e.g.
 * `refreshSessionsList()`); the webview registration itself is pushed onto
 * `context.subscriptions` internally.
 */
export function registerChatViewProvider(
  context: vscode.ExtensionContext,
  log?: (message: string) => void,
): ChatViewProvider {
  const provider = new ChatViewProvider(context, log);
  const registration = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true },
  });
  context.subscriptions.push(registration);

  // The SSE loop in events.ts stops itself when the server disconnects, so
  // re-arm it periodically once the connection is healthy again.
  const armTimer = setInterval(() => provider.armEventStream(), STREAM_ARM_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(armTimer) });

  // Re-filter the session list when the workspace folder set changes so the
  // sidebar always reflects the project(s) currently open in VS Code.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refreshSessionsList();
    }),
  );

  provider.armEventStream();
  return provider;
}

/**
 * The sidebar webview provider. Owns the webview lifecycle, the SSE stream
 * (arm + dispatch), the prompt flow and the handler maps; session/catalog/
 * history/question concerns are delegated to the injected modules via the
 * shared ProviderContext.
 */
class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private webviewView: vscode.WebviewView | undefined;
  /**
   * Busy state per session, so a session switch re-posts the right flag.
   * Owned here (not in SessionManager) because it is written by the prompt
   * stream, SSE status/idle events and native commands — all provider paths.
   */
  private readonly busySessions = new Map<string, boolean>();
  /** Monotonic suffix for locally synthesized message ids. */
  private localIdCounter = 0;

  private readonly ctx: ProviderContext;
  private readonly sessions: SessionManager;
  private readonly history: HistoryService;
  private readonly meta: MetaState;
  private readonly questionLifecycle: QuestionLifecycle;
  // partID → part type, learned from `message.part.updated` snapshots so
  // `message.part.delta` events (which carry no type) can be routed to the
  // webview's text vs. reasoning accumulators.
  private readonly partTypes = new Map<string, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: (message: string) => void,
  ) {
    this.ctx = {
      post: (message) => this.post(message),
      isConnected: () => isConnected(),
      getActiveSessionId: () => this.sessions.getActiveSessionId(),
      workspaceState: this.context.workspaceState,
    };
    this.sessions = new SessionManager(this.ctx);
    this.history = new HistoryService(this.ctx);
    this.meta = new MetaState(this.ctx);
    this.questionLifecycle = new QuestionLifecycle(this.ctx);
  }

  /** Active session id, owned by SessionManager. */
  private get activeSessionId(): string | undefined {
    return this.sessions.getActiveSessionId();
  }

  /** Cleans up timers when the extension deactivates. */
  dispose(): void {
    this.sessions.dispose();
  }

  /** Public refresh entry used by the `opencodeChat.refreshSessions` command. */
  async refreshSessionsList(): Promise<void> {
    await this.sessions.refresh();
  }

  /** Posts editor context text for the webview to insert into the composer. */
  insertContext(text: string, label: string): void {
    this.post({ type: 'insertContext', text, label });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    const webview = webviewView.webview;
    // `retainContextWhenHidden` is set on the provider registration options
    // (WebviewViewOptions); here we configure script + local resource access.
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webview.html = renderWebviewShell(this.context, webview, getServerUrl());
    // Clear the reference when the view is disposed so post() stops posting
    // into a dead webview (postMessage would throw, churning the SSE loop).
    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = undefined;
      }
    });
    webview.onDidReceiveMessage((message: Record<string, unknown>) => {
      void this.handleMessage(message);
    }, undefined, this.context.subscriptions);
  }

  /**
   * Starts the SSE stream once. Idempotent: a no-op while the stream is
   * already running or the server is disconnected; re-armed on the next
   * connected tick.
   */
  armEventStream(): void {
    if (!isConnected()) {
      return;
    }
    if (isEventStreamRunning()) {
      return;
    }
    startEventStream((event) => this.handleServerEvent(event), (message) => this.log?.(message));
  }

  // ── host → webview ──────────────────────────────────────────────────────

  private post(message: Record<string, unknown>): void {
    if (!this.webviewView) {
      return;
    }
    try {
      this.webviewView.webview.postMessage(message);
    } catch {
      /* view disposed mid-post */
    }
  }

  // ── webview → host ──────────────────────────────────────────────────────

  /**
   * Webview message handlers keyed by `message.type`. Lookup-map form of a
   * switch; arrow functions keep `this` bound, and unknown types fall through
   * to a log line in `handleMessage`. Handlers that belong to an extracted
   * module delegate to it; session/history/meta orchestration stays here.
   */
  private readonly handlers: Record<string, Handler> = {
    ready: async () => {
      this.armEventStream();
      this.post({ type: 'connected', connected: isConnected() });
      // Catalog load is async — fire it, don't block the ready handshake.
      void this.meta.loadCatalog();
      await this.sessions.refresh();
      if (this.activeSessionId !== undefined && isConnected()) {
        await this.history.loadHistory(this.activeSessionId);
        this.post({ type: 'busy', sessionId: this.activeSessionId, busy: this.busySessions.get(this.activeSessionId) === true });
        void this.meta.syncSessionMeta(this.activeSessionId);
      }
    },
    selectSession: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      if (sessionId === undefined) {
        return;
      }
      await this.sessions.select(sessionId);
      if (isConnected()) {
        await this.history.loadHistory(sessionId);
        this.post({ type: 'busy', sessionId, busy: this.busySessions.get(sessionId) === true });
        void this.meta.syncSessionMeta(sessionId);
      }
    },
    prompt: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      const text = typeof message.text === 'string' ? message.text : '';
      if (sessionId === undefined || text.trim() === '') {
        return;
      }
      if (!isConnected()) {
        this.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
        return;
      }
      const files = Array.isArray(message.files) ? message.files.filter((f): f is string => typeof f === 'string') : undefined;
      const agent = typeof message.agent === 'string' ? message.agent : undefined;
      await this.sendPrompt(sessionId, text, files, agent);
    },
    newSession: async (message) => {
      if (!isConnected()) {
        this.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
        return;
      }
      const prompt = typeof message.prompt === 'string' ? message.prompt : undefined;
      const files = Array.isArray(message.files) ? message.files.filter((f): f is string => typeof f === 'string') : undefined;
      const agent = typeof message.agent === 'string' ? message.agent : undefined;
      const created = await this.sessions.create(prompt);
      if (created !== undefined && prompt !== undefined && prompt.trim() !== '') {
        await this.sendPrompt(created.id, prompt, files, agent);
      }
    },
    deleteSession: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      if (sessionId !== undefined) {
        await this.sessions.delete(sessionId);
      }
    },
    refreshSessions: async () => {
      this.armEventStream();
      this.post({ type: 'connected', connected: isConnected() });
      await this.sessions.refresh();
      if (this.activeSessionId !== undefined && isConnected()) {
        await this.history.loadHistory(this.activeSessionId);
      }
    },
    executeCommand: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      const command = typeof message.command === 'string' ? message.command : undefined;
      if (sessionId === undefined || command === undefined) {
        return;
      }
      if (!isConnected()) {
        this.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
        return;
      }
      const commandArgs = typeof message.arguments === 'string' ? message.arguments : undefined;
      await this.executeCommand(sessionId, command, commandArgs);
    },
    /**
     * Responds to the webview's `@`-mention popup request with the workspace
     * file list. The list is capped (2000 entries is plenty for a filter
     * popup) and returned as workspace-relative posix paths; the webview
     * inserts those paths into prompt parts and the host resolves them back
     * to absolute file:// URLs before sending.
     */
    getFiles: async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          this.post({ type: 'files', files: [] });
          return;
        }
        // Cap the list: 2000 files is plenty for an @-mention filter.
        const uris = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,out,dist,build,.next,coverage,.venv,venv}/**', 2000);
        const files = uris.map((u) => {
          const rel = vscode.workspace.asRelativePath(u, false);
          return { path: rel, name: path.basename(rel) };
        });
        this.post({ type: 'files', files });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.post({ type: 'error', message: `Failed to list workspace files: ${detail}` });
      }
    },
    nativeCommand: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      const command = typeof message.command === 'string' ? message.command : undefined;
      if (sessionId === undefined || command === undefined) {
        return;
      }
      if (!isConnected()) {
        this.post({ type: 'error', message: 'Not connected to the OpenCode server.' });
        return;
      }
      await runNativeCommand(this.ctx, sessionId, command, this.history, this.sessions);
    },
    setAgent: (message) => {
      this.meta.handleSetAgent(message);
    },
    setModel: (message) => {
      this.meta.handleSetModel(message);
    },
    getCatalog: async () => {
      await this.meta.loadCatalog();
    },
    setSubagentsVisible: async (message) => {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
      const visible = message.visible === true;
      this.sessions.setSubagentsVisible(visible);
      if (visible) {
        if (sessionId !== undefined && sessionId === this.activeSessionId && isConnected()) {
          await this.sessions.loadSubagents(sessionId);
        } else {
          this.post({ type: 'subagents', sessionId, sessions: [] });
        }
      } else {
        this.post({ type: 'subagents', sessionId, sessions: [] });
      }
    },
    permissionReply: async (message) => {
      await this.questionLifecycle.handlePermissionReply(message);
    },
    questionReply: async (message) => {
      await this.questionLifecycle.handleQuestionReply(message);
    },
  };

  private async handleMessage(message: Record<string, unknown>): Promise<void> {
    const type = message?.type;
    if (typeof type !== 'string') {
      return;
    }
    const handler = this.handlers[type];
    if (handler === undefined) {
      console.log(`[opencode-chat] unknown message type: ${type}`);
      return;
    }
    await handler(message);
  }

  private async sendPrompt(sessionId: string, text: string, files?: string[], agent?: string): Promise<void> {
    // Optimistic UI: echo the user turn immediately, then a pending assistant
    // bubble that SSE deltas will fill in. Both get replaced by authoritative
    // state once the server reports back.
    const tempUserId = `local-user-${Date.now()}-${++this.localIdCounter}`;
    // Resolve @-mention file references to absolute file:// parts. The server
    // reads file:// URLs itself (text/plain via the Read tool, binary mimes
    // embedded as base64 data URLs) — no content embedding needed here.
    const root = vscode.workspace.workspaceFolders?.[0];
    const fileParts: Array<{ type: 'file'; url: string; mime: string; filename?: string }> = (files ?? [])
      .filter(() => root !== undefined)
      .map((f) => {
        const abs = path.join(root!.uri.fsPath, f);
        return { type: 'file', url: vscode.Uri.file(abs).toString(), mime: guessMime(f), filename: path.basename(f) };
      });
    this.post({
      type: 'message',
      sessionId,
      message: {
        id: tempUserId,
        role: 'user',
        time: Date.now(),
        parts: [
          { id: `${tempUserId}-p`, sessionID: sessionId, messageID: tempUserId, type: 'text', text },
          ...fileParts.map((fp, i) => ({ ...fp, id: `${tempUserId}-f${i}`, sessionID: sessionId, messageID: tempUserId })),
        ],
      },
    });
    const pendingId = `pending-${Date.now()}-${++this.localIdCounter}`;
    this.post({
      type: 'message',
      sessionId,
      message: { id: pendingId, role: 'assistant', time: Date.now(), parts: [] },
    });
    this.busySessions.set(sessionId, true);
    this.post({ type: 'busy', sessionId, busy: true });

    try {
      // If this session has an unanswered question pending (e.g. from a
      // previous turn that wedged), reject it so the new prompt doesn't queue
      // behind it forever.
      await this.questionLifecycle.onPrompt(sessionId);
      // Always carry the session's current agent/model selection (seeded from
      // `session.get` on open, updated by setAgent/setModel).
      const params: {
        sessionID: string;
        parts: Array<{ type: 'text'; text: string } | { type: 'file'; url: string; mime: string; filename?: string }>;
        agent?: string;
        model?: { providerID: string; modelID: string };
      } = {
        sessionID: sessionId,
        parts: [{ type: 'text', text }, ...fileParts],
      };
      // Per-prompt @agent override wins over the session's persisted
      // selection; the session selection is left untouched.
      const agentParam = agent ?? this.meta.getAgent(sessionId);
      if (agentParam !== undefined) {
        params.agent = agentParam;
      }
      const model = this.meta.getModel(sessionId);
      if (model !== undefined) {
        params.model = model;
      }
      const res = await getClient().session.prompt(params);
      if (res.data !== undefined) {
        // Fallback in case a final `message.updated` never made it through.
        this.post({
          type: 'message',
          sessionId,
          message: toHistoryMessage(res.data.info, res.data.parts),
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message: `Failed to send prompt: ${detail}` });
      // Replace the pending bubble so it doesn't sit on "Thinking…" forever.
      this.post({
        type: 'message',
        sessionId,
        message: {
          id: pendingId,
          role: 'assistant',
          time: Date.now(),
          parts: [{ id: `${pendingId}-err`, sessionID: sessionId, messageID: pendingId, type: 'text', text: `Failed to get a response: ${detail}` }],
        },
      });
    } finally {
      this.busySessions.set(sessionId, false);
      this.post({ type: 'busy', sessionId, busy: false });
      this.sessions.scheduleRefresh();
    }
  }

  /**
   * Runs a server-side command (`init`, review/config commands, MCP tools,
   * skills) against a session with the session's current agent selection. The
   * returned parts may be empty; the real output arrives via SSE and is
   * forwarded by the existing event pipeline, so no content is synthesized.
   */
  private async executeCommand(sessionId: string, command: string, commandArgs: string | undefined): Promise<void> {
    this.busySessions.set(sessionId, true);
    this.post({ type: 'busy', sessionId, busy: true });
    try {
      const params: { sessionID: string; command: string; arguments?: string; agent?: string } = {
        sessionID: sessionId,
        command,
        arguments: commandArgs,
      };
      const agent = this.meta.getAgent(sessionId);
      if (agent !== undefined) {
        params.agent = agent;
      }
      // `model` on session.command is a plain string (not {providerID, modelID})
      // so it is intentionally omitted — the session's model rides along via
      // the SSE stream instead.
      await getClient().session.command(params);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', message: `Failed to execute command: ${detail}` });
      this.busySessions.set(sessionId, false);
      this.post({ type: 'busy', sessionId, busy: false });
    }
  }

  // ── SSE stream → webview ────────────────────────────────────────────────

  private handleServerEvent(event: { type: string; properties: any }): void {
    const p = event.properties ?? {};
    // Tolerate both `{ sessionID }` (contract) and `{ data: { sessionID } }`
    // (raw SDK event) shapes.
    const sessionID = p.sessionID ?? p.data?.sessionID;

    switch (event.type) {
      case 'server.connected':
        this.armEventStream();
        this.sessions.scheduleRefresh();
        break;
      case 'session.created':
      case 'session.deleted':
        this.sessions.scheduleRefresh();
        break;
      case 'session.updated':
        this.sessions.scheduleRefresh();
        // Authoritative re-sync of the active session's agent/model selection.
        if (sessionID !== undefined && sessionID === this.activeSessionId) {
          void this.meta.syncSessionMeta(sessionID);
        }
        break;
      case 'message.part.updated': {
        const part: Part | undefined = p.part ?? p.data?.part;
        if (sessionID === undefined || sessionID !== this.activeSessionId || part === undefined) {
          break;
        }
        // Remember the part type so later `message.part.delta` events (which
        // carry only a partID) can be routed to the right accumulator.
        this.partTypes.set(part.id, part.type);
        // A part without a messageID can't be routed to a message — skip it.
        const messageID = part.messageID;
        if (!messageID) {
          return;
        }
        if (part.type === 'text' || part.type === 'reasoning') {
          const delta = typeof p.delta === 'string' ? p.delta : undefined;
          // Streaming servers deliver incremental deltas; ones without a
          // delta deliver the cumulative part text instead. Forward both.
          // `partType` lets the webview route reasoning deltas into the
          // live thinking block instead of the main text stream.
          this.post({
            type: 'delta',
            sessionId: sessionID,
            messageId: messageID,
            partType: part.type,
            text: delta !== undefined ? delta : part.text,
            replace: delta === undefined,
          });
        }
        break;
      }
      case 'message.part.delta': {
        // Incremental stream deltas (legacy `/event` shape): flat properties
        // with a partID but no part type — resolve it from the map populated
        // by `message.part.updated` snapshots above.
        const messageID = p.messageID ?? p.data?.messageID;
        const partID = p.partID ?? p.data?.partID;
        const field = p.field ?? p.data?.field;
        const delta = typeof p.delta === 'string' ? p.delta : p.data?.delta;
        if (
          sessionID === undefined ||
          sessionID !== this.activeSessionId ||
          typeof messageID !== 'string' ||
          typeof partID !== 'string' ||
          field !== 'text' ||
          typeof delta !== 'string'
        ) {
          break;
        }
        const partType = this.partTypes.get(partID);
        if (partType !== 'text' && partType !== 'reasoning') {
          // Unknown part (e.g. mid-stream connect): the fragment-end
          // `message.part.updated` snapshot still renders the full text.
          break;
        }
        this.post({
          type: 'delta',
          sessionId: sessionID,
          messageId: messageID,
          partType,
          text: delta,
          replace: false,
        });
        break;
      }
      case 'message.updated': {
        const info: Message | undefined = p.info ?? p.data?.info;
        if (sessionID === undefined || info === undefined) {
          break;
        }
        if (info.role === 'assistant') {
          this.history.trackAssistantMessage(sessionID, info.id);
        }
        if (sessionID !== this.activeSessionId) {
          break;
        }
        // The SSE payload carries no parts; a full replace (with parts) is
        // sent after `prompt` resolves and on history reloads.
        this.post({ type: 'message', sessionId: sessionID, message: toHistoryMessage(info) });
        break;
      }
      case 'session.status': {
        const status = p.status ?? p.data?.status;
        if (sessionID === undefined || status === undefined) {
          break;
        }
        const busy = status.type === 'busy' || status.type === 'retry';
        // Track busy for every session so a session switch re-posts the flag.
        this.busySessions.set(sessionID, busy);
        if (sessionID === this.activeSessionId) {
          this.post({ type: 'busy', sessionId: sessionID, busy });
        }
        break;
      }
      case 'session.idle': {
        if (sessionID === undefined) {
          break;
        }
        this.busySessions.set(sessionID, false);
        if (sessionID === this.activeSessionId) {
          this.post({ type: 'busy', sessionId: sessionID, busy: false });
          // Authoritative reload: picks up tool parts, final text and the
          // real user message id that optimistic rendering faked.
          void this.history.loadHistory(sessionID);
        }
        this.sessions.scheduleRefresh();
        break;
      }
      case 'permission.asked':
      case 'permission.v2.asked':
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.asked':
      case 'question.v2.asked':
      case 'question.replied':
      case 'question.v2.replied':
      case 'question.rejected':
      case 'question.v2.rejected':
        void this.questionLifecycle.handleEvent(event.type, p);
        break;
      default:
        break;
    }
  }
}
