import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Editor-level inline code completion (ghost text).
 *
 * Deliberately bypasses the OpenCode server: requests go straight to the
 * configured model provider (Zen/Go, Anthropic, or an OpenAI-compatible API)
 * using credentials from `opencodeChat.completion.*` settings or opencode's
 * auth.json. Background feature — every failure is logged to the
 * "OpenCode Completion" output channel and swallowed; nothing is toasted
 * unless the user explicitly runs the configure command.
 */

const INSTRUCTION =
  'Complete the code at the cursor position. Return ONLY the missing code that belongs exactly at <CURSOR>. Do not include surrounding code, explanations, markdown, or the code after the cursor.';

const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';

const DEBOUNCE_MS = 350;
const MAX_PREFIX_LINES = 10;
const MAX_SUFFIX_CHARS = 300;
const MAX_CONTEXT_CHARS = 4000;
const PREFIX_LINE_CAP = 500;
const CURSOR_LINE_CAP = 2000;
const ECHO_TAIL_CHARS = 40;
const AUTH_CACHE_TTL_MS = 30_000;

/** opencode auth.json locations; the second covers newer opencode versions. */
const AUTH_PATHS: ReadonlyArray<string> = [
  path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
  path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
];

const OPENAI_COMPAT_BASE_URLS: Readonly<Record<string, string>> = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434/v1',
};

const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  'opencode-go': 'deepseek-v4-flash',
  anthropic: 'claude-sonnet-4-5',
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'deepseek/deepseek-v4-flash',
  xai: 'grok-4-fast',
  mistral: 'mistral-small-latest',
  ollama: 'qwen3-coder:1.7b',
  custom: '',
};

/** Auto-mode preference order: Zen/Go first ("Zen/Go preferred"), then auth.json providers. */
const AUTO_PICK_ORDER: ReadonlyArray<string> = [
  'opencode-zen',
  'opencode-go',
  'deepseek',
  'anthropic',
  'openai',
  'google',
  'groq',
  'openrouter',
  'xai',
  'mistral',
  'ollama',
  'custom',
];

const KNOWN_BACKENDS: ReadonlySet<string> = new Set([
  'opencode-zen',
  'opencode-go',
  'anthropic',
  'deepseek',
  'openai',
  'google',
  'groq',
  'openrouter',
  'xai',
  'mistral',
  'ollama',
  'custom',
]);

interface CompletionBackend {
  id: string;
  label: string;
  complete(prefix: string, suffix: string, signal: AbortSignal): Promise<string | null>;
}

const outputChannel = vscode.window.createOutputChannel('OpenCode Completion');

let lastLoggedAt = 0;
let lastLoggedMessage = '';

/**
 * Replaces credential-shaped substrings (OpenAI `sk-`, opencode `oc_`, Google
 * `AIza`, xAI `xai-`, Groq `gsk_`, Perplexity `pplx-` tokens) so error
 * envelopes echoing an API key never reach the output channel.
 */
function redactSecrets(text: string): string {
  return text.replace(
    /\b(sk-[A-Za-z0-9_\-]+|oc_[A-Za-z0-9_\-]+|AIza[A-Za-z0-9_\-]+|xai-[A-Za-z0-9_\-]+|gsk_[A-Za-z0-9_\-]+|pplx-[A-Za-z0-9_\-]+)\b/g,
    '[REDACTED]'
  );
}

/** Rate-limited logger so repeated keystroke failures don't spam the channel. */
export function log(message: string): void {
  const redacted = redactSecrets(message);
  const now = Date.now();
  if (redacted === lastLoggedMessage && now - lastLoggedAt < 5000) {
    return;
  }
  lastLoggedMessage = redacted;
  lastLoggedAt = now;
  outputChannel.appendLine(`[${new Date().toISOString()}] ${redacted}`);
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('opencodeChat').get<boolean>('completion.enabled', false);
}

