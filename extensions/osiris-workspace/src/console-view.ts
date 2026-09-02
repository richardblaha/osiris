import * as vscode from 'vscode';
import { createLogger } from '@osiris/shared-core';

const log = createLogger('workspace:console-view');

function config() {
  return vscode.workspace.getConfiguration('osiris');
}

function serverBaseUrl(): string {
  return config().get<string>('server.url')?.replace(/\/+$/, '') || 'http://localhost:8080';
}

function serverToken(): string | undefined {
  const key = config().get<string>('server.tokenEnv', 'OSIRIS_SERVER_TOKEN');
  return key ? process.env[key] : undefined;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/**
 * The "Osiris" sidebar view: the Kanban backlog + crew runner, talking to the
 * osiris-server over its typed ConsoleClient (bundled into the webview).
 */
export class OsirisConsoleViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'osiris.console';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const server = serverBaseUrl();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview, server);
    log.info('console view bound to %s', server);
  }

  private html(webview: vscode.Webview, server: string): string {
    const n = nonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'panel.css'),
    );
    // The webview needs to reach the osiris-server directly (localhost or a
    // configured origin) — allow that exact origin plus its ws upgrade.
    const origin = safeOrigin(server);
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${n}'`,
      `connect-src ${origin} ${origin.replace(/^http/, 'ws')}`,
    ].join('; ');
    const bootstrap = JSON.stringify({ serverUrl: server, token: serverToken() });
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${style}" />
  <title>Osiris Console</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}">window.__OSIRIS__ = ${bootstrap};</script>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'http://localhost:8080';
  }
}
