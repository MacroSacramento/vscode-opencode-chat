import * as path from 'path';
import * as vscode from 'vscode';
import { getClient } from './opencodeClient';
import type { SnapshotFileDiff } from '@opencode-ai/sdk/dist/v2/client';

// Scheme for virtual "original" documents shown on the left side of each
// review diff. Contents are held in memory keyed by the uri's path segment.
const SCHEME = 'opencode-review';

// base64url(file path) -> original (pre-session) content.
const originals = new Map<string, string>();

let providerRegistration: vscode.Disposable | undefined;

class ReviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    // The uri path is `<key>/<basename>`; the base64url key never contains `/`.
    const slash = uri.path.indexOf('/');
    const key = slash === -1 ? uri.path : uri.path.slice(0, slash);
    return originals.get(key) ?? '';
  }
}

function keyFor(filePath: string): string {
  return Buffer.from(filePath, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Registers `content` in memory and returns a virtual URI whose path carries
 * the file's basename, so VS Code can infer the language for syntax
 * highlighting. `suffix` disambiguates multiple views of the same file (e.g.
 * the empty right side of a deleted file).
 */
function virtualUri(absPath: string, content: string, suffix: string): vscode.Uri {
  const key = keyFor(absPath) + suffix;
  originals.set(key, content);
  const base = encodeURIComponent(path.basename(absPath));
  return vscode.Uri.parse(`${SCHEME}:${key}/${base}`);
}

function ensureProvider(): void {
  if (providerRegistration === undefined) {
    providerRegistration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ReviewContentProvider());
  }
}

interface HunkLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

interface Hunk {
  newStart: number;
  newCount: number;
  oldCount: number;
  lines: HunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a unified diff `patch` body into hunks (skips ---/+++ headers and preamble). */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of patch.split(/\r?\n/)) {
    const header = raw.match(HUNK_HEADER);
    if (header) {
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      current = { newStart, newCount, oldCount, lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: raw.slice(1) });
    }
    // `\ No newline at end of file` markers and anything else are ignored.
  }
  return hunks;
}

/**
 * Reconstructs the pre-change content of a modified file by applying its
 * unified diff in reverse to the current on-disk content. Hunks are applied
 * last-to-first so earlier line numbers stay valid as the array mutates.
 */
function reverseApplyPatch(current: string, patch: string): string {
  if (patch === '') {
    return current;
  }
  // Windows files use CRLF; the unified diff's lines are LF. Normalize the
  // current content to LF so hunk line indices stay consistent, then restore
  // the file's original endings so the reconstructed left pane matches the
  // live right pane (avoids the diff editor flagging every line).
  const crlf = current.includes('\r\n');
  const normalized = crlf ? current.replace(/\r\n/g, '\n') : current;
  const lines = normalized.split('\n');
  const hunks = parseHunks(patch);
  for (let i = hunks.length - 1; i >= 0; i--) {
    const hunk = hunks[i];
    const before: string[] = [];
    let cursor = hunk.newStart - 1;
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        before.push(lines[cursor]);
        cursor++;
      } else if (line.kind === 'add') {
        cursor++;
      } else {
        before.push(line.text);
      }
    }
    lines.splice(hunk.newStart - 1, hunk.newCount, ...before);
  }
  const result = lines.join('\n');
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}

