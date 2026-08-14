# OpenCode Chat

OpenCode chat as its own sidebar panel — session list, history, and streaming responses backed by a local OpenCode server.

This extension embeds a full chat UI in the VS Code secondary sidebar. It connects to a **local OpenCode server** over HTTP (via `@opencode-ai/sdk`), streams responses into the panel, and exposes the server's sessions, agents, models, commands, and permission prompts directly in the editor.

## Features

- **Dedicated chat panel** in the secondary sidebar with session list, active-session highlighting, and subagent browsing
- **Streaming responses** with live thinking block (collapsible `details`), throttled delta rendering, and stop/abort
- **Session management** — create, switch, refresh, delete sessions; history loaded from the server (no local persistence); workspace filtering
- **Agent & model pickers** per session, grouped by provider, re-synced from the server on session updates
- **Native command controls** — undo, redo, diff, fork, share, abort, compact
- **Permission & question cards** — Allow / Always allow / Deny prompts and question dialogs (radio/checkbox + free text) rendered inline, with stale-question auto-rejection
- **Slash-command popup** in the composer backed by the server's command catalog
- **Connection status** in the status bar (`$(hubot) OpenCode: connected/disconnected`) with automatic reconnect
- **Theme-native styling** — uses only VS Code design tokens, works in light and dark themes
- **Dependency-free webview** — no CDNs, no marked/highlight.js; custom escape-first markdown subset with strict CSP

## Installation

The extension is not published to a marketplace; install it from the built VSIX or from source.

### From VSIX

1. Install dependencies and build the package:
   ```bash
   npm install
   npm run package
   ```
2. The build produces `opencode-chat-<version>.vsix` in the project root.
3. In VS Code, open **Extensions** (`Ctrl+Shift+X` / `Cmd+Shift+X`), click the `...` menu, and choose **Install from VSIX...**. Select the `.vsix` file.

### From source (development)

1. `npm install`
2. `npm run build` (or `npm run watch` for rebuilds on change)
3. Open this repository in VS Code and press **F5** to launch the Extension Development Host.

## Requirements

- **VS Code Insiders**, or **stable VS Code** launched with the experimental chat APIs enabled:
  ```bash
  code --enable-proposed-api macrosacramento.opencode-chat
  ```
  The extension relies on experimental chat-panel APIs and design tokens that are not available in stock stable VS Code.
- **OpenCode** installed and a server running. The extension does not spawn the CLI — it connects to an already-running server.

## Getting Started

1. Install the extension.
2. Start the OpenCode server:
   ```bash
   opencode serve
   ```
   (or run the TUI, which serves the same API)
3. Open the **OpenCode** panel in the secondary sidebar. If the panel shows the welcome screen, click **Start the server** or use the command palette:
   - `OpenCode: Open Server URL` — opens the server URL in your browser
4. Type a message in the composer and send.

> If the server was started after the panel was opened, click the refresh icon in the view title bar (or reopen the panel) to reconnect.

## Commands

| Command | Description |
| --- | --- |
| `OpenCode: New Chat` | Focus the chat view and start a new session |
| `OpenCode: Open Server URL` | Open the configured server URL in the default browser |
| `OpenCode: Refresh Sessions` | Focus the chat view and refresh the session list |

