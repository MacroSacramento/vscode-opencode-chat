import { spawn, type ChildProcess } from 'child_process';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The auto-started server for this window, if any. */
let serverProcess: ChildProcess | undefined;

/**
 * Detached `opencode serve` spawn. Only fires when the configured server URL is
 * a loopback address (http/https). The child is tracked so it can be stopped
 * when the window closes (`stopServer`); `detached` puts it in its own process
 * group so the whole server tree can be killed together.
 *
 * EADDRINUSE can't be observed with stdio: 'ignore' (stderr is discarded);
 * that's harmless — the caller's retry timer reconnects to the already-running
 * server.
 */
export function launchServer(serverUrl: string, log: (message: string) => void, cwd?: string): void {
	try {
		const url = new URL(serverUrl);

		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			log('skip auto-start: non-http(s) server URL');
			return;
		}

		// Node returns '[::1]' (brackets included) for IPv6 hostnames; strip
		// them before comparing and before passing as a CLI arg.
		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		if (!LOOPBACK_HOSTS.has(hostname)) {
			log('skip auto-start: non-loopback server URL');
			return;
		}

		const port = url.port || '4096';
		const args = ['serve', '--port', port];
		// '--hostname' defaults to 127.0.0.1; only pass it when different.
		if (hostname !== '127.0.0.1') {
			args.push('--hostname', hostname);
		}

		const child = spawn('opencode', args, { detached: true, stdio: 'ignore', cwd });
		serverProcess = child;
		child.unref();

		child.on('error', (err) => {
			if (serverProcess === child) {
				serverProcess = undefined;
			}
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				log('opencode binary not found — install opencode or start the server manually');
			} else {
				log(`failed to start opencode serve: ${err.message}`);
			}
		});

		child.on('spawn', () => {
			log(`Auto-started opencode serve (pid ${child.pid})`);
		});

		child.on('exit', (code) => {
			if (serverProcess === child) {
				serverProcess = undefined;
			}
			log(`opencode serve exited (code ${code ?? 'unknown'})`);
		});
	} catch (err) {
		log(`failed to parse server URL for auto-start: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Stops the auto-started server for this window (SIGTERM to its process group,
 * so worker children die too). No-op when this window didn't spawn a server.
 */
export function stopServer(): void {
	const child = serverProcess;
	if (child === undefined || child.pid === undefined) {
		return;
	}
	serverProcess = undefined;
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		// Process already gone.
	}
}