function configString(key: string): string {
  return vscode.workspace.getConfiguration('opencodeChat').get<string>(key, '');
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

interface AuthCache {
  providers: Map<string, string>;
  fetchedAt: number;
}

let authCache: AuthCache | undefined;

/**
 * Reads provider ids + keys from opencode's auth.json. Only provider ids and
 * the field names are ever touched here — key values are never logged.
 * Missing/corrupt file counts as "no providers". Both auth paths are merged
 * per-provider; the second (newer) path wins when a provider exists in both.
 * Cached for 30s.
 */
function readAuthProviders(): Map<string, string> {
  const now = Date.now();
  if (authCache !== undefined && now - authCache.fetchedAt < AUTH_CACHE_TTL_MS) {
    return authCache.providers;
  }

  const providers = new Map<string, string>();
  for (const authPath of AUTH_PATHS) {
    try {
      const raw = fs.readFileSync(authPath, 'utf8');
      const data: unknown = JSON.parse(raw);
      if (data === null || typeof data !== 'object') {
        continue;
      }
      for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
        if (entry === null || typeof entry !== 'object') {
          continue;
        }
        const record = entry as Record<string, unknown>;
        // opencode stores the key under "key"; tolerate the older "apiKey" layout.
        const key =
          typeof record.apiKey === 'string'
            ? record.apiKey
            : typeof record.key === 'string'
              ? record.key
              : undefined;
        if (key !== undefined && key.length > 0) {
          providers.set(id, key);
        }
      }
    } catch {
      // Missing or corrupt auth file — treat as "no providers".
    }
  }

  authCache = { providers, fetchedAt: now };
  return providers;
}

// ---------------------------------------------------------------------------
// Backend resolution
// ---------------------------------------------------------------------------

function createBackend(
  kind: string,
  key: string,
  modelOverride: string,
  maxTokens: number,
  factoryOpts: ChatFactoryOpts = {}
): CompletionBackend | null {
  const model = modelOverride || undefined;

  switch (kind) {
    case 'opencode-zen': {
      const baseUrl = configString('completion.baseUrl') || ZEN_BASE_URL;
      // Paid default regardless of key source; free-tier keys are balance-based
      // and indistinguishable from paid ones, so a 402/403 is retried once on
      // the free-tier model. An explicit user model choice is respected as-is.
      const defaultModel = 'deepseek-v4-flash';
      return makeOpenAICompatBackend('opencode-zen', 'OpenCode Zen', baseUrl, model ?? defaultModel, key, maxTokens, {
        ...factoryOpts,
        thinkingDisabled: true,
        freeTierFallbackModel: model === undefined ? 'deepseek-v4-flash-free' : undefined,
      });
    }
    case 'opencode-go': {
      const baseUrl = configString('completion.baseUrl') || GO_BASE_URL;
      return makeOpenAICompatBackend('opencode-go', 'OpenCode Go', baseUrl, model ?? DEFAULT_MODELS['opencode-go'], key, maxTokens, {
        ...factoryOpts,
        thinkingDisabled: true,
        freeTierFallbackModel: model === undefined ? 'deepseek-v4-flash-free' : undefined,
      });
    }
    case 'anthropic':
      return makeAnthropicBackend(key, model ?? DEFAULT_MODELS.anthropic, maxTokens, factoryOpts);
    case 'custom': {
      const baseUrl = configString('completion.customBaseUrl');
      if (baseUrl === '') {
        log('completion provider "custom" needs opencodeChat.completion.customBaseUrl');
        return null;
      }
      if (model === undefined || model === '') {
        log('completion provider "custom" needs opencodeChat.completion.model');
        return null;
      }
      return makeOpenAICompatBackend('custom', 'Custom', baseUrl, model, key, maxTokens, {
        ...factoryOpts,
        noAuth: !key,
      });
    }
    default: {
      // completion.baseUrl applies ONLY to opencode-zen/opencode-go; every
      // other OpenAI-compatible backend always uses its built-in base URL so
      // an override can never redirect a third-party key elsewhere.
      const baseUrl = OPENAI_COMPAT_BASE_URLS[kind];
      if (baseUrl === undefined || baseUrl === '') {
        log(`completion provider '${kind}' has no known base URL`);
        return null;
      }
      return makeOpenAICompatBackend(kind, kind, baseUrl, model ?? DEFAULT_MODELS[kind] ?? '', key, maxTokens, {
        ...factoryOpts,
        noAuth: kind === 'ollama',
      });
    }
  }
}