The first two commands are available as icons in the view title bar. `OpenCode: Open Server URL` is also available in the command palette, and the status bar item opens the server URL when clicked.

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `opencodeChat.serverUrl` | `string` | `http://127.0.0.1:4096` | Base URL of the OpenCode server to connect to. Changing it reconnects automatically. |
| `opencodeChat.workspaceFilter` | `boolean` | `true` | Only show sessions from the current workspace directory (falls back to the server's working directory when no folder is open). |

## Usage

### Chat

- Send a message from the composer. User turns are plain text; assistant turns render a markdown subset (headings, bold/italic, inline & fenced code, lists, links, blockquotes, horizontal rules).
- **Stop** button interrupts the current response.
- **Thinking** toggle (top of composer) shows/hides the live reasoning block; the preference persists per webview.

### Sessions

- The session list shows all sessions (filtered to the workspace by default). The active session is persisted across reloads via workspace state.
- New session / delete / refresh are available from the panel title bar and the composer.
- Subagents can be listed per session via the subagents toggle.

### Agents & models

- Pick an agent or model per session from the composer badges. Selections are sent with every prompt and command, and re-synced when the server updates the session.

### Permissions & questions

- When the server asks for permission, an inline card appears with **Allow / Always allow / Deny**.
- Question prompts render as radio/checkbox options (with a free-text field when the server allows custom input).
- If a question goes stale (a new prompt is sent before it is answered), it is auto-rejected server-side.

### Native commands

Available via the composer's command popup (also as `/` shortcuts for catalog commands):

- **Undo** — revert the session to before the last assistant message
- **Redo** — re-apply the undone turn
- **Diff** — show the last change as formatted text (capped at 2000 characters)
- **Fork** — fork the session and refresh the list
- **Share** — share the session
- **Abort** — stop the current turn
- **Compact** — compact the session context

## Architecture

```
┌─────────────────────────────── VS Code ───────────────────────────────┐
│  Extension host (dist/extension.js)          Webview (media/*)        │
│  ┌─────────────────────────┐   postMessage   ┌──────────────────────┐ │
│  │ extension.ts            │  ◄────────────► │ chat.html            │ │
│  │  status bar, retry,     │   (typed msg    │  └ chat.bundle.js    │ │
│  │  commands, config watch │    protocol)    │     (ESM bundle of   │ │
│  │ chatViewProvider.ts     │                 │      media/js/*)     │ │
│  │  message routing, SSE   │                 │  chat.css            │ │
│  │  dispatch, prompt flow  │                 │   (--vscode-* tokens)│ │
│  └──────────┬──────────────┘                 └──────────────────────┘ │
│             │ @opencode-ai/sdk (HTTP)                                 │
└─────────────┼─────────────────────────────────────────────────────────┘
              ▼
   Local OpenCode server (opencode serve, http://127.0.0.1:4096)
```

Key points:

- **Transport** — the extension is an HTTP client of a running OpenCode server; it never spawns the CLI. Connect is a health-check poll with exponential backoff; a 15s timer retries after disconnects.
- **Streaming** — `session.prompt()` returns the initial message, and incremental text arrives as SSE `message.part.updated` deltas over a single shared `/event` stream. When the session goes idle, an authoritative history reload replaces the accumulated deltas.
- **Events bus** — one SSE loop (`events.ts`) with abort-aware resubscribe; three consecutive failures mark the connection disconnected.
- **Catalog** — the server's commands, agents, providers, and models are fetched once and cached in the provider; per-session agent/model selection is seeded from `session.get` and carried on every prompt/command.
- **No local persistence** — history lives server-side; only the active session ID is stored in VS Code workspace state.

## Development

### Setup

```bash
npm install
```

### Build & check

| Command | Purpose |
| --- | --- |
| `npm run build` | esbuild: host bundle `src/extension.ts` → `dist/extension.js` (CJS) + webview bundle `media/js/app.js` → `media/chat.bundle.js` (ESM) |
| `npm run watch` | Rebuild both bundles on change |
| `npm run compile` | Type-check the extension host with `tsc -p ./` |
| `npm run check:webview` | Type-check the webview JS with `tsc -p ./tsconfig.webview.json` (allowJs/checkJs) |
| `npm run package` | Build + `vsce package` |

### Running the extension

1. `npm run watch` (or `npm run build`)
2. Open the repo in VS Code and press **F5** (see `.vscode/launch.json`)
3. Make sure an OpenCode server is running, then open the **OpenCode** panel.

### Webview constraints

- The webview has a **strict CSP** (`default-src 'none'`; script nonce-gated; styles/fonts/images only from `cspSource`, plus `data:`/`file:`/the server URL for images). Never add external CDN resources.
- Webview source is plain JS with `checkJs` type checking (`tsconfig.webview.json`), not TypeScript.
- `media/chat.js` is a **legacy build and dead code** — it is excluded from the package and unreferenced; the active bundle is `media/chat.bundle.js`.

## Packaging

`.vscodeignore` excludes `node_modules/`, `out/`, `src/`, `media/js/`, `media/chat.js`, and sourcemaps. The VSIX ships `dist/extension.js` (with the SDK bundled in; only `vscode` is external) plus the webview assets.

## License

MIT
