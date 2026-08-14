# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

A VS Code extension (`opencode-chat`, v0.7.5) that renders OpenCode chat in the secondary sidebar. It is an **HTTP client of a local OpenCode server** (`opencode serve`, default `http://127.0.0.1:4096`) via `@opencode-ai/sdk` — it never spawns the CLI. No local chat persistence: history lives server-side; only the active session ID is stored in VS Code workspace state.

Two codebases live in one repo:

1. **Extension host** — TypeScript in `src/`, bundled to `dist/extension.js` (CJS, esbuild, `external: ['vscode']` only).
2. **Webview** — plain JS in `media/js/`, bundled to `media/chat.bundle.js` (ESM, browser). Type-checked with `checkJs` via `tsconfig.webview.json`. **Not TypeScript — do not convert it.**

## Commit Messages & Releases

Pushes to `main` run a release workflow: it builds the VSIX, tags, and publishes to GitHub Releases. **The commit message decides whether a release happens** (see `.github/scripts/bump-version.mjs`):

- `feat:` / `fix:` → patch bump (`0.0.1` → `0.0.2`); scope `major`/`minor` bumps that level (`feat(major):` → `1.0.0`).
- `feat(release):` → releases the current version without bumping (only when the user explicitly asks for a release).
- `feat(none):` → no bump, no release.
- **Non-code types (`docs:`, `chore:`, `test:`, `refactor:`, `style:`, ...) never trigger a release** — scope doesn't override this.
- Non-conventional commit messages → no release.

Use `docs:` for documentation-only changes so no build/release runs. Only commit code changes with `feat:`/`fix:` when a release is intended.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | esbuild both bundles (host + webview) |
| `npm run watch` | Rebuild on change |
| `npm run compile` | `tsc -p ./` type-check of host (`out/` output is stale build artifact — never read it as source of truth) |
| `npm run check:webview` | `tsc -p ./tsconfig.webview.json` (allowJs/checkJs, noEmit) |
| `npm run package` | `npm run build && vsce package` |

Run `npm run compile` and `npm run check:webview` after changes touching either side. `npm run build` must succeed before F5 debugging (launch runs `dist/extension.js`).

## Source Map

```
src/
  extension.ts            activate/deactivate: status bar, 15s retry timer, 3 commands, config-watch reconnect on serverUrl change
  chatViewProvider.ts     WebviewProvider: message handler map, SSE dispatch, prompt flow, optimistic bubbles, catalog fetch
  opencodeClient.ts       SDK client factory: health-check connect (3 attempts, exp backoff), type-import workaround for node10/exports
  serverLauncher.ts       Detached `opencode serve` spawn on activation when server unreachable (loopback URLs, once per URL)
  events.ts               Single SSE /event loop: abort-aware resubscribe (2s), 3-strike failure -> markDisconnected()
  catalog.ts              Server metadata: commands/agents/providers+models, per-session agent/model selection maps
  nativeCommands.ts       undo/redo/diff/fork/share/abort/compact via SDK; diff capped 2000 chars
  sessions/manager.ts     Session list, active-id persistence (workspaceState), workspace filter, subagents (session.children)
  sessions/history.ts     History load + last-assistant-message tracking (undo target)
  questions/lifecycle.ts  Permission/question v1+v2 SSE -> cards; per-session pending question; stale auto-reject; reply routing
  webview/html.ts         Template substitution: __CSP__ __NONCE__ __STYLE_URI__ __SCRIPT_URI__ __SERVER_URL__
  webview/types.ts        Shared host<->webview contract types + ProviderContext interface
media/
  chat.html               Shell template (tokens only); loads chat.css + chat.bundle.js
  chat.bundle.js          GENERATED webview bundle — do not edit; edit media/js/* and rebuild
  chat.js                 LEGACY dead build, excluded from VSIX, unreferenced. Do not touch; do not revive.
  chat.css                Themed stylesheet, exclusively --vscode-* design tokens (no hardcoded colors)
  js/                     Webview source (11 ESM modules, see below)
  icon.svg                View container + view icon
esbuild.mjs               Dual build config
```

### Webview modules (`media/js/`)

| File | Responsibility |
| --- | --- |
| `app.js` | Entry: `route()` host-message switch, DOM refs, event wiring, keyboard nav |
| `state.js` | Shared mutable state object |
| `composer.js` | Send/stop, placeholder, slash-command popup (13 native + catalog commands), @-mention popup (agents + files), native result rendering |
| `sessions.js` | Session rows, active/subagent rendering, connection/empty states |
| `streaming.js` | Delta accumulation (`_accText`/`_accThinking`), rAF + 50ms/400-char throttle, live thinking block, stop-settle |
| `pickers.js` | Agent/model menus (grouped by provider), thinking toggle (localStorage), help overlay |
| `parts.js` | Part renderer: text/reasoning/tool/file/image/step/patch/agent/subtask/retry/compaction chips; bubble builder |
| `messages.js` | Upsert/adopt optimistic bubbles, history render with scroll preservation |
| `markdown.js` | Dependency-free markdown subset: escape-first, PUA + NUL sentinel tokenization, URL whitelist (http/https/mailto) |
| `cards.js` | Permission card (Allow/Always allow/Deny) + question card (radio/checkbox + free text) |
| `utils.js` | `acquireVsCodeApi` post wrapper, CSS-escape id lookup, time formatting, scroll, toast (5s) |
| `globals.d.ts` | checkJs ambient decls (`acquireVsCodeApi`, ad-hoc props) |

