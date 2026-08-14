import { spawn } from 'child_process';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Detached `opencode serve` spawn. Only fires when the configured server URL is
 * a loopback address (http/https). The child keeps running after VS Code closes.
 *
 * EADDRINUSE can't be observed with stdio: 'ignore' (stderr is discarded);
 * that's harmless — the caller's retry timer reconnects to the already-running
 * server.
 */
export function launchServer(serverUrl: string, log: (message: string) => void): void {
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

		const child = spawn('opencode', args, { detached: true, stdio: 'ignore' });
		child.unref();

		child.on('error', (err) => {
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
			log(`opencode serve exited (code ${code ?? 'unknown'})`);
		});
	} catch (err) {
		log(`failed to parse server URL for auto-start: ${err instanceof Error ? err.message : String(err)}`);
	}
}