/** Reconstructs the content of a deleted file from its diff's removed (`-`) lines. */
function reconstructRemoved(patch: string): string {
  const lines: string[] = [];
  for (const hunk of parseHunks(patch)) {
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        lines.push(line.text);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Builds one `[label, original, modified]` entry for the changes editor. The
 * label is the real file URI (drives the file list + language), the original
 * is the reconstructed pre-session content served from the virtual provider,
 * and the modified side is the live file (or an empty virtual doc for deletes).
 */
async function buildChangeEntry(
  file: string,
  diffs: SnapshotFileDiff[],
  rootDir: string,
): Promise<[vscode.Uri, vscode.Uri, vscode.Uri] | undefined> {
  const absPath = path.isAbsolute(file) ? file : path.join(rootDir, file);

  let current = '';
  let exists = false;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
    current = Buffer.from(bytes).toString('utf8');
    exists = true;
  } catch {
    /* file does not exist (deleted) */
  }

  // Diffs arrive per message in chronological order; reconstruct the
  // pre-session content by reverse-applying each one newest-to-oldest.
  let original = current;
  for (let i = diffs.length - 1; i >= 0; i -= 1) {
    const diff = diffs[i];
    original = diff.status === 'deleted' ? reconstructRemoved(diff.patch ?? '') : reverseApplyPatch(original, diff.patch ?? '');
  }

  // No net change: existence unchanged (created-then-deleted, or deleted-then-
  // recreated identical) and content identical before/after. Skip it.
  const existedBefore = diffs[0]?.status !== 'added';
  if (existedBefore === exists && original === current) {
    return undefined;
  }

  const label = vscode.Uri.file(absPath);
  const originalUri = virtualUri(absPath, original, '');
  const modifiedUri = exists ? label : virtualUri(absPath, '', '-empty');
  return [label, originalUri, modifiedUri];
}

/**
 * Adds a file's diffs to the accumulator, dropping exact duplicates. The
 * parent session's per-message diff already rolls subagent changes up, so the
 * same change appears under both the parent message and the child session;
 * deduplicating on (status, patch) keeps subagent edits from double-counting.
 */
function addDiffs(byFile: Map<string, SnapshotFileDiff[]>, diffs: SnapshotFileDiff[]): void {
  for (const diff of diffs) {
    const file = diff.file ?? '';
    if (file === '') {
      continue;
    }
    const list = byFile.get(file);
    if (list === undefined) {
      byFile.set(file, [diff]);
      continue;
    }
    const duplicate = list.some((d) => d.status === diff.status && d.patch === diff.patch);
    if (!duplicate) {
      list.push(diff);
    }
  }
}

/**
 * Collects a session's file changes by diffing each of its user messages, then
 * recurses into subagent (child) sessions so their edits are included even
 * when the parent's roll-up misses them.
 */
async function collectDiffs(sessionId: string, byFile: Map<string, SnapshotFileDiff[]>, visited: Set<string>): Promise<void> {
  if (visited.has(sessionId)) {
    return;
  }
  visited.add(sessionId);

  const messages = (await getClient().session.messages({ sessionID: sessionId })).data ?? [];
  for (const message of messages) {
    if (message.info.role !== 'user') {
      continue;
    }
    const diffs = (await getClient().session.diff({ sessionID: sessionId, messageID: message.info.id })).data ?? [];
    addDiffs(byFile, diffs);
  }

  const children = (await getClient().session.children({ sessionID: sessionId })).data ?? [];
  for (const child of children) {
    try {
      await collectDiffs(child.id, byFile, visited);
    } catch {
      /* skip a broken child session rather than aborting the whole review */
    }
  }
}

/**
 * Opens the session's file changes in a single VS Code "changes" editor
 * (MultiDiffEditor): one tab with a file list and next/previous-change
 * navigation, instead of one diff tab per file.
 */
export async function reviewChanges(sessionId: string): Promise<void> {
  // `session.diff` is per-message (empty without a messageID). Aggregate each
  // message's diff across the session and its subagent sessions.
  const byFile = new Map<string, SnapshotFileDiff[]>();
  try {
    await collectDiffs(sessionId, byFile, new Set());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Failed to load session diff: ${detail}`);
    return;
  }

  if (byFile.size === 0) {
    void vscode.window.showInformationMessage('No file changes in this session.');
    return;
  }

  let rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  try {
    const session = await getClient().session.get({ sessionID: sessionId });
    if (session.data?.directory) {
      rootDir = session.data.directory;
    }
  } catch {
    /* fall back to the open workspace folder */
  }

  ensureProvider();
  const resourceList: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
  for (const [file, diffs] of byFile) {
    const entry = await buildChangeEntry(file, diffs, rootDir);
    if (entry !== undefined) {
      resourceList.push(entry);
    }
  }
  if (resourceList.length === 0) {
    void vscode.window.showInformationMessage('No file changes in this session.');
    return;
  }
  await vscode.commands.executeCommand('vscode.changes', 'Review changes', resourceList);
}