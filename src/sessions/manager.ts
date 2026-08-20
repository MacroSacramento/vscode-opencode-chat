import * as vscode from 'vscode';
import { getClient, isConnected } from '../opencodeClient';
import type { Session } from '@opencode-ai/sdk/dist/v2/client';
import type { ChatGroup, ChatLayout, ChatLayoutNode, ProviderContext, SessionSummary } from '../webview/types';

const ACTIVE_SESSION_KEY = 'opencodeChat.activeSessionId';
const CHAT_LAYOUT_KEY = 'opencodeChat.chatLayout';
const REFRESH_DEBOUNCE_MS = 250;

/** Monotonic suffix so group ids stay unique even when created in the same millisecond. */
let groupIdCounter = 0;
function newGroupId(): string {
  return `group-${Date.now()}-${++groupIdCounter}`;
}

/**
 * Owns the session-list lifecycle: the nested split-tree layout (persisted in
 * workspace state), the cached session list, the list-refresh debounce timer
 * and the subagent visibility flag. `refresh()` is the public entry the
 * `opencodeChat.refreshSessions` command reaches through
 * ChatViewProvider.refreshSessionsList().
 *
 * The layout is the source of truth for which sessions are open: the union of
 * all group sessionIds in the tree. The focused session id lives on the layout
 * and is also mirrored to the legacy ACTIVE_SESSION_KEY for backward compat.
 *
 * Busy state (busySessions map) intentionally stays in the provider: it is
 * written by the prompt stream, SSE status/idle events and native commands —
 * all provider-owned paths — and only read back when the provider posts busy
 * on session switches. Moving it here would needlessly couple prompt flow.
 */
export class SessionManager {
  private lastSessions: SessionSummary[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private layout: ChatLayout;
  /** Whether the webview wants subagent rows for the active session. */
  private subagentsVisible = false;

  constructor(private readonly ctx: ProviderContext) {
    const stored = this.ctx.workspaceState.get<unknown>(CHAT_LAYOUT_KEY);
    this.layout = this.migrateLayout(stored);
    // Persist eagerly so a migrated layout is written back once and never
    // re-migrated on the next activation.
    void this.persistLayout();
  }

  /** Cleans up the debounce timer on shutdown. */
  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
  }

  /**
   * Loads the persisted layout, migrating older shapes to the v2 split-tree
   * model: v2 (`root`/`version`) is normalized in place; v1 flat `{groups}`
   * maps each zone to a single group; pre-grid versions fall back to the
   * legacy active-session key.
   */
  private migrateLayout(stored: unknown): ChatLayout {
    if (stored !== null && typeof stored === 'object') {
      const s = stored as Record<string, unknown>;
      if (s.version === 2 || 'root' in s) {
        return {
          version: 2,
          root: this.normalizeTree(s.root),
          focusedSessionId: typeof s.focusedSessionId === 'string' ? s.focusedSessionId : null,
        };
      }
      if (Array.isArray(s.groups)) {
        const zones: ChatGroup[] = [];
        const seen = new Set<string>();
        for (const raw of s.groups as unknown[]) {
          if (raw === null || typeof raw !== 'object') {
            continue;
          }
          const g = raw as Record<string, unknown>;
          const sessionIds: string[] = [];
          if (Array.isArray(g.sessionIds)) {
            for (const id of g.sessionIds) {
              if (typeof id === 'string' && !seen.has(id)) {
                seen.add(id);
                sessionIds.push(id);
              }
            }
          }
          if (sessionIds.length === 0) {
            continue;
          }
          zones.push({ type: 'group', id: typeof g.id === 'string' ? g.id : newGroupId(), sessionIds });
        }
        return {
          version: 2,
          root: this.rootFromZones(zones),
          focusedSessionId: typeof s.focusedSessionId === 'string' ? s.focusedSessionId : null,
        };
      }
    }
    // Pre-grid legacy: only the active session id was persisted.
    const legacy = this.ctx.workspaceState.get<string>(ACTIVE_SESSION_KEY);
    if (legacy !== undefined) {
      return { version: 2, root: { type: 'group', id: newGroupId(), sessionIds: [legacy] }, focusedSessionId: legacy };
    }
    return { version: 2, root: null, focusedSessionId: null };
  }