interface ResolvedBackendConfig {
  kind: string;
  key: string;
  modelOverride: string;
}

/**
 * Resolves which provider/model/key a request should use from the
 * `completion.provider` setting. Shared by ghost text, the exported
 * `queryModel`, and the commit-message command (which needs to distinguish
 * "nothing configured" from a failed request). Returns null (silently) when
 * nothing is configured/usable.
 */
export function resolveBackendConfig(): ResolvedBackendConfig | null {
  const provider = configString('completion.provider') || 'auto';
  const modelOverride = configString('completion.model');
  const configApiKey = configString('completion.apiKey');
  const auth = readAuthProviders();

  if (provider === 'auto') {
    // Explicit config key wins; otherwise take the first authenticated provider
    // with a known backend mapping, in preference order.
    if (configApiKey !== '') {
      return { kind: 'opencode-zen', key: configApiKey, modelOverride };
    }
    for (const id of AUTO_PICK_ORDER) {
      const key = auth.get(id);
      if (key !== undefined) {
        return { kind: id, key, modelOverride };
      }
    }
    return null;
  }

  if (provider === 'opencode-zen' || provider === 'opencode-go') {
    const key = configApiKey || auth.get(provider) || '';
    if (key === '') {
      log(`completion provider '${provider}' has no API key — set opencodeChat.completion.apiKey or authenticate with opencode`);
      return null;
    }
    return { kind: provider, key, modelOverride };
  }

  if (provider === 'custom') {
    const key = configApiKey || auth.get('custom') || '';
    return { kind: 'custom', key, modelOverride };
  }

  // Any other string is an auth.json provider id.
  const key = auth.get(provider);
  if (key === undefined) {
    log(`completion provider '${provider}' is not authenticated in opencode auth.json`);
    return null;
  }
  if (KNOWN_BACKENDS.has(provider)) {
    return { kind: provider, key, modelOverride };
  }
  // Authenticated but unknown — treat as a custom provider entry.
  log(`completion provider '${provider}' has no known backend — falling back to the custom base URL`);
  return { kind: 'custom', key, modelOverride };
}

/**
 * Determines the single backend for one request from the `completion.provider`
 * setting. Returns null (silently) when nothing is configured/usable.
 */
