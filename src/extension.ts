import * as vscode from 'vscode';
import { connect, disposeOpenCode, getServerUrl, initOpenCode, isConnected } from './opencodeClient';
import { stopEventStream } from './events';
import { registerChatViewProvider } from './chatViewProvider';
import { launchServer } from './serverLauncher';
import { registerCompletion } from './completionProvider';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:4096';
const CONNECT_RETRY_MS = 15000;

/** Server URL we already attempted to auto-start, so each URL spawns once per session. */
let spawnAttemptedForUrl: string | undefined;

function getConfiguredServerUrl(): string {
	return vscode.workspace.getConfiguration('opencodeChat').get<string>('serverUrl') ?? DEFAULT_SERVER_URL;
}

function shouldAutoStart(): boolean {
	return vscode.workspace.getConfiguration('opencodeChat').get<boolean>('autoStartServer') ?? true;
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('OpenCode Chat');
	const log = (message: string): void => {
		outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
	};

	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.command = 'opencodeChat.openServer';
	statusBarItem.tooltip = 'OpenCode server status — click to open the server URL';
	statusBarItem.text = '$(hubot) OpenCode: disconnected';
	statusBarItem.show();

	const onStateChange = (connected: boolean): void => {
		statusBarItem.text = connected ? '$(hubot) OpenCode: connected' : '$(hubot) OpenCode: disconnected';
		log(connected ? 'Connected to OpenCode server' : 'Disconnected from OpenCode server');
	};

	const init = (): void => {
		initOpenCode({ serverUrl: getConfiguredServerUrl(), onStateChange, log });
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
			if (!isConnected() && shouldAutoStart() && spawnAttemptedForUrl !== getServerUrl()) {
				spawnAttemptedForUrl = getServerUrl();
				launchServer(getServerUrl(), log);
				await new Promise((resolve) => setTimeout(resolve, 2000));
				if (!isConnected()) {
					await connect();
				}
			}
		} catch (err) {
			log(`Connection attempt failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const retryTimer = setInterval(() => {
		if (!isConnected()) {
			void connectAndClear();
		}
	}, CONNECT_RETRY_MS);

	void connectAndClear();

	const chatViewProvider = registerChatViewProvider(context, log);

	// Inline completion (ghost text) — bypasses the OpenCode server entirely.
	registerCompletion(context);

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
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('opencodeChat.serverUrl')) {
				log('Server URL configuration changed — reconnecting');
				spawnAttemptedForUrl = undefined;
				stopEventStream();
				disposeOpenCode();
				init();
				void connect();
			}
		})
	);
}

export function deactivate(): void {
	disposeOpenCode();
	stopEventStream();
}