## Message Protocol (host ↔ webview)

Contract lives in `src/webview/types.ts`. No runtime validation — both sides must stay in sync manually when adding messages.

- **host → webview:** `connected, sessions, history, delta, message, busy, sessionDeleted, catalog, sessionMeta, nativeResult, subagents, files, permission, permissionResolved, question, questionResolved, error`
- **webview → host:** `ready, selectSession, prompt, newSession, deleteSession, refreshSessions, executeCommand, nativeCommand, setAgent, setModel, getCatalog, setSubagentsVisible, getFiles, permissionReply, questionReply`

`prompt`/`newSession` carry optional `files` (workspace-relative paths for `@file` mentions → server reads them via `file://` URLs) and `agent` (per-prompt agent override from `@agent` mentions — does not persist, unlike setAgent). `getFiles` → `files` (array of `{path, name}`) lists workspace files for the `@` mention popup.

`delta` posts carry `{partType, text, replace}`; the webview accumulates and re-renders on throttle. Do not make the webview poll.

## Key Flow: Streaming

1. Webview posts `prompt` → provider optimistic-echoes user bubble (`local-user-*`) + empty pending assistant bubble (`pending-*`), sets busy, auto-rejects any stale pending question.
2. `session.prompt({sessionID, parts, agent?, model?})` returns `{data: {info, parts}}`; incremental text arrives as SSE `message.part.updated` deltas.
3. `session.idle` → authoritative `loadHistory` replaces accumulated deltas (fixes drift; never skip).

## Gotchas

- **SSE shape is legacy** (`{type, properties}`) but tolerant code accepts both `p.sessionID` and `p.data?.sessionID` — keep both paths working.
- **SDK quirks (documented in code):** `session.compact` lives on `client.v2.session`; Permission3 has no reply endpoint → use `v2.session.permission.reply`; type imports from `@opencode-ai/sdk/dist/v2/client` need a node10 vs esbuild exports workaround (`src/opencodeClient.ts:1-11`).
- **CSP is strict:** `default-src 'none'`, script nonce-gated, styles/fonts/images from `cspSource` + `data:`/`file:`/server URL for images. No CDN, no external fonts, no inline scripts. Sourcemaps are off for the webview bundle (CSP would block `.map` fetches).
- **No external deps in webview** — markdown rendering is hand-rolled (`markdown.js`). Before adding a dependency, justify it: the current design is deliberately dependency-free.
- **User turns are plain text** — no markdown rendering on user bubbles (parts.js).
- **Theming:** all colors come from `--vscode-*` tokens. Never hardcode colors; never add `prefers-color-scheme` media queries.
- **i18n:** none. All strings are hardcoded English. Keep new UI strings in English, plain.
- **`out/` is stale:** tsc output from an older version (orphan files: converters.js, participant.js, sessionContentProvider.js). It's gitignored; never reference it.
- **`media/chat.js` is dead** — excluded from VSIX. Deleting it is fine; editing it is wasted work.
- **Provider disposal:** webview posts are guarded by `onDidDispose` + try/catch (`chatViewProvider.ts:108-143`). Any new async host work that posts to the view must go through the same guard.
- **Auto-start:** on activation, if the server is unreachable and `opencodeChat.autoStartServer` is enabled (default true) and the URL is loopback, the extension spawns `opencode serve` detached (`src/serverLauncher.ts`) — once per server URL per session.
- Only config keys: `opencodeChat.serverUrl`, `opencodeChat.workspaceFilter` (see package.json for defaults). Config change on serverUrl triggers full reconnect (stop stream → dispose client → re-init).

## Conventions

- **Error handling:** host catches, posts `{type:'error'}`, webview shows 5s toast (`utils.js`). Pending bubbles must never sit on "Thinking…" after failure — replace with error content.
- **Optimistic UI:** local bubbles get adopted by real message IDs on history load (`messages.js:38-74`).
- **Types:** strict TS on host (`noUnusedLocals`, `noFallthroughCasesInSwitch`). Webview relies on checkJs + `globals.d.ts`.
- **Styling:** edit `chat.css` only; webview markup structure is defined by parts.js/bubbles — keep selectors scoped.
- **Versioning:** bump `package.json` version; keep `engines.vscode` ≥ 1.106.0.