function resolveBackend(): CompletionBackend | null {
  const config = resolveBackendConfig();
  if (config === null) {
    return null;
  }
  const maxTokens = vscode.workspace.getConfiguration('opencodeChat').get<number>('completion.maxTokens', 128);
  return createBackend(config.kind, config.key, config.modelOverride, maxTokens);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/** Strips markdown fences, an echoed prompt tail, and rejects garbage results. */
function cleanCompletion(result: string, prefix: string, instruction: string = INSTRUCTION): string | null {
  let text = result.trimEnd().replace(/^\n+/, '');
  if (text.trim().length === 0) {
    return null;
  }
  // Reject outputs that re-emit the instruction or contain the cursor sentinel
  // (models sometimes echo the prompt back instead of completing).
  if (text.includes(instruction) || text.includes('<CURSOR>')) {
    return null;
  }
  // Strip a leading markdown code fence (``` or ```lang) and a trailing one.
  text = text.replace(/^```[^\n]*\n?/, '');
  text = text.replace(/```\s*$/, '');
  // Models sometimes echo the last bit of the prompt — strip it.
  const tail = prefix.slice(-ECHO_TAIL_CHARS);
  if (tail.length > 0 && text.startsWith(tail)) {
    text = text.slice(tail.length).replace(/^\s+/, '');
  }
  // Drop leading blank lines only; preserve leading spaces (indentation matters).
  text = text.replace(/^\n+/, '');
  if (text.trim().length === 0) {
    return null;
  }
  return text;
}

// ---------------------------------------------------------------------------
// HTTP backends
// ---------------------------------------------------------------------------

interface ChatBackendOptions {
  id: string;
  label: string;
  url: string;
  headers?: Record<string, string>;
  buildBody: (prefix: string, suffix: string) => Record<string, unknown>;
  extract: (data: unknown) => string | null;
  /** Timeout floor in ms — the configured completion.timeout is still respected but never goes below this. */
  timeoutFloorMs?: number;
  /**
   * Optional body builder used for a single retry when the provider answers
   * with a payment-status error (402/403) — e.g. free-tier Zen/Go keys on the
   * paid model. Unset for backends without a free-tier fallback.
   */
  retryBody?: (prefix: string, suffix: string) => Record<string, unknown>;
}

/**
 * Shared POST-JSON request: combines the VS Code cancellation signal with a
 * configurable timeout, tolerates non-JSON/error responses, and never throws.
 */
function makeChatBackend(opts: ChatBackendOptions): CompletionBackend {
  return {
    id: opts.id,
    label: opts.label,
    async complete(prefix, suffix, signal): Promise<string | null> {
      const configuredTimeout = vscode.workspace.getConfiguration('opencodeChat').get<number>('completion.timeout', 3000);
      const timeoutMs = opts.timeoutFloorMs === undefined ? configuredTimeout : Math.max(configuredTimeout, opts.timeoutFloorMs);
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      let timedOut = false;
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      // Sends one POST and reports the outcome; failures are logged here
      // (identical messages to the previous inline flow).
      const doRequest = async (
        body: Record<string, unknown>
      ): Promise<{ httpError: boolean; status: number; result: string | null }> => {
        const response = await fetch(opts.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          log(`${opts.label}: HTTP ${response.status}${detail !== '' ? ` — ${detail.slice(0, 200)}` : ''}`);
          return { httpError: true, status: response.status, result: null };
        }
        const data: unknown = await response.json().catch(() => null);
        if (data === null) {
          log(`${opts.label}: response was not valid JSON`);
          return { httpError: false, status: response.status, result: null };
        }
        return { httpError: false, status: response.status, result: opts.extract(data) };
      };

      try {
        const first = await doRequest(opts.buildBody(prefix, suffix));
        if (first.result !== null) {
          return first.result;
        }
        // Free-tier Zen/Go keys are balance-based and indistinguishable from
        // paid ones, so a 402/403 on the paid model means "no balance" — retry
        // ONCE on the free-tier model. Only payment-status errors retry; never
        // other failures or empty responses. Paid users never 402 → no overhead.
        if (first.httpError && (first.status === 402 || first.status === 403) && opts.retryBody !== undefined) {
          log(`${opts.label}: HTTP ${first.status} — retrying once with the free-tier model`);
          const retried = await doRequest(opts.retryBody(prefix, suffix));
          return retried.result;
        }
        return null;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          if (timedOut) {
            log(`${opts.label}: request timed out after ${timeoutMs}ms`);
          }
          return null;
        }
        log(`${opts.label}: request failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

interface OpenAICompatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

function contentToString(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part !== null && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        parts.push((part as { text: string }).text);
      }
    }
    const joined = parts.join('');
    return joined.trim().length > 0 ? joined : null;
  }
  return null;
}

/**
 * Backend factory options. Ghost text only sets `thinkingDisabled`/`noAuth`;
 * the remaining fields let other features (e.g. commit-message generation)
 * reuse the same factories with a custom instruction, a different fence
 * language, no `<CURSOR>` sentinel, and a longer timeout floor.
 */
interface ChatFactoryOpts {
  thinkingDisabled?: boolean;
  noAuth?: boolean;
  instruction?: string;
  fenceLang?: string;
  /** `null` omits the cursor sentinel entirely (custom instruction mode). */
  cursorSentinel?: string | null;
  timeoutFloorMs?: number;
  /**
   * Free-tier model used for a single 402/403 retry. Set only by the Zen/Go
   * backends when the user did not explicitly pick a model.
   */
  freeTierFallbackModel?: string;
}

function makeOpenAICompatBackend(
  id: string,
  label: string,
  baseUrl: string,
  model: string,
  key: string,
  maxTokens: number,
  opts: ChatFactoryOpts = {}
): CompletionBackend {
  const buildBodyForModel = (modelName: string): ((prefix: string, suffix: string) => Record<string, unknown>) => {
    return (prefix, suffix) => {
      const instruction = opts.instruction ?? INSTRUCTION;
      const body: Record<string, unknown> = {
        model: modelName,
        messages: [
          {
            role: 'user',
            content:
              opts.cursorSentinel === null
                ? `${instruction}\n\n\`\`\`${opts.fenceLang ?? ''}\n${prefix}${suffix}\n\`\`\``
                : `${instruction}\n\n\`\`\`\n${prefix}${opts.cursorSentinel ?? '<CURSOR>'}${suffix}\n\`\`\``,
          },
        ],
        max_tokens: maxTokens,
        stream: false,
      };
      if (opts.thinkingDisabled === true) {
        body.thinking = { type: 'disabled' };
      }
      return body;
    };
  };
  return makeChatBackend({
    id,
    label,
    url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    headers: opts.noAuth === true ? {} : { Authorization: `Bearer ${key}` },
    timeoutFloorMs: opts.timeoutFloorMs,
    buildBody: buildBodyForModel(model),
    retryBody: opts.freeTierFallbackModel === undefined ? undefined : buildBodyForModel(opts.freeTierFallbackModel),
    extract: (data) => contentToString((data as OpenAICompatResponse)?.choices?.[0]?.message?.content),
  });
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }> | string;
}

