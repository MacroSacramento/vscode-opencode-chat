import * as fs from 'node:fs';
import * as vscode from 'vscode';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Escape a string before it is interpolated into the webview shell. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders media/chat.html, substituting CSP, asset URIs and runtime values.
 * The shell carries a strict Content-Security-Policy; the script is the only
 * inline-executable element and is gated by a per-load nonce. `serverUrl` is
 * the OpenCode server origin (e.g. `http://127.0.0.1:4096`) and is allowed as
 * an image source alongside the webview's own cspSource.
 */
export function renderWebviewShell(context: vscode.ExtensionContext, webview: vscode.Webview, serverUrl: string): string {
  const nonce = getNonce();
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.css'));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.bundle.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data: file: ${serverUrl}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const templatePath = vscode.Uri.joinPath(context.extensionUri, 'media', 'chat.html').fsPath;
  let html: string;
  try {
    html = fs.readFileSync(templatePath, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /></head><body><p>Failed to load chat.html: ${escapeHtml(detail)}</p></body></html>`;
  }

  return html
    .split('__CSP__')
    .join(csp)
    .split('__NONCE__')
    .join(nonce)
    .split('__STYLE_URI__')
    .join(styleUri.toString())
    .split('__SCRIPT_URI__')
    .join(scriptUri.toString())
    .split('__SERVER_URL__')
    .join(escapeHtml(serverUrl));
}
