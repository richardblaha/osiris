import * as vscode from 'vscode';
import { isErr } from '@osiris/shared-core';
import { parseDexpi } from './parser/dexpiParser.js';
import { summarize, validateDexpi } from './parser/schemaValidator.js';

/** Parse + validate a document and push the results into a DiagnosticCollection. */
export function refreshDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): { errors: number; warnings: number; info: number } {
  const parsed = parseDexpi(document.getText());
  if (isErr(parsed)) {
    const line = (parsed.error.line ?? 1) - 1;
    const range = document.lineAt(Math.max(0, Math.min(line, document.lineCount - 1))).range;
    collection.set(document.uri, [
      new vscode.Diagnostic(range, parsed.error.message, vscode.DiagnosticSeverity.Error),
    ]);
    return { errors: 1, warnings: 0, info: 0 };
  }

  const issues = validateDexpi(parsed.value);
  const diagnostics = issues.map((issue) => {
    const severity =
      issue.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : issue.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
    const diag = new vscode.Diagnostic(
      locate(document, issue.nodeId),
      `${issue.message} [${issue.code}] (${issue.path})`,
      severity,
    );
    diag.source = 'osiris-dexpi';
    diag.code = issue.code;
    return diag;
  });
  collection.set(document.uri, diagnostics);
  return summarize(issues);
}

/** Best-effort: point at the line where the offending element's ID appears. */
function locate(document: vscode.TextDocument, nodeId?: string): vscode.Range {
  if (nodeId) {
    const text = document.getText();
    const idx = text.indexOf(`"${nodeId}"`);
    if (idx >= 0) {
      const pos = document.positionAt(idx);
      return document.lineAt(pos.line).range;
    }
  }
  return new vscode.Range(0, 0, 0, 0);
}
