# OpenCode Chat

Chat with [OpenCode](https://opencode.ai) — your AI coding agent — right inside VS Code, plus inline code completion and AI-generated commit messages. No terminal switching, no context loss: the full OpenCode experience lives in a sidebar panel.

## Features

- **Chat panel in the secondary sidebar** — full conversation UI with session list, history, and live streaming responses backed by your local OpenCode server
- **Streaming with thinking** — responses stream in as they're generated; the reasoning block is collapsible, and a toggle in the composer shows or hides it (preference is remembered)
- **Session management** — create, switch, refresh, and delete sessions; the active session is restored when you reload the window
- **Agent & model pickers** — choose per session, grouped by provider; selections follow every prompt and command
- **Slash commands** — composer popup with the server's command catalog (e.g. `/undo`, `/compact`) plus native controls: **Undo, Redo, Diff, Fork, Share, Abort**
- **@-mentions** — mention agents or workspace files (files are read by the server via `file://` URLs)
- **Permission & question cards** — "Allow / Always allow / Deny" prompts and question dialogs render inline in the chat; stale questions are auto-rejected
- **Subagents** — browse a session's subagent threads with a toggle
- **Workspace filtering** — session list shows only sessions from your current workspace (toggleable)
- **Inline code completion (ghost text)** — Tab-accept suggestions in the editor, powered by your model provider of choice
- **AI commit messages** — one click generates a Conventional Commit message from your staged (or unstaged) changes
- **Automatic server startup** — if the OpenCode server isn't running, the extension starts `opencode serve` for you (loopback URLs only)
- **Connection status in the status bar** — shows connected/disconnected, click to open the server URL
- **Theme-native UI** — uses only VS Code design tokens; looks right in light and dark themes

## Requirements

- **VS Code 1.106 or newer**
- **OpenCode** installed and on your `PATH` — the extension connects to a local server (`opencode serve`, default `http://127.0.0.1:4096`). If the server isn't running, the extension starts it automatically (loopback URLs only; disable with `opencodeChat.autoStartServer`).
- For **inline completion**: a provider key or local model — see [Inline completion](#inline-completion).

## Installation

The extension is not published to a marketplace; install from a GitHub release or from source.

### From GitHub Releases

1. Go to <https://github.com/MacroSacramento/vscode-opencode-chat/releases> and download the `.vsix` file from the latest release.
2. In VS Code, open **Extensions** (`Cmd+Shift+X`), click the `...` menu, and choose **Install from VSIX...**. Select the downloaded `.vsix` file.

### From source

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Build and package:
   ```bash
   npm run package
   ```
3. Install the resulting `opencode-chat-<version>.vsix` (same **Install from VSIX...** flow as above), or press **F5** in the repo for a development host.

## Getting Started

1. Install the extension and reload VS Code.
2. If you haven't already, sign in with OpenCode in your terminal (`opencode auth login`) so the server has credentials for your providers.
3. Open the **OpenCode** panel from the secondary sidebar (or the activity bar). The status bar shows `OpenCode: connected` once the server is reachable — the extension starts it automatically if needed.
4. Type a message in the composer and send. That's it.

> First-time users: if the panel shows a welcome/empty state, check the status bar text — `OpenCode: disconnected` means the server couldn't be reached (see [Troubleshooting](#troubleshooting)).

## Usage

### Chat

- Type in the composer and press **Enter** to send; **Shift+Enter** for a newline.
- The **stop** button (composer) interrupts the current response.
- The **thinking** toggle shows/hides the live reasoning block while the model works.
- `/` opens the slash-command popup (server commands + native controls). `@` mentions agents and workspace files.

### Sessions

- The session list shows all sessions, filtered to the current workspace by default (toggle with `opencodeChat.workspaceFilter`).
- New session, delete, and refresh live in the panel title bar and composer.
- Use the subagents toggle to browse a session's subagent threads.

### Agents & models

- Pick an agent or model per session from the composer badges — grouped by provider, synced from the server.
- Mention a specific agent per-prompt with `@agent` (doesn't change your saved selection).

### Permissions & questions

- When the server asks for permission (tool use, file edits), an inline card appears: **Allow**, **Always allow**, or **Deny**.
- Question prompts render as radio/checkbox options, with a free-text field when the server allows custom input.
- Stale questions (a new prompt sent before answering) are auto-rejected.

### Native commands

Available from the composer's command popup and slash shortcuts:

| Command | What it does |
| --- | --- |
| `/undo` | Revert the session to before the last assistant message |
| `/redo` | Re-apply the undone turn |
| `/diff` | Show the last change as formatted text |
| `/fork` | Fork the session into a new one |
| `/share` | Share the session |
| `/abort` | Stop the current turn |
| `/compact` | Compact the session context |

### Inline completion

Ghost text in your editor, powered by your model provider — the extension calls providers **directly**, independent of the chat server.

1. Enable it: setting `opencodeChat.completion.enabled` → `true`.
2. Make sure a provider is configured — run **OpenCode: Configure Completion** and pick a provider, or read on for what's available automatically.
3. Type in any editor. Suggestions appear after a short delay; press **Tab** to accept.

**Providers** — the extension can use any provider authenticated with OpenCode (read from opencode's `auth.json`), plus OpenCode Zen/Go:

| Provider | How it's selected |
| --- | --- |
| **OpenCode Zen / Go** | Default. Uses your Zen/Go API key — set `opencodeChat.completion.apiKey`, or picked up automatically from opencode's `auth.json` if you signed in with Zen/Go |
| **Any provider in `auth.json`** | Anthropic, DeepSeek, OpenAI, Google, Groq, OpenRouter, xAI, Mistral, Ollama — used automatically in `auto` mode (Zen/Go preferred, then this list) |
| **Custom** | OpenAI-compatible endpoint via `opencodeChat.completion.customBaseUrl` |

- **Change the model anytime**: run **OpenCode: Configure Completion** (provider + model quick-pick) or set `opencodeChat.completion.model`.
- `auto` mode picks: Zen/Go if a key is configured, otherwise the first authenticated provider from `auth.json`.
- Free-tier Zen accounts: if a paid model returns a 402/403, the extension automatically retries with `deepseek-v4-flash-free`.
- Suggestions are **streamed after ~0.5–3s** — chat models doing fill-in-the-middle, not a native FIM endpoint (OpenCode doesn't expose one yet). Good for Tab-accept style completion; occasionally the model wraps output in fences or prose, which the extension strips when possible.

### Commit messages

One click generates a Conventional Commit message from your changes:

- **SCM view**: the OpenCode logo button in the Source Control view title bar.
- **Command palette**: **OpenCode: Generate Commit Message**.

Behavior:

- Uses **staged** changes if any exist, otherwise **unstaged**; if there's nothing to describe, it says so.
- The message lands in the **commit input box** ready to review — nothing is committed for you.
- No matching git repo (e.g. SVN workspaces)? The message is copied to the clipboard instead.
- Uses the same provider and model as inline completion.

## Commands

| Command | Description |
| --- | --- |
| `OpenCode: New Chat` | Focus the chat view and start a new session |
| `OpenCode: Open Server URL` | Open the server URL in your browser |
| `OpenCode: Refresh Sessions` | Focus the chat view and refresh the session list |
| `OpenCode: Configure Completion` | Pick the completion provider and model (also in Settings) |
| `OpenCode: Generate Commit Message` | Generate a commit message from your changes (also in the SCM view title bar) |
| `OpenCode: Insert Editor Context` | Insert the active editor's text (selection, or the whole document if none) into the chat composer at the caret — default keybind `cmd+k cmd+i` (mac) / `ctrl+k ctrl+i` (other) |

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `opencodeChat.serverUrl` | `string` | `http://127.0.0.1:4096` | Base URL of the OpenCode server. Changing it reconnects automatically. |
| `opencodeChat.autoStartServer` | `boolean` | `true` | Start `opencode serve` automatically when the server is unreachable (loopback URLs only). |
| `opencodeChat.workspaceFilter` | `boolean` | `true` | Only show sessions from the current workspace directory. |
| `opencodeChat.completion.enabled` | `boolean` | `false` | Enable inline code completion (ghost text). |
| `opencodeChat.completion.provider` | `string` | `auto` | `auto` (OpenCode Zen/Go if a key is available, else the first provider authenticated with opencode), `opencode-zen`, `opencode-go`, or any provider id from `auth.json`: `anthropic`, `deepseek`, `openai`, `google`, `groq`, `openrouter`, `xai`, `mistral`, `ollama`, `custom` (requires `completion.customBaseUrl`). |
| `opencodeChat.completion.model` | `string` | `""` | Model for completions. Empty = provider default. |
| `opencodeChat.completion.apiKey` | `string` | `""` | API key for OpenCode Zen/Go. Leave empty to read keys from opencode's `auth.json`. *Note: keys in settings.json are included in Settings Sync; prefer SecretStorage or `auth.json`.* |
| `opencodeChat.completion.baseUrl` | `string` | `""` | Override base URL for the Zen/Go endpoint (advanced). |
| `opencodeChat.completion.customBaseUrl` | `string` | `""` | Base URL for the `custom` OpenAI-compatible provider. |
| `opencodeChat.completion.maxTokens` | `number` | `128` | Max tokens per completion. |
| `opencodeChat.completion.timeout` | `number` | `3000` | Completion request timeout in ms. |

## Troubleshooting

**Status bar says `OpenCode: disconnected`**
The extension couldn't reach the server. Check `opencode serve` is running (or `opencodeChat.autoStartServer` is enabled and `opencode` is on your `PATH`), and that `opencodeChat.serverUrl` points at the right port. The extension retries every 15s.

**No ghost text appears**
- `opencodeChat.completion.enabled` must be `true`.
- A provider must be resolvable: run **OpenCode: Configure Completion** — it lists what's available. If nothing is listed, sign in with OpenCode (`opencode auth login`) or set `opencodeChat.completion.apiKey`.
- Check the **OpenCode Completion** output channel for silent failures (timeouts, 401/402s, provider errors).

**Completions are slow (~seconds)**
Expected — chat models generating fill-in-the-middle, thinking disabled. Fastest options: `deepseek-v4-flash` (Zen/Go), a local Ollama model (e.g. `qwen3-coder:1.7b`), or reduce `completion.maxTokens`.

**"No completion provider configured" when generating a commit message**
Run **OpenCode: Configure Completion** first — commit messages use the same provider setup.

**"Commit message copied to clipboard (no git repository matched)"**
The extension couldn't find a git repo for your workspace (or the built-in Git extension is disabled). Message is in your clipboard — paste and review.

**Ghost text inserts code fences or prose**
Chat models doing FIM sometimes wrap output despite instructions. The extension strips fences and prompt echoes when it detects them; the occasional slip is a known limitation until OpenCode ships a native FIM endpoint.

## License

MIT
