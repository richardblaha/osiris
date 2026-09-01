import * as vscode from 'vscode';
import { createLogger, createTelemetry, isErr } from '@osiris/shared-core';
import { parseDexpi } from './parser/dexpiParser.js';
import { validateDexpi } from './parser/schemaValidator.js';
import { renderDexpiSvg } from './preview/renderSvg.js';
import { DexpiEditorProvider } from './preview/DexpiEditorProvider.js';
import { refreshDiagnostics } from './diagnostics.js';

const log = createLogger('dexpi');

function looksLikeDexpi(document: vscode.TextDocument): boolean {
  if (document.languageId === 'dexpi') {
    return true;
  }
  if (document.languageId !== 'xml') {
    return false;
  }
  const head = document.getText(new vscode.Range(0, 0, 40, 0));
  return /<PlantModel[\s>]/.test(head) || /<Proteus[\s>]/.test(head);
}

export function activate(context: vscode.ExtensionContext): void {
  const telemetry = createTelemetry({ env: process.env });
  const diagnostics = vscode.languages.createDiagnosticCollection('osiris-dexpi');
  context.subscriptions.push(diagnostics, { dispose: () => telemetry.dispose() });

  log.info('activating osiris-dexpi');

  context.subscriptions.push(
    DexpiEditorProvider.register(context),

    vscode.commands.registerCommand('osiris-dexpi.open', async () => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showWarningMessage('Open a DEXPI file first.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        DexpiEditorProvider.viewType,
        vscode.ViewColumn.Beside,
      );
    }),

    vscode.commands.registerCommand('osiris-dexpi.validate', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        void vscode.window.showWarningMessage('Open a DEXPI file first.');
        return;
      }
      const summary = refreshDiagnostics(document, diagnostics);
      telemetry.event({ name: 'dexpi.validate', measurements: summary });
      void vscode.window.showInformationMessage(
        `DEXPI: ${summary.errors} error(s), ${summary.warnings} warning(s).`,
      );
    }),

    vscode.commands.registerCommand('osiris-dexpi.exportSvg', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) {
        return;
      }
      const parsed = parseDexpi(document.getText());
      if (isErr(parsed)) {
        void vscode.window.showErrorMessage(`DEXPI parse failed: ${parsed.error.message}`);
        return;
      }
      const target = await vscode.window.showSaveDialog({
        filters: { 'SVG image': ['svg'] },
        defaultUri: vscode.Uri.file(document.uri.fsPath.replace(/\.[^.]+$/, '.svg')),
      });
      if (!target) {
        return;
      }
      const svg = renderDexpiSvg(parsed.value);
      await vscode.workspace.fs.writeFile(target, Buffer.from(svg, 'utf8'));
      void vscode.window.showInformationMessage(`Exported ${target.fsPath}`);
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      const enabled = vscode.workspace
        .getConfiguration('osiris-dexpi')
        .get<boolean>('validateOnSave', true);
      if (enabled && looksLikeDexpi(document)) {
        refreshDiagnostics(document, diagnostics);
      }
    }),

    vscode.workspace.onDidOpenTextDocument((document) => {
      if (looksLikeDexpi(document)) {
        refreshDiagnostics(document, diagnostics);
      }
    }),
  );

  if (vscode.window.activeTextEditor && looksLikeDexpi(vscode.window.activeTextEditor.document)) {
    refreshDiagnostics(vscode.window.activeTextEditor.document, diagnostics);
  }

  // Surface a parse/validate summary in the status bar on demand.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'osiris-dexpi.validate';
  context.subscriptions.push(status);
  const syncStatus = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    if (document && looksLikeDexpi(document)) {
      const parsed = parseDexpi(document.getText());
      status.text = isErr(parsed)
        ? '$(error) DEXPI'
        : `$(circuit-board) DEXPI ${parsed.value.equipment.length}eq/${validateDexpi(parsed.value).length}i`;
      status.show();
    } else {
      status.hide();
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(syncStatus));
  syncStatus();
}

export function deactivate(): void {
  log.info('deactivating osiris-dexpi');
}