  /** Wraps migrated v1 zones: 0 → null, 1 → the group, N → a vertical split. */
  private rootFromZones(zones: ChatGroup[]): ChatLayoutNode | null {
    if (zones.length === 0) {
      return null;
    }
    if (zones.length === 1) {
      return zones[0];
    }
    return { type: 'split', orientation: 'vertical', children: zones };
  }

  /**
   * Validates/normalizes an untrusted tree: drops non-string sessionIds,
   * dedupes them across the whole tree (first occurrence wins), drops empty
   * groups and collapses degenerate splits.
   */
  private normalizeTree(root: unknown): ChatLayoutNode | null {
    const seen = new Set<string>();
    const walk = (node: unknown): ChatLayoutNode | null => {
      if (node === null || typeof node !== 'object') {
        return null;
      }
      const n = node as Record<string, unknown>;
      if (n.type === 'group') {
        const sessionIds: string[] = [];
        if (Array.isArray(n.sessionIds)) {
          for (const id of n.sessionIds) {
            if (typeof id === 'string' && !seen.has(id)) {
              seen.add(id);
              sessionIds.push(id);
            }
          }
        }
        if (sessionIds.length === 0) {
          return null;
        }
        return { type: 'group', id: typeof n.id === 'string' ? n.id : newGroupId(), sessionIds };
      }
      if (n.type === 'split') {
        const children: ChatLayoutNode[] = [];
        if (Array.isArray(n.children)) {
          for (const child of n.children) {
            const normalized = walk(child);
            if (normalized !== null) {
              children.push(normalized);
            }
          }
        }
        if (children.length === 0) {
          return null;
        }
        if (children.length === 1) {
          return children[0];
        }
        const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length
          ? n.sizes.map((s) => (typeof s === 'number' && isFinite(s) && s > 0 ? s : 1))
          : undefined;
        return {
          type: 'split',
          orientation: n.orientation === 'vertical' ? 'vertical' : 'horizontal',
          children,
          ...(sizes !== undefined ? { sizes } : {}),
        };
      }
      return null;
    };
    return walk(root);
  }

  // ── tree helpers ────────────────────────────────────────────────────────

