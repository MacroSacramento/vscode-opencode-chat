import * as vscode from 'vscode';
import { getClient, isConnected } from '../opencodeClient';
import type { Session } from '@opencode-ai/sdk/dist/v2/client';
import type { ProviderContext, SessionSummary } from '../webview/types';

const ACTIVE_SESSION_KEY = 'opencodeChat.activeSessionId';
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Owns the session-list lifecycle: the active session id (persisted in
 * workspace state), the cached session list, the list-refresh debounce timer
 * and the subagent visibility flag. `refresh()` is the public entry the
 * `opencodeChat.refreshSessions` command reaches through
 * ChatViewProvider.refreshSessionsList().
 *
 * Busy state (busySessions map) intentionally stays in the provider: it is
 * written by the prompt stream, SSE status/idle events and native commands —
 * all provider-owned paths — and only read back when the provider posts busy
 * on session switches. Moving it here would needlessly couple prompt flow.
 */
export class SessionManager {
  private lastSessions: SessionSummary[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private activeSessionId: string | undefined;
  /** Whether the webview wants subagent rows for the active session. */
  private subagentsVisible = false;

  constructor(private readonly ctx: ProviderContext) {
    this.activeSessionId = ctx.workspaceState.get<string>(ACTIVE_SESSION_KEY);
  }

  /** Cleans up the debounce timer on shutdown. */
  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
  }

  getActiveSessionId(): string | undefined {
    return this.activeSessionId;
  }

  /** Selects a session: persists it, resets the subagent toggle, re-posts the list. */
  async select(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    this.subagentsVisible = false;
    await this.ctx.workspaceState.update(ACTIVE_SESSION_KEY, sessionId);
    this.ctx.post({ type: 'sessions', sessions: this.lastSessions, activeSessionId: sessionId });
  }

  /** Creates a session (optionally from a prompt) and makes it active. */
  async create(prompt: string | undefined): Promise<Session | undefined> {
    try {
      // No explicit title: the server assigns the default placeholder and
      // auto-titles the session from the first user message (it only renames
      // sessions whose title matches that default pattern, so passing our own
      // title here would permanently lock in "New session").
      const res = await getClient().session.create({});
      const session = res.data;
      if (session === undefined) {
        throw new Error('Server returned no session');
      }
      this.activeSessionId = session.id;
      this.subagentsVisible = false;
      await this.ctx.workspaceState.update(ACTIVE_SESSION_KEY, session.id);
      await this.refresh();
      return session;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to create session: ${detail}` });
      return undefined;
    }
  }

  /** Deletes a session; clears the active id when it was the active one. */
  async delete(sessionId: string): Promise<void> {
    try {
      if (isConnected()) {
        await getClient().session.delete({ sessionID: sessionId });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to delete session: ${detail}` });
      return;
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = undefined;
      this.subagentsVisible = false;
      await this.ctx.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
    }
    this.ctx.post({ type: 'sessionDeleted', sessionId });
    await this.refresh();
  }

  setSubagentsVisible(visible: boolean): void {
    this.subagentsVisible = visible;
  }

  /** Fetches and posts the child (subagent) sessions of a parent session. */
  async loadSubagents(sessionId: string): Promise<void> {
    try {
      const res = await getClient().session.children({ sessionID: sessionId });
      const sessions: SessionSummary[] = (res.data ?? []).map((s) => ({
        id: s.id,
        title: s.title.trim() === '' ? 'Untitled session' : s.title,
        updated: s.time.updated,
      }));
      this.ctx.post({ type: 'subagents', sessionId, sessions });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load subagents: ${detail}` });
    }
  }

  /** Debounced session-list refresh (used by sendPrompt and SSE events). */
  scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Fetches, filters and posts the session list; refreshes subagents when visible. */
  async refresh(): Promise<void> {
    if (!isConnected()) {
      this.ctx.post({ type: 'connected', connected: false });
      return;
    }
    try {
      const res = await getClient().session.list();
      const all = res.data ?? [];
      const sorted = (await this.filterSessions(all)).sort((a, b) => b.time.updated - a.time.updated);
      this.lastSessions = sorted.map((session) => ({
        id: session.id,
        title: session.title.trim() === '' ? 'Untitled session' : session.title,
        updated: session.time.updated,
      }));
      // Drop the active session when it no longer belongs to the current
      // workspace (e.g. its folder was closed or the project changed), so the
      // webview never keeps showing a foreign session's history.
      if (this.activeSessionId !== undefined && !this.lastSessions.some((s) => s.id === this.activeSessionId)) {
        this.activeSessionId = undefined;
        await this.ctx.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
      }
      this.ctx.post({ type: 'connected', connected: true });
      this.ctx.post({ type: 'sessions', sessions: this.lastSessions, activeSessionId: this.activeSessionId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load sessions: ${detail}` });
      this.ctx.post({ type: 'connected', connected: false });
    }

    // Keep the subagent block fresh whenever the main list refreshes.
    if (this.subagentsVisible && this.activeSessionId !== undefined && isConnected()) {
      await this.loadSubagents(this.activeSessionId);
    }
  }

  /**
   * Filters sessions to the current workspace (opt-out via
   * `opencodeChat.workspaceFilter`), sorted by most recently updated.
   *
   * The anchor directories are the open workspace folders (all of them, for
   * multi-root workspaces); when none are open, the OpenCode server's own
   * project directory (`/path`) is used. A session matches when its directory
   * equals an anchor or lives under it (subfolder workspaces), so sessions
   * from other projects never appear.
   */
  private async filterSessions(all: Session[]): Promise<Session[]> {
    // Subagent sessions (parentID set) are children of a parent session and
    // never appear in the global list — they only surface via the subagent
    // toggle on the parent session.
    const topLevel = all.filter((session) => session.parentID === undefined);
    const config = vscode.workspace.getConfiguration('opencodeChat');
    const enabled = config.get<boolean>('workspaceFilter', true);
    if (!enabled) {
      return topLevel;
    }
    const folders = vscode.workspace.workspaceFolders;
    let anchors: string[] | undefined;
    if (folders !== undefined && folders.length > 0) {
      anchors = folders.map((folder) => folder.uri.fsPath);
    } else {
      try {
        const res = await getClient().path.get();
        const dir = res.data?.directory;
        if (dir !== undefined) {
          anchors = [dir];
        }
      } catch {
        return topLevel;
      }
    }
    if (anchors === undefined) {
      return topLevel;
    }
    const roots = anchors.map((anchor) => anchor.replace(/[\\/]+$/, ''));
    return topLevel.filter((session) => {
      const dir = session.directory;
      return roots.some(
        (root) => dir === root || dir.startsWith(root + '/') || dir.startsWith(root + '\\'),
      );
    });
  }
}