/**
 * Pre-3.7 Anthropic models reject an explicit `thinking: {type:'disabled'}`.
 * Only send the field for models known to accept it; for everything else omit
 * it (disabled is the API default anyway).
 */
function anthropicSupportsThinkingField(model: string): boolean {
  return /^claude-(3-7|3-8|3-9|4)/.test(model) || /sonnet-4|opus-4|haiku-3-5/.test(model);
}

function makeAnthropicBackend(key: string, model: string, maxTokens: number, opts: ChatFactoryOpts = {}): CompletionBackend {
  return makeChatBackend({
    id: 'anthropic',
    label: 'Anthropic',
    url: ANTHROPIC_BASE_URL,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    timeoutFloorMs: opts.timeoutFloorMs,
    buildBody: (prefix, suffix) => {
      const instruction = opts.instruction ?? INSTRUCTION;
      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        system: instruction,
        messages: [
          {
            role: 'user',
            content: opts.cursorSentinel === null ? prefix + suffix : prefix + (opts.cursorSentinel ?? '<CURSOR>') + suffix,
          },
        ],
      };
      if (anthropicSupportsThinkingField(model)) {
        body.thinking = { type: 'disabled' };
      }
      return body;
    },
    extract: (data) => contentToString((data as AnthropicResponse)?.content),
  });
}

// ---------------------------------------------------------------------------
// Context window
// ---------------------------------------------------------------------------

function trimPrefixToBudget(prefix: string, overflow: number): string {
  const lines = prefix.split('\n');
  let droppedChars = 0;
  let dropped = 0;
  while (dropped < lines.length - 1 && droppedChars < overflow) {
    droppedChars += lines[dropped].length + 1;
    dropped++;
  }
  return lines.slice(dropped).join('\n');
}

