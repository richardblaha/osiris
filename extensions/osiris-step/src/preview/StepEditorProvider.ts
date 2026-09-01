import * as vscode from 'vscode';
import { isErr } from '@osiris/shared-core';
import { parseStep } from '../parser/stepParser.js';
import { extractGeometry } from '../geometry/extract.js';
import { computeStats } from '../stats.js';

/** Read-only custom editor that renders a STEP file as a 3D wireframe. */
export class StepEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'osiris-step.preview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      StepEditorProvider.viewType,
      new StepEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewPanel.webview.html = this.html(webviewPanel.webview);

    const bytes = await vscode.workspace.fs.readFile(document.uri);
    const source = Buffer.from(bytes).toString('utf8');
    const parsed = parseStep(source);

    webviewPanel.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type !== 'ready') {
        return;
      }
      if (isErr(parsed)) {
        void webviewPanel.webview.postMessage({ type: 'error', message: parsed.error.message });
        return;
      }
      const maxEntities = vscode.workspace
        .getConfiguration('osiris-step')
        .get<number>('maxPreviewEntities', 200000);
      const stats = computeStats(parsed.value);
      const geometry =
        stats.entityCount <= maxEntities
          ? extractGeometry(parsed.value)
          : {
              points: [],
              lineSegments: [],
              bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
            };
      void webviewPanel.webview.postMessage({
        type: 'model',
        header: parsed.value.header,
        stats,
        geometry,
        skipped: stats.entityCount > maxEntities,
      });
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'preview.js'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>STEP 3D Preview</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    #canvas { position: absolute; inset: 0; display: block; }
    #hud { position: absolute; left: 8px; top: 8px; font-size: 12px; white-space: pre;
           background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent); padding: 6px 8px; border-radius: 4px; }
    #err { position: absolute; inset: 0; display: grid; place-items: center; color: var(--vscode-editorError-foreground); }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <div id="hud">loading…</div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
