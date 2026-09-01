import * as vscode from 'vscode';
import { isErr } from '@osiris/shared-core';
import { parseDexpi } from '../parser/dexpiParser.js';
import { summarize, validateDexpi } from '../parser/schemaValidator.js';
import { renderDexpiSvg } from './renderSvg.js';

interface WebviewInbound {
  type: 'ready' | 'select';
  id?: string;
}

/** Custom text editor that renders a DEXPI P&ID as an interactive SVG. */
export class DexpiEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'osiris-dexpi.preview';

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DexpiEditorProvider.viewType,
      new DexpiEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    );
  }

  resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    webviewPanel.webview.html = this.html(webviewPanel.webview);

    const update = (): void => {
      const parsed = parseDexpi(document.getText());
      if (isErr(parsed)) {
        void webviewPanel.webview.postMessage({
          type: 'error',
          message: parsed.error.message,
        });
        return;
      }
      const issues = validateDexpi(parsed.value);
      void webviewPanel.webview.postMessage({
        type: 'model',
        svg: renderDexpiSvg(parsed.value),
        issues,
        summary: summarize(issues),
        stats: {
          equipment: parsed.value.equipment.length,
          segments: parsed.value.segments.length,
        },
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        update();
      }
    });

    const messageSub = webviewPanel.webview.onDidReceiveMessage((msg: WebviewInbound) => {
      if (msg.type === 'ready') {
        update();
      } else if (msg.type === 'select' && msg.id) {
        this.revealId(document, msg.id);
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });
  }

  private revealId(document: vscode.TextDocument, id: string): void {
    const idx = document.getText().indexOf(`"${id}"`);
    if (idx < 0) {
      return;
    }
    const pos = document.positionAt(idx);
    void vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(pos, pos),
      preserveFocus: true,
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DEXPI P&amp;ID Preview</title>
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
    #toolbar { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
    #stage { position: absolute; inset: 34px 0 0 0; overflow: auto; }
    #stage svg { display: block; margin: 0 auto; }
    .issue { cursor: pointer; padding: 2px 8px; font-size: 12px; }
    .issue.error { color: var(--vscode-editorError-foreground); }
    .issue.warning { color: var(--vscode-editorWarning-foreground); }
    #issues { position: absolute; right: 0; top: 34px; bottom: 0; width: 320px;
              overflow: auto; border-left: 1px solid var(--vscode-panel-border);
              background: var(--vscode-editor-background); }
  </style>
</head>
<body>
  <div id="toolbar">Osiris DEXPI — <span id="summary">parsing…</span></div>
  <div id="stage">loading…</div>
  <div id="issues"></div>
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