function buildContextWindow(
  document: vscode.TextDocument,
  position: vscode.Position
): { prefix: string; suffix: string } | undefined {
  const startLine = Math.max(0, position.line - MAX_PREFIX_LINES);

  let prefix = '';
  for (let line = startLine; line < position.line; line++) {
    const text = document.lineAt(line).text;
    prefix += (text.length > PREFIX_LINE_CAP ? text.slice(0, PREFIX_LINE_CAP) : text) + '\n';
  }
  const cursorLine = document.lineAt(position.line).text;
  prefix += cursorLine.slice(0, Math.min(position.character, CURSOR_LINE_CAP));

  // Cap the cursor-line suffix so a cursor deep in a huge line can't ship
  // ~100KB of trailing text to the model.
  let suffix = cursorLine.slice(position.character, position.character + MAX_SUFFIX_CHARS);
  let line = position.line + 1;
  while (suffix.length < MAX_SUFFIX_CHARS && line < document.lineCount) {
    const nextLine = document.lineAt(line).text;
    if (nextLine.length > MAX_SUFFIX_CHARS) {
      suffix += '\n' + nextLine.slice(0, MAX_SUFFIX_CHARS);
      break;
    }
    if (suffix.length + nextLine.length + 1 > MAX_SUFFIX_CHARS) {
      break;
    }
    suffix += '\n' + nextLine;
    line++;
  }

  const overflow = prefix.length + suffix.length - MAX_CONTEXT_CHARS;
  if (overflow > 0) {
    // Trim the prefix first (drop whole earlier lines), then the suffix tail.
    prefix = trimPrefixToBudget(prefix, overflow);
    const remainingOverflow = prefix.length + suffix.length - MAX_CONTEXT_CHARS;
    if (remainingOverflow > 0) {
      suffix = suffix.slice(0, Math.max(0, suffix.length - remainingOverflow));
    }
  }

  if (prefix.length === 0 && suffix.length === 0) {
    return undefined;
  }
  return { prefix, suffix };
}

// ---------------------------------------------------------------------------
// Inline completion provider
// ---------------------------------------------------------------------------

interface PerDocumentState {
  debounceHandle: NodeJS.Timeout | undefined;
  debounceResolve: ((value: vscode.InlineCompletionList | undefined) => void) | undefined;
  inflightAbort: AbortController | undefined;
  requestGeneration: number;
}

/**
 * Request state is keyed per document URI so typing in one editor never
 * supersedes/cancels another editor's in-flight request. Entries are removed
 * when the document closes; otherwise growth is bounded by open editors.
 */
const perDocumentStates = new Map<string, PerDocumentState>();

function getDocumentState(uri: string): PerDocumentState {
  let state = perDocumentStates.get(uri);
  if (state === undefined) {
    state = { debounceHandle: undefined, debounceResolve: undefined, inflightAbort: undefined, requestGeneration: 0 };
    perDocumentStates.set(uri, state);
  }
  return state;
}