  private findGroup(root: ChatLayoutNode | null, groupId: string): ChatGroup | undefined {
    if (root === null) {
      return undefined;
    }
    if (root.type === 'group') {
      return root.id === groupId ? root : undefined;
    }
    for (const child of root.children) {
      const found = this.findGroup(child, groupId);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private findGroupContaining(root: ChatLayoutNode | null, sessionId: string): ChatGroup | undefined {
    if (root === null) {
      return undefined;
    }
    if (root.type === 'group') {
      return root.sessionIds.includes(sessionId) ? root : undefined;
    }
    for (const child of root.children) {
      const found = this.findGroupContaining(child, sessionId);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  /** The rightmost/bottommost leaf group (tab order: left→right, top→bottom). */
  private lastGroup(root: ChatLayoutNode | null): ChatGroup | undefined {
    if (root === null) {
      return undefined;
    }
    if (root.type === 'group') {
      return root;
    }
    let last: ChatGroup | undefined;
    for (const child of root.children) {
      const found = this.lastGroup(child);
      if (found !== undefined) {
        last = found;
      }
    }
    return last;
  }

  /** All open session ids in tab order (left→right / top→bottom). */
  private collectSessionIds(root: ChatLayoutNode | null): string[] {
    if (root === null) {
      return [];
    }
    if (root.type === 'group') {
      return [...root.sessionIds];
    }
    const ids: string[] = [];
    for (const child of root.children) {
      ids.push(...this.collectSessionIds(child));
    }
    return ids;
  }

  /**
   * Removes a session from the tree, dropping the group when it empties and
   * collapsing splits with ≤1 child. Returns the new root (null when empty).
   */
  private removeSessionFromTree(root: ChatLayoutNode | null, sessionId: string): ChatLayoutNode | null {
    if (root === null) {
      return null;
    }
    if (root.type === 'group') {
      const sessionIds = root.sessionIds.filter((id) => id !== sessionId);
      if (sessionIds.length === 0) {
        return null;
      }
      return { type: 'group', id: root.id, sessionIds };
    }
    const children: ChatLayoutNode[] = [];
    for (const child of root.children) {
      const removed = this.removeSessionFromTree(child, sessionId);
      if (removed !== null) {
        children.push(removed);
      }
    }
    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0];
    }
    return { type: 'split', orientation: root.orientation, children };
  }

  getActiveSessionId(): string | undefined {
    return this.layout.focusedSessionId ?? undefined;
  }

  /** The current layout (used to restore panes on ready/connect). */
  getLayout(): ChatLayout {
    return this.layout;
  }

  /** Union of all session ids currently open in the layout (tab order). */
  getOpenSessionIds(): string[] {
    return this.collectSessionIds(this.layout.root);
  }

  /** Whether a session is currently open in any pane. */
  isPaneOpen(sessionId: string): boolean {
    return this.findGroupContaining(this.layout.root, sessionId) !== undefined;
  }

  /** Persists the layout and mirrors the focused id to the legacy key. */
  private async persistLayout(): Promise<void> {
    await this.ctx.workspaceState.update(CHAT_LAYOUT_KEY, this.layout);
    await this.ctx.workspaceState.update(ACTIVE_SESSION_KEY, this.layout.focusedSessionId ?? undefined);
  }

  /** Posts the layout and the session list (active id = focused session). */
  private postLayoutAndSessions(): void {
    this.ctx.post({ type: 'chatLayout', layout: this.layout });
    this.ctx.post({ type: 'sessions', sessions: this.lastSessions, activeSessionId: this.layout.focusedSessionId });
  }

  /**
   * Applies a layout from the webview: validates/normalizes its tree, persists
   * it, then diffs against the previous open-session set. Returns the ids of
   * sessions newly opened by this layout so the provider can load their
   * history.
   */
  async applyLayout(layout: ChatLayout): Promise<string[]> {
    const previous = this.getOpenSessionIds();
    const root = this.normalizeTree(layout.root);
    // Group ids key the webview's pane DOM — make sure no two groups share one,
    // or two panes would collide. Reassign any id that collides with an earlier
    // group in the tree.
    const dedupeGroupIds = (node: ChatLayoutNode | null): void => {
      if (node === null) {
        return;
      }
      if (node.type === 'group') {
        if (this.findGroup(root, node.id) !== node) {
          node.id = newGroupId();
        }
        return;
      }
      for (const child of node.children) {
        dedupeGroupIds(child);
      }
    };
    dedupeGroupIds(root);
    this.layout = {
      version: 2,
      root,
      focusedSessionId: typeof layout.focusedSessionId === 'string' ? layout.focusedSessionId : null,
    };
    await this.persistLayout();
    // Post the session list (active id = focused session) but NOT a chatLayout
    // echo: the webview already owns this layout and echoing it back would
    // trigger applyLayout → persist → setChatLayout → applyLayout forever.
    this.ctx.post({ type: 'sessions', sessions: this.lastSessions, activeSessionId: this.layout.focusedSessionId });
    const current = this.getOpenSessionIds();
    return current.filter((id) => !previous.includes(id));
  }

  /** The group a new tab should land in: the focused zone, else the last zone. */
  private targetGroup(): ChatGroup | undefined {
    const focused = this.layout.focusedSessionId;
    return (focused !== null ? this.findGroupContaining(this.layout.root, focused) : undefined) ?? this.lastGroup(this.layout.root);
  }

  /** Selects a session: ensures it is in the layout, focuses it, persists, re-posts. */
  async select(sessionId: string): Promise<string> {
    if (!this.isPaneOpen(sessionId)) {
      const target = this.targetGroup();
      if (target !== undefined) {
        target.sessionIds.push(sessionId);
      } else {
        this.layout.root = { type: 'group', id: newGroupId(), sessionIds: [sessionId] };
      }
    }
    this.layout.focusedSessionId = sessionId;
    this.subagentsVisible = false;
    await this.persistLayout();
    this.postLayoutAndSessions();
    return sessionId;
  }

  /** Creates a session (optionally from a prompt) and opens it focused as a tab. */
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
      // Open the new session as a tab in the focused zone (not a new group).
      const target = this.targetGroup();
      if (target !== undefined) {
        target.sessionIds.push(session.id);
      } else {
        this.layout.root = { type: 'group', id: newGroupId(), sessionIds: [session.id] };
      }
      this.layout.focusedSessionId = session.id;
      this.subagentsVisible = false;
      await this.persistLayout();
      this.postLayoutAndSessions();
      await this.refresh();
      return session;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to create session: ${detail}` });
      return undefined;
    }
  }

  /** Deletes a session; removes it from the tree and re-focuses a remaining pane. */
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
    const before = this.collectSessionIds(this.layout.root);
    const index = before.indexOf(sessionId);
    this.layout.root = this.removeSessionFromTree(this.layout.root, sessionId);
    if (this.layout.focusedSessionId === sessionId) {
      // Focus repair: right neighbor of the removed position, else left
      // neighbor, else the last remaining session, else none.
      const right = index >= 0 ? before[index + 1] : undefined;
      const left = index > 0 ? before[index - 1] : undefined;
      const remaining = this.collectSessionIds(this.layout.root);
      this.layout.focusedSessionId = right ?? left ?? (remaining.length > 0 ? remaining[remaining.length - 1] : null);
    }
    this.subagentsVisible = false;
    await this.persistLayout();
    this.ctx.post({ type: 'sessionDeleted', sessionId });
    this.postLayoutAndSessions();
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

  /** Fetches, filters and posts the session list; prunes stale panes; refreshes subagents when visible. */
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
      // Prune panes whose session no longer belongs to the current workspace
      // (e.g. its folder was closed or the project changed), so the webview
      // never keeps showing a foreign session's history. Walk the tree, drop
      // empty groups, collapse degenerate splits and re-focus a remaining pane
      // if the focused one was pruned.
      const valid = new Set(this.lastSessions.map((s) => s.id));
      let changed = false;
      const pruneTree = (root: ChatLayoutNode | null): ChatLayoutNode | null => {
        if (root === null) {
          return null;
        }
        if (root.type === 'group') {
          const sessionIds = root.sessionIds.filter((id) => valid.has(id));
          if (sessionIds.length !== root.sessionIds.length) {
            changed = true;
          }
          if (sessionIds.length === 0) {
            return null;
          }
          return { type: 'group', id: root.id, sessionIds };
        }
        const children: ChatLayoutNode[] = [];
        for (const child of root.children) {
          const pruned = pruneTree(child);
          if (pruned !== null) {
            children.push(pruned);
          }
        }
        if (children.length !== root.children.length) {
          changed = true;
        }
        if (children.length === 0) {
          return null;
        }
        if (children.length === 1) {
          if (root.children.length === 1) {
            // Degenerate split with a single surviving child — collapse it.
            changed = true;
          }
          return children[0];
        }
        return { type: 'split', orientation: root.orientation, children };
      };
      this.layout.root = pruneTree(this.layout.root);
      if (this.layout.focusedSessionId !== null && !valid.has(this.layout.focusedSessionId)) {
        const remaining = this.getOpenSessionIds();
        this.layout.focusedSessionId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        changed = true;
      }
      if (changed) {
        await this.persistLayout();
      }
      this.ctx.post({ type: 'connected', connected: true });
      this.ctx.post({ type: 'sessions', sessions: this.lastSessions, activeSessionId: this.layout.focusedSessionId });
      if (changed) {
        this.ctx.post({ type: 'chatLayout', layout: this.layout });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.ctx.post({ type: 'error', message: `Failed to load sessions: ${detail}` });
      this.ctx.post({ type: 'connected', connected: false });
    }

    // Keep the subagent block fresh whenever the main list refreshes.
    if (this.subagentsVisible && this.layout.focusedSessionId !== null && isConnected()) {
      await this.loadSubagents(this.layout.focusedSessionId);
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
    // Windows (and default macOS) filesystems are case-insensitive, and the
    // server's session.directory can carry different casing (or separators)
    // than VS Code's fsPath. Compare folded paths there, or every session is
    // filtered out and the active session gets dropped mid-conversation.
    const fold = (p: string): string => {
      const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
      return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized;
    };
    const roots = anchors.map(fold);
    return topLevel.filter((session) => {
      const dir = fold(session.directory);
      return roots.some((root) => dir === root || dir.startsWith(root + '/'));
    });
  }
}
