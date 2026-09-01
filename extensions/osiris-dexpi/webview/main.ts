/**
 * DEXPI preview webview. Receives `{ type: 'model', svg, issues, ... }` messages
 * from `DexpiEditorProvider`, renders the SVG, wires click-to-select on both the
 * diagram and the issue list, and posts `select` back to the extension.
 */
import type { ValidationIssue } from '@osiris/shared-core';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const stage = document.getElementById('stage')!;
const issuesEl = document.getElementById('issues')!;
const summaryEl = document.getElementById('summary')!;

interface ModelMessage {
  type: 'model';
  svg: string;
  issues: ValidationIssue[];
  summary: { errors: number; warnings: number; info: number };
  stats: { equipment: number; segments: number };
}
interface ErrorMessage {
  type: 'error';
  message: string;
}
type Inbound = ModelMessage | ErrorMessage;

function selectId(id: string): void {
  if (!id) {
    return;
  }
  for (const el of stage.querySelectorAll('[data-id]')) {
    el.classList.toggle('selected', el.getAttribute('data-id') === id);
  }
  vscodeApi.postMessage({ type: 'select', id });
}

function renderIssues(issues: ValidationIssue[]): void {
  issuesEl.innerHTML = '';
  for (const issue of issues) {
    const row = document.createElement('div');
    row.className = `issue ${issue.severity}`;
    row.textContent = `${issue.code}: ${issue.message}`;
    row.title = issue.path;
    if (issue.nodeId) {
      row.addEventListener('click', () => selectId(issue.nodeId!));
    }
    issuesEl.appendChild(row);
  }
}

window.addEventListener('message', (event: MessageEvent<Inbound>) => {
  const msg = event.data;
  if (msg.type === 'error') {
    stage.textContent = `Parse error: ${msg.message}`;
    summaryEl.textContent = 'invalid document';
    issuesEl.innerHTML = '';
    return;
  }
  stage.innerHTML = msg.svg;
  summaryEl.textContent =
    `${msg.stats.equipment} equipment · ${msg.stats.segments} segments · ` +
    `${msg.summary.errors} errors · ${msg.summary.warnings} warnings`;
  for (const el of stage.querySelectorAll('[data-id]')) {
    el.addEventListener('click', () => selectId(el.getAttribute('data-id') ?? ''));
  }
  renderIssues(msg.issues);
});

vscodeApi.postMessage({ type: 'ready' });