const completionProvider: vscode.InlineCompletionItemProvider = {
  provideInlineCompletionItems(document, position, _context, token) {
    if (!isEnabled()) {
      return undefined;
    }

    const contextWindow = buildContextWindow(document, position);
    if (contextWindow === undefined) {
      return undefined;
    }

    // Supersede the previous request for THIS document: resolve a still-pending
    // debounce, cancel an in-flight fetch, and invalidate results from older calls.
    const state = getDocumentState(document.uri.toString());
    const generation = ++state.requestGeneration;
    if (state.debounceHandle !== undefined) {
      clearTimeout(state.debounceHandle);
      state.debounceHandle = undefined;
    }
    if (state.debounceResolve !== undefined) {
      state.debounceResolve(undefined);
      state.debounceResolve = undefined;
    }
    if (state.inflightAbort !== undefined) {
      state.inflightAbort.abort();
      state.inflightAbort = undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const controller = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() => {
      if (generation === state.requestGeneration) {
        controller.abort();
      }
    });

    return new Promise<vscode.InlineCompletionList | undefined>((resolve) => {
      let settled = false;
      const settle = (value: vscode.InlineCompletionList | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        cancelSubscription.dispose();
        resolve(value);
      };

      state.debounceResolve = settle;
      state.debounceHandle = setTimeout(() => {
        state.debounceHandle = undefined;
        if (state.debounceResolve === settle) {
          state.debounceResolve = undefined;
        }
        if (generation !== state.requestGeneration || token.isCancellationRequested || !isEnabled()) {
          settle(undefined);
          return;
        }
        state.inflightAbort = controller;
        void runCompletion(contextWindow, position, controller.signal)
          .then((result) => {
            if (generation === state.requestGeneration && isEnabled()) {
              settle(result);
            } else {
              settle(undefined);
            }
          })
          .catch(() => settle(undefined))
          .finally(() => {
            if (state.inflightAbort === controller) {
              state.inflightAbort = undefined;
            }
          });
      }, DEBOUNCE_MS);
    });
  },
};

async function runCompletion(
  contextWindow: { prefix: string; suffix: string },
  position: vscode.Position,
  signal: AbortSignal
): Promise<vscode.InlineCompletionList | undefined> {
  try {
    const backend = resolveBackend();
    if (backend === null) {
      return undefined;
    }
    const result = await backend.complete(contextWindow.prefix, contextWindow.suffix, signal);
    if (result === null) {
      return undefined;
    }
    const cleaned = cleanCompletion(result, contextWindow.prefix);
    if (cleaned === null) {
      return undefined;
    }
    return new vscode.InlineCompletionList([
      new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position)),
    ]);
  } catch (err) {
    log(`completion failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared model query (used by the commit-message command)
// ---------------------------------------------------------------------------

const COMMIT_MAX_TOKENS = 300;
const COMMIT_TIMEOUT_FLOOR_MS = 10_000;

/**
 * One-off model query reusing the SAME backend resolution as inline completion
 * (provider/model config, keys from config or opencode auth.json). Sends
 * `instruction` + `input` (fenced as a diff) and returns cleaned text.
 * Never throws — failures are logged to the completion output channel and
 * result in null. Ghost-text behavior is unaffected.
 */
export async function queryModel(
  instruction: string,
  input: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    const config = resolveBackendConfig();
    if (config === null) {
      return null;
    }
    const backend = createBackend(config.kind, config.key, config.modelOverride, COMMIT_MAX_TOKENS, {
      instruction,
      fenceLang: 'diff',
      cursorSentinel: null,
      timeoutFloorMs: COMMIT_TIMEOUT_FLOOR_MS,
    });
    if (backend === null) {
      return null;
    }
    const result = await backend.complete(input, '', signal);
    if (result === null) {
      return null;
    }
    return cleanCompletion(result, '', instruction);
  } catch (err) {
    log(`queryModel failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Configure command
// ---------------------------------------------------------------------------

function defaultModelFor(providerValue: string): string {
  if (providerValue === 'opencode-zen' || providerValue === 'auto') {
    // Paid default regardless of key source; free-tier keys fail gracefully.
    return 'deepseek-v4-flash';
  }
  return DEFAULT_MODELS[providerValue] ?? 'deepseek-v4-flash';
}

/**
 * Model picker with an editable input: pick a listed model or type a custom
 * one and press Enter. `null` means the user dismissed the picker.
 */
function pickModel(defaultModel: string): Promise<string | null> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    quickPick.title = 'OpenCode: Configure Completion — model';
    quickPick.placeholder = 'Pick a model or type a custom one and press Enter';
    quickPick.items = [
      { label: defaultModel || 'provider default', description: 'Provider default model' },
      { label: 'deepseek-v4-flash' },
      { label: 'qwen3-coder:1.7b' },
      { label: 'claude-sonnet-4-5' },
      { label: 'gpt-4o-mini' },
    ];

    let done = false;
    const finish = (value: string | null): void => {
      if (done) {
        return;
      }
      done = true;
      quickPick.dispose();
      resolve(value);
    };

    quickPick.onDidAccept(() => {
      const typed = quickPick.value.trim();
      const selection = quickPick.selectedItems[0];
      if (selection !== undefined && (typed === '' || selection.label.toLowerCase() === typed.toLowerCase())) {
        finish(selection.label === 'provider default' ? '' : selection.label);
      } else if (typed !== '') {
        finish(typed);
      } else if (selection !== undefined) {
        finish(selection.label === 'provider default' ? '' : selection.label);
      } else {
        finish(defaultModel || '');
      }
    });
    quickPick.onDidHide(() => finish(null));
    quickPick.show();
  });
}

