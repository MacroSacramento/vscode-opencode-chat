import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { log as logCompletion, queryModel, resolveBackendConfig } from './completionProvider';

/**
 * User-initiated "Generate Commit Message" command: reads the git diff of the
 * target workspace folder (staged first, then unstaged), asks the SAME model
 * provider as inline completion for a conventional commit message, and puts
 * the result into the matching git repository's commit input box (clipboard
 * fallback when no repository matches). Errors are toasted (unlike ghost text)
 * and always logged to the "OpenCode Completion" output channel.
 */

const MAX_DIFF_CHARS = 30_000;

const COMMIT_INSTRUCTION =
  'You are a git commit message assistant. Write a conventional commit message for the provided diff. Rules: subject line max 72 chars, conventional prefix (feat:|fix:|docs:|chore:|refactor:|test:|style:|perf:), no scope unless clearly inferable, no trailing period, imperative mood; add a short body with bullet points only when the change is non-trivial (multiple concerns); never include diff content, file paths lists, or code in the message; output ONLY the message, no markdown fences, no preamble.';

/** Runs git with the given args in `cwd`. No shell involved — args are passed verbatim. */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        if (error.code === 'ENOENT') {
          reject(new Error('git executable not found'));
        } else {
          const detail = (stderr || error.message).trim();
          reject(new Error(detail !== '' ? detail.slice(0, 200) : `git exited with code ${String(error.code ?? 'unknown')}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

/** Folder of the active editor if inside a workspace folder, else the first folder. */
function getTargetFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor;
  if (active !== undefined) {
    const folder = vscode.workspace.getWorkspaceFolder(active.document.uri);
    if (folder !== undefined) {
      return folder;
    }
  }
  return folders[0];
}

/**
 * Minimal shape of the built-in Git extension API. `vscode.git` is not typed
 * in @types/vscode (and `vscode.scm.inputBox` is deprecated — it only returns
 * a box for source controls created BY THIS extension, so it is always
 * undefined here). We only need the per-repository commit input box.
 */
interface GitExtensionApi {
  getAPI(version: 1): {
    repositories: Array<{
      rootUri: vscode.Uri;
      inputBox: { value: string };
    }>;
  };
}

/**
 * Writes the message into the commit input box of the git repository matching
 * `folderUri`, via the vscode.git extension API. Returns true on success;
 * false when the git extension is unavailable or no repository matches
 * (e.g. SVN or untitled) — callers fall back to the clipboard.
 */
async function writeCommitMessage(message: string, folderUri: vscode.Uri): Promise<boolean> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt === undefined) {
    return false;
  }
  const gitApi = gitExt.isActive
    ? (gitExt.exports as unknown as GitExtensionApi)
    : ((await gitExt.activate()) as unknown as GitExtensionApi);
  const api = gitApi.getAPI?.(1);
  const repo = api?.repositories?.find((r) => r.rootUri.toString() === folderUri.toString());
  if (repo === undefined) {
    return false;
  }
  repo.inputBox.value = message;
  return true;
}

/** Friendly toast for a git failure; ENOENT gets its own message. */
function gitErrorToast(err: unknown): string {
  return err instanceof Error && err.message === 'git executable not found'
    ? 'Git executable not found'
    : 'Could not read git diff';
}

/** Guards against duplicate parallel generations (last-write-wins on the SCM input box). */
let generationInFlight = false;

async function generateCommitMessage(): Promise<void> {
  if (generationInFlight) {
    void vscode.window.showInformationMessage('Already generating a commit message…');
    return;
  }
  generationInFlight = true;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Generating commit message…' },
      () => runGeneration()
    );
  } finally {
    generationInFlight = false;
  }
}

async function runGeneration(): Promise<void> {
  try {
    const folder = getTargetFolder();
    if (folder === undefined) {
      void vscode.window.showErrorMessage('No workspace folder');
      return;
    }
    // Distinguish "nothing configured" (likely first-run) from a failed request.
    if (resolveBackendConfig() === null) {
      logCompletion('commit message: no completion provider configured');
      void vscode.window.showErrorMessage('No completion provider configured — run "OpenCode: Configure Completion" first');
      return;
    }
    const cwd = folder.uri.fsPath;

    let diff: string;
    try {
      diff = await runGit(cwd, ['diff', '--cached']);
    } catch (err) {
      logCompletion(`commit message: git diff --cached failed: ${err instanceof Error ? err.message : String(err)}`);
      void vscode.window.showErrorMessage(gitErrorToast(err));
      return;
    }
    if (diff.trim() === '') {
      try {
        diff = await runGit(cwd, ['diff']);
      } catch (err) {
        logCompletion(`commit message: git diff failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage(gitErrorToast(err));
        return;
      }
    }
    if (diff.trim() === '') {
      void vscode.window.showInformationMessage('No changes to describe');
      return;
    }

    const truncated = diff.length > MAX_DIFF_CHARS;
    const modelInput = truncated ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n(diff truncated)' : diff;

    const message = await queryModel(COMMIT_INSTRUCTION, modelInput, new AbortController().signal);
    if (message === null) {
      logCompletion('commit message generation returned no result');
      void vscode.window.showErrorMessage('Could not generate commit message');
      return;
    }

    if (await writeCommitMessage(message, folder.uri)) {
      void vscode.window.showInformationMessage('Commit message generated');
    } else {
      await vscode.env.clipboard.writeText(message);
      void vscode.window.showInformationMessage('Commit message copied to clipboard (no git repository matched)');
    }
  } catch (err) {
    logCompletion(`commit message generation failed: ${err instanceof Error ? err.message : String(err)}`);
    void vscode.window.showErrorMessage('Could not generate commit message');
  }
}

/**
 * Registers the "Generate Commit Message" command. Called from activate().
 */
export function registerCommitMessage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeChat.generateCommitMessage', () => {
      void generateCommitMessage();
    })
  );
}
