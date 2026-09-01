import * as vscode from 'vscode';
import { createLogger, createTelemetry, isErr } from '@osiris/shared-core';
import { parseStep } from './parser/stepParser.js';
import { computeStats } from './stats.js';
import { StepEditorProvider } from './preview/StepEditorProvider.js';

const log = createLogger('step');

async function readActiveStep(): Promise<{ uri: vscode.Uri; source: string } | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && /\.(step|stp|p21)$/i.test(editor.document.fileName)) {
    return { uri: editor.document.uri, source: editor.document.getText() };
  }
  const picked = await vscode.window.showOpenDialog({
    filters: { 'STEP files': ['step', 'stp', 'p21'] },
    canSelectMany: false,
  });
  if (!picked?.[0]) {
    return undefined;
  }
  const bytes = await vscode.workspace.fs.readFile(picked[0]);
  return { uri: picked[0], source: Buffer.from(bytes).toString('utf8') };
}

export function activate(context: vscode.ExtensionContext): void {
  const telemetry = createTelemetry({ env: process.env });
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  log.info('activating osiris-step');

  context.subscriptions.push(
    StepEditorProvider.register(context),

    vscode.commands.registerCommand('osiris-step.preview', async () => {
      const active = await readActiveStep();
      if (!active) {
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        active.uri,
        StepEditorProvider.viewType,
        vscode.ViewColumn.Beside,
      );
    }),

    vscode.commands.registerCommand('osiris-step.showHeader', async () => {
      const active = await readActiveStep();
      if (!active) {
        return;
      }
      const parsed = parseStep(active.source);
      if (isErr(parsed)) {
        void vscode.window.showErrorMessage(`STEP parse failed: ${parsed.error.message}`);
        return;
      }
      const h = parsed.value.header;
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(h, null, 2),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('osiris-step.stats', async () => {
      const active = await readActiveStep();
      if (!active) {
        return;
      }
      const parsed = parseStep(active.source);
      if (isErr(parsed)) {
        void vscode.window.showErrorMessage(`STEP parse failed: ${parsed.error.message}`);
        return;
      }
      const stats = computeStats(parsed.value);
      telemetry.event({
        name: 'step.stats',
        measurements: { entities: stats.entityCount, types: stats.distinctTypes },
      });
      const lines = [
        `Schema: ${stats.schemaIdentifiers.join(', ') || '(none)'}`,
        `Entities: ${stats.entityCount}  ·  Distinct types: ${stats.distinctTypes}`,
        '',
        ...stats.topTypes.map((t) => `${String(t.count).padStart(7)}  ${t.type}`),
      ];
      const doc = await vscode.workspace.openTextDocument({
        content: lines.join('\n'),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );
}

export function deactivate(): void {
  log.info('deactivating osiris-step');
}
