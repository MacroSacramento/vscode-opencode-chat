// The SDK exposes `global.health()` only on the v2 client
// (`@opencode-ai/sdk/v2/client`). That exports subpath resolves for esbuild
// (via the package "import" condition) but not for tsc's default `node10`
// resolution (this tsconfig sets no `moduleResolution`), so the value import
// uses the exports path while the real types come from the deep declaration
// file, which node10 *can* resolve.
import type { createOpencodeClient as createOpencodeClientFactory } from '@opencode-ai/sdk/dist/v2/client';
// @ts-ignore -- unresolved under tsc's node10 module resolution; resolved by esbuild via package "exports"
import { createOpencodeClient as _createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const createOpencodeClient: typeof createOpencodeClientFactory = _createOpencodeClient;

export interface OpenCodeClientOptions {
  serverUrl: string;
  onStateChange?: (connected: boolean) => void;
  log?: (message: string) => void;
}

export type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

const LOG_PREFIX = '[opencode-chat]';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';
const HEALTH_MAX_ATTEMPTS = 3;
const HEALTH_INITIAL_BACKOFF_MS = 500;

let options: OpenCodeClientOptions | undefined;
let client: OpenCodeClient | undefined;
let connected = false;
let connecting = false;

function log(message: string): void {
  options?.log?.(`${LOG_PREFIX} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Store connection options. If a client already exists for a different server
 * URL, it is disposed here; the replacement client is created lazily on the
 * next `connect()` call.
 */
export function initOpenCode(newOptions: OpenCodeClientOptions): void {
  const previousUrl = options?.serverUrl;
  options = newOptions;
  if (previousUrl !== newOptions.serverUrl && client !== undefined) {
    log(`Server URL changed (${previousUrl} -> ${newOptions.serverUrl}); reconnecting on next connect()`);
    disposeInternal();
  }
}

/**
 * Idempotently connect to the OpenCode server. Creates the SDK client and
 * verifies it with `client.global.health()`, retrying up to 3 times with
 * exponential backoff (500ms, doubling).
 */
export async function connect(): Promise<boolean> {
  if (connected && client !== undefined) {
    return true;
  }
  if (connecting) {
    log('connect() already in progress; skipping');
    return false;
  }
  if (options === undefined) {
    log('connect() called before initOpenCode()');
    return false;
  }

  connecting = true;
  try {
    client = createOpencodeClient({ baseUrl: options.serverUrl });

    let backoffMs = HEALTH_INITIAL_BACKOFF_MS;
    for (let attempt = 1; attempt <= HEALTH_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await client.global.health();
        if (res.data === undefined || res.data.healthy !== true) {
          throw new Error('OpenCode server did not report healthy');
        }
        connected = true;
        options.onStateChange?.(true);
        log(`Connected to OpenCode server at ${options.serverUrl} (version ${res.data.version})`);
        return true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`Health check attempt ${attempt}/${HEALTH_MAX_ATTEMPTS} failed: ${detail}`);
        if (attempt < HEALTH_MAX_ATTEMPTS) {
          await sleep(backoffMs);
          backoffMs *= 2;
        }
      }
    }

    connected = false;
    options.onStateChange?.(false);
    log(`Failed to connect to OpenCode server at ${options.serverUrl}`);
    return false;
  } finally {
    connecting = false;
  }
}

/** Returns the live SDK client, throwing when the server is not connected. */
export function getClient(): OpenCodeClient {
  if (!connected || client === undefined) {
    throw new Error('OpenCode server not connected');
  }
  return client;
}

export function isConnected(): boolean {
  return connected;
}

/** Returns the configured server URL, or the default before initOpenCode(). */
export function getServerUrl(): string {
  return options?.serverUrl ?? DEFAULT_SERVER_URL;
}

/** Disconnects and drops the client reference. */
export function disposeOpenCode(): void {
  disposeInternal();
}

/**
 * Marks the connection as dropped (state + client reference) without any
 * URL-change semantics — used when the event stream detects a server outage
 * so the extension's retry timer can re-establish the connection.
 */
export function markDisconnected(): void {
  disposeInternal();
}

function disposeInternal(): void {
  connected = false;
  client = undefined;
  options?.onStateChange?.(false);
}
