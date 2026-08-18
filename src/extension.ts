import * as vscode from 'vscode';
import { connect, disposeOpenCode, getClient, getServerUrl, initOpenCode, isConnected } from './opencodeClient';
import { stopEventStream } from './events';
import { registerChatViewProvider } from './chatViewProvider';
import { findOpenCodeBinary, launchServer, stopServer } from './serverLauncher';
import { registerCompletion } from './completionProvider';
import { registerCommitMessage } from './commitMessage';
import { resolveServerUrl } from './serverUrl';

const CONNECT_RETRY_MS = 15000;

/** Server URL we already attempted to auto-start, so each URL spawns once per session. */
let spawnAttemptedForUrl: string | undefined;

/** Set once the opencode binary can't be found, so we stop re-spawning. */
let binaryMissing = false;
let binaryMissingWarned = false;

function shouldAutoStart(): boolean {
	return vscode.workspace.getConfiguration('opencodeChat').get<boolean>('autoStartServer') ?? true;
}

/**
 * Warns when the connected server is rooted at a different directory than the
 * open workspace folder — a sign the derived port is occupied by a server for
 * another project (or a foreign process). Non-fatal: the connection itself is
 * healthy, but sessions will be filtered to the wrong project.
 */
async function verifyServerDirectory(log: (message: string) => void): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) {
		return;
	}
	try {
		const res = await getClient().path.get();
		const serverDir = res.data?.directory;
		const normalize = (p: string): string => {
			const trimmed = p.replace(/\\/g, '/').replace(/\/+$/, '');
			return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
		};
		if (serverDir !== undefined && normalize(serverDir) !== normalize(folder.uri.fsPath)) {
			log(`Warning: server at ${getServerUrl()} is rooted at ${serverDir}, not ${folder.uri.fsPath}. The port may be shared with another project's server.`);
		}
	} catch {
		// Non-fatal — the health check already passed.
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('OpenCode Chat');
	const log = (message: string): void => {
		outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	};

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.command = 'opencodeChat.openServer';
	statusBarItem.tooltip = 'OpenCode server status — click to open the server URL';
	statusBarItem.text = 'OpenCode: disconnected';
	statusBarItem.show();

	// Set once the chat view provider is registered (created below), so the
	// connect transition can push an immediate session/history sync into the
	// webview instead of waiting for a user prompt or the 10s arm timer.
	let notifyProviderConnected: (() => void) | undefined;

	const onStateChange = (connected: boolean): void => {
		statusBarItem.text = connected ? 'OpenCode: connected' : 'OpenCode: disconnected';
		log(connected ? 'Connected to OpenCode server' : 'Disconnected from OpenCode server');
		if (connected) {
			notifyProviderConnected?.();
		}
	};

	const init = (): void => {
		initOpenCode({ serverUrl: resolveServerUrl(), onStateChange, log });
	};

	init();

	// Never cleared once started: connect() is idempotent and guarded against
	// re-entrancy, so this timer both retries initial connection attempts and
	// re-connects after a stream-failure disconnect (markDisconnected).
	const connectAndClear = async (): Promise<void> => {
		try {
			if (!isConnected()) {
				await connect();
			}
			if (isConnected()) {
				await verifyServerDirectory(log);
				// A live server means the binary exists — clear any earlier
				// "binary not found" state so auto-start can resume.
				binaryMissing = false;
				binaryMissingWarned = false;
			}
			if (!isConnected() && shouldAutoStart() && !binaryMissing && spawnAttemptedForUrl !== getServerUrl()) {
				spawnAttemptedForUrl = getServerUrl();
				// Anchor the server to the open workspace folder so sessions are
				// created in the project VS Code has open (the filter in
				// SessionManager relies on session.directory matching it).
				const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const result = await launchServer(getServerUrl(), log, workspaceCwd);
				if (result.ok) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
					if (!isConnected()) {
						await connect();
					}
					if (isConnected()) {
						await verifyServerDirectory(log);
					}
				} else if (result.reason === 'binary-not-found') {
					// Stop re-spawning; surface the problem once instead of
					// retrying forever. Health checks continue so a manually
					// started server (or a later install) still connects.
					binaryMissing = true;
					if (!binaryMissingWarned) {
						binaryMissingWarned = true;
						statusBarItem.text = 'OpenCode: binary not found';
						void vscode.window.showErrorMessage(
							'OpenCode: opencode binary not found. Install opencode or start the server manually.'
						);
					}
				}
			}
		} catch (err) {
			log(`Connection attempt failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const retryTimer = setInterval(() => {
		if (!isConnected()) {
			// The previous auto-start may have exited (e.g. another window
			// closed and killed a shared server) — allow a fresh spawn attempt.
			spawnAttemptedForUrl = undefined;
			void (async () => {
				// Recover if the binary appeared since the last check (e.g. the
				// user installed opencode while the extension was running).
				if (binaryMissing && (await findOpenCodeBinary()) !== undefined) {
					binaryMissing = false;
					binaryMissingWarned = false;
				}
				await connectAndClear();
			})();
		}
	}, CONNECT_RETRY_MS);

	void connectAndClear();

	const chatViewProvider = registerChatViewProvider(context, log);
	notifyProviderConnected = (): void => {
		void chatViewProvider.onConnected();
	};

	// Inline completion (ghost text) — bypasses the OpenCode server entirely.
	registerCompletion(context);

	// User-initiated commit message generation — reuses the completion provider.
	registerCommitMessage(context);

	// Reconnect when the effective server URL changes — either the serverUrl/
	// autoStartServer config or the open workspace folder (the URL is derived
	// from the folder, so switching projects moves this window to its own
	// server).
	const reconnect = (reason: string): void => {
		const nextUrl = resolveServerUrl();
		if (nextUrl === getServerUrl()) {
			return;
		}
		log(`${reason} — reconnecting (${getServerUrl()} -> ${nextUrl})`);
		spawnAttemptedForUrl = undefined;
		binaryMissing = false;
		binaryMissingWarned = false;
		stopEventStream();
		disposeOpenCode();
		// The old URL's server belongs to this window — stop it when moving on.
		stopServer();
		init();
		void connect();
	};

	context.subscriptions.push(
		outputChannel,
		statusBarItem,
		{
			dispose: () => clearInterval(retryTimer),
		},
		vscode.commands.registerCommand('opencodeChat.newSession', () => {
			void vscode.commands.executeCommand('opencode.chat.focus');
		}),
		vscode.commands.registerCommand('opencodeChat.openServer', () => {
			void vscode.env.openExternal(vscode.Uri.parse(getServerUrl()));
		}),
		vscode.commands.registerCommand('opencodeChat.refreshSessions', () => {
			void vscode.commands.executeCommand('opencode.chat.focus');
			void chatViewProvider.refreshSessionsList();
		}),
		vscode.commands.registerCommand('opencodeChat.insertContext', () => {
			const editor = vscode.window.activeTextEditor;
			if (editor === undefined) {
				void vscode.window.showWarningMessage('OpenCode: No active editor to insert context from.');
				return;
			}
			const selection = editor.selection;
			const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
			if (text === '') {
				return;
			}
			chatViewProvider.insertContext(text, vscode.workspace.asRelativePath(editor.document.uri, false));
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('opencodeChat.serverUrl') || event.affectsConfiguration('opencodeChat.autoStartServer')) {
				reconnect('Server configuration changed');
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			reconnect('Workspace folder changed');
		})
	);
}

export function deactivate(): void {
	disposeOpenCode();
	stopEventStream();
	// Close the per-window server with the window.
	stopServer();
}