async function configureCompletion(): Promise<void> {
  const config = vscode.workspace.getConfiguration('opencodeChat');
  const target = vscode.ConfigurationTarget.Global;

  const authProviders = readAuthProviders();
  const providerItems: vscode.QuickPickItem[] = [
    { label: 'auto', description: 'Recommended — OpenCode Zen/Go if a key is available, else the first provider authenticated with opencode' },
    { label: 'opencode-zen', description: 'OpenCode Zen backend' },
    { label: 'opencode-go', description: 'OpenCode Go backend' },
  ];
  const listedIds = new Set(['auto', 'opencode-zen', 'opencode-go', 'custom', 'disable']);
  for (const id of authProviders.keys()) {
    if (listedIds.has(id)) {
      continue; // already listed above (e.g. opencode-go is a common auth.json provider)
    }
    providerItems.push({ label: id, description: 'Provider authenticated in opencode auth.json' });
  }
  providerItems.push({ label: 'custom', description: 'OpenAI-compatible provider with a custom base URL' });
  providerItems.push({ label: 'disable', description: 'Turn inline completion off' });

  const providerPick = await vscode.window.showQuickPick(providerItems, {
    title: 'OpenCode: Configure Completion — provider',
    placeHolder: 'Select a completion provider',
  });
  if (providerPick === undefined) {
    return;
  }

  if (providerPick.label === 'disable') {
    await config.update('completion.enabled', false, target);
    void vscode.window.showInformationMessage('OpenCode inline completion is now disabled.');
    return;
  }

  const providerValue = providerPick.label;
  const defaultModel = defaultModelFor(providerValue);
  const modelValue = await pickModel(defaultModel);
  if (modelValue === null) {
    return;
  }

  await config.update('completion.provider', providerValue, target);
  await config.update('completion.model', modelValue, target);
  await config.update('completion.enabled', true, target);

  const modelText = modelValue !== '' ? `model '${modelValue}'` : 'provider default model';
  void vscode.window.showInformationMessage(`OpenCode inline completion enabled: provider '${providerValue}' with ${modelText}.`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the inline completion provider and the configure command. Called
 * from activate(); the provider is always registered but inactive while
 * `opencodeChat.completion.enabled` is false.
 */
export function registerCompletion(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    outputChannel,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
    vscode.commands.registerCommand('opencodeChat.configureCompletion', configureCompletion),
    // Drop per-document request state (pending debounce/in-flight fetch) when
    // the document closes, cancelling any request still running against it.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const uri = doc.uri.toString();
      const state = perDocumentStates.get(uri);
      if (state === undefined) {
        return;
      }
      if (state.debounceHandle !== undefined) {
        clearTimeout(state.debounceHandle);
      }
      if (state.debounceResolve !== undefined) {
        state.debounceResolve(undefined);
      }
      if (state.inflightAbort !== undefined) {
        state.inflightAbort.abort();
      }
      perDocumentStates.delete(uri);
    })
  );
}
