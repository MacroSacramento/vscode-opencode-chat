import * as vscode from 'vscode';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';
// Ports in the OS ephemeral range: avoids well-known service ports (5000,
// 5432, 6379, 8080, ...) that a derived port could otherwise collide with.
const PORT_BASE = 32768;
const PORT_RANGE = 10000;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** FNV-1a 32-bit hash — deterministic across runs and platforms. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic per-project port: the same folder always maps to the same
 * port (so reopening a project reconnects to its existing server), while
 * different folders map to different ports (so each VS Code window can run
 * its own server).
 */
export function portForDirectory(directory: string): number {
  return PORT_BASE + (hashString(directory) % PORT_RANGE);
}

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''));
}

/**
 * Resolves the server URL for this window. When auto-start is enabled and a
 * workspace folder is open, the window uses its own server on a port derived
 * from the folder path — so multiple windows (one per project) each get an
 * independent server anchored to their project. Falls back to the configured
 * URL when auto-start is off, the configured URL is not loopback, or no
 * folder is open.
 */
export function resolveServerUrl(): string {
  const config = vscode.workspace.getConfiguration('opencodeChat');
  const configured = config.get<string>('serverUrl') ?? DEFAULT_SERVER_URL;
  const autoStart = config.get<boolean>('autoStartServer') ?? true;
  if (!autoStart) {
    return configured;
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return configured;
  }
  if (!isLoopback(url)) {
    return configured;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    return configured;
  }
  return `http://127.0.0.1:${portForDirectory(folder.uri.fsPath)}`;
}