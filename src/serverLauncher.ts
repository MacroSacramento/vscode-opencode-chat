import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** The auto-started server for this window, if any. */
let serverProcess: ChildProcess | undefined;

// --- opencode binary resolution -------------------------------------------------

const BINARY_CACHE_TTL_MS = 30_000;
let cachedBinary: string | undefined;
let cachedBinaryAt = 0;

/**
 * Locates the `opencode` executable across platforms:
 * 1. PATH lookup (`which` / `where`). On Windows `where` also resolves the
 *    `.cmd` shims npm installs, which `spawn()` alone cannot run.
 * 2. macOS: the extension host often inherits a minimal PATH from Finder, so
 *    ask a login shell (sources the user's profile) for the real PATH.
 * 3. Common install locations: `~/.opencode/bin`, `~/.local/bin`, npm global bin.
 *
 * Results are cached (positive results forever, misses for 30s) so the retry
 * timer doesn't hammer login shells.
 */
export async function findOpenCodeBinary(): Promise<string | undefined> {
	const now = Date.now();
	if (cachedBinary !== undefined || now - cachedBinaryAt < BINARY_CACHE_TTL_MS) {
		return cachedBinary;
	}
	cachedBinary = await resolveOpenCodeBinary();
	cachedBinaryAt = now;
	return cachedBinary;
}

async function resolveOpenCodeBinary(): Promise<string | undefined> {
	const fromPath = await which('opencode');
	if (fromPath !== undefined) {
		return fromPath;
	}

	// macOS: VS Code launched from Finder gets a minimal PATH; a login shell
	// sources the user's profile and reveals the real PATH. Linux desktop
	// launchers can be similarly limited, so try bash there too.
	const loginShells = process.platform === 'darwin' ? ['zsh', 'bash'] : process.platform === 'linux' ? ['bash'] : [];
	for (const shell of loginShells) {
		const viaShell = await whichViaLoginShell(shell);
		if (viaShell !== undefined) {
			return viaShell;
		}
	}

	for (const candidate of commonLocations()) {
		if (await isExecutable(candidate)) {
			return candidate;
		}
	}

	return npmGlobalBin();
}

async function which(name: string): Promise<string | undefined> {
	const isWin = process.platform === 'win32';
	const cmd = isWin ? 'where' : 'which';
	try {
		const { stdout } = await execFileAsync(cmd, [name], { timeout: 5000, windowsHide: true });
		const lines = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (isWin) {
			// Prefer a runnable extension over npm's extension-less sh script.
			return lines.find((line) => /\.(exe|cmd|bat)$/i.test(line)) ?? lines[0];
		}
		return lines[0];
	} catch {
		return undefined;
	}
}

async function whichViaLoginShell(shell: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(shell, ['-l', '-c', 'command -v opencode'], { timeout: 5000, windowsHide: true });
		const line = stdout.trim();
		return line.length > 0 ? line : undefined;
	} catch {
		return undefined;
	}
}

function commonLocations(): string[] {
	const home = os.homedir();
	const isWin = process.platform === 'win32';
	const exe = isWin ? '.exe' : '';
	const candidates = [
		path.join(home, '.opencode', 'bin', `opencode${exe}`),
		path.join(home, '.local', 'bin', `opencode${exe}`),
	];
	if (isWin) {
		// npm global shims live directly in the npm prefix dir on Windows.
		candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'));
		candidates.push(path.join(home, 'AppData', 'Roaming', 'npm', `opencode${exe}`));
	}
	return candidates;
}

async function npmGlobalBin(): Promise<string | undefined> {
	try {
		const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
		const { stdout } = await execFileAsync(npmCmd, ['prefix', '-g'], { timeout: 5000, windowsHide: true });
		const prefix = stdout.trim();
		if (prefix.length === 0) {
			return undefined;
		}
		const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
		const exe = process.platform === 'win32' ? '.exe' : '';
		const candidates = [path.join(binDir, `opencode${exe}`)];
		if (process.platform === 'win32') {
			candidates.push(path.join(binDir, 'opencode.cmd'));
		}
		for (const candidate of candidates) {
			if (await isExecutable(candidate)) {
				return candidate;
			}
		}
	} catch {
		// npm not available — fall through.
	}
	return undefined;
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await fs.promises.access(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

// --- server launch --------------------------------------------------------------

export interface LaunchResult {
	ok: boolean;
	reason?: 'binary-not-found' | 'error';
}

/**
 * Detached `opencode serve` spawn. Only fires when the configured server URL is
 * a loopback address (http/https). The child is tracked so it can be stopped
 * when the window closes (`stopServer`); `detached` puts it in its own process
 * group so the whole server tree can be killed together.
 *
 * The binary is resolved first (`findOpenCodeBinary`) so a missing install is
 * reported as `binary-not-found` instead of an ENOENT spawn error. EADDRINUSE
 * can't be observed with stdio: 'ignore' (stderr is discarded); that's harmless
 * — the caller's retry timer reconnects to the already-running server.
 */
export async function launchServer(serverUrl: string, log: (message: string) => void, cwd?: string): Promise<LaunchResult> {
	try {
		const url = new URL(serverUrl);

		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			log('skip auto-start: non-http(s) server URL');
			return { ok: false, reason: 'error' };
		}

		// Node returns '[::1]' (brackets included) for IPv6 hostnames; strip
		// them before comparing and before passing as a CLI arg.
		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		if (!LOOPBACK_HOSTS.has(hostname)) {
			log('skip auto-start: non-loopback server URL');
			return { ok: false, reason: 'error' };
		}

		const binary = await findOpenCodeBinary();
		if (binary === undefined) {
			log('opencode binary not found — install opencode or start the server manually');
			return { ok: false, reason: 'binary-not-found' };
		}

		const port = url.port || '4096';
		const args = ['serve', '--port', port];
		// '--hostname' defaults to 127.0.0.1; only pass it when different.
		if (hostname !== '127.0.0.1') {
			args.push('--hostname', hostname);
		}

		// npm installs `opencode.cmd` shims on Windows; `spawn()` can't run
		// those directly, so route them through cmd.exe. `windowsHide` keeps
		// the detached server (and its cmd.exe wrapper) from opening a console
		// window on Windows.
		const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
		const child = spawn(binary, args, { detached: true, stdio: 'ignore', cwd, shell: needsShell, windowsHide: true });
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

		return { ok: true };
	} catch (err) {
		log(`failed to parse server URL for auto-start: ${err instanceof Error ? err.message : String(err)}`);
		return { ok: false, reason: 'error' };
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