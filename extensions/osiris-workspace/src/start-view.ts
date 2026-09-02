import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createLogger } from '@osiris/shared-core';
import { renderStartHtml } from './start-view-html.js';
import type { RecentProjectsStore } from './recent-projects.js';

const log = createLogger('workspace:start');

export interface StartViewDeps {
  recent: RecentProjectsStore;
  /** Reopen `hostPath` inside its Osiris DevContainer. */
  openInDevContainer(hostPath: string): Promise<void>;
}

function nonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** Open (or reveal) the Osiris Start webview. */
export function showStartView(context: vscode.ExtensionContext, deps: StartViewDeps): void {
  const panel = vscode.window.createWebviewPanel(
    'osiris.start',
    'Osiris',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  context.subscriptions.push(panel);

  const render = async (): Promise<void> => {
    const recent = await deps.recent.prune((p) => existsSync(p));
    panel.webview.html = renderStartHtml({
      recent,
      restoreLast: config().get<boolean>('startup.restoreLast', false),
      nonce: nonce(),
      cspSource: panel.webview.cspSource,
    });
  };

  panel.webview.onDidReceiveMessage(async (msg: { type: string; hash?: string; value?: boolean }) => {
    switch (msg.type) {
      case 'openRecent': {
        const project = msg.hash ? deps.recent.find(msg.hash) : undefined;
        if (project) {
          panel.dispose();
          await deps.openInDevContainer(project.hostPath);
        }
        break;
      }
      case 'openFolder': {
        const picked = await pickFolder('Open in Osiris DevContainer');
        if (picked) {
          panel.dispose();
          await deps.openInDevContainer(picked);
        }
        break;
      }
      case 'newProject': {
        const created = await scaffoldProject();
        if (created) {
          panel.dispose();
          await deps.openInDevContainer(created);
        }
        break;
      }
      case 'forget':
        if (msg.hash) await deps.recent.forget(msg.hash);
        await render();
        break;
      case 'setRestoreLast':
        await config().update(
          'startup.restoreLast',
          Boolean(msg.value),
          vscode.ConfigurationTarget.Global,
        );
        break;
    }
  }, undefined, context.subscriptions);

  void render();
}

function config() {
  return vscode.workspace.getConfiguration('osiris');
}

async function pickFolder(openLabel: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel,
  });
  return picked?.[0]?.fsPath;
}

/** New Project: pick a parent folder, name it, drop a README + Osiris DevContainer. */
async function scaffoldProject(): Promise<string | undefined> {
  const parent = await pickFolder('Select the parent folder');
  if (!parent) return undefined;

  const name = await vscode.window.showInputBox({
    title: 'New Osiris project',
    prompt: 'Project folder name',
    validateInput: (v) =>
      /^[\w.-]+$/.test(v.trim()) ? undefined : 'Use letters, digits, dot, dash or underscore',
  });
  if (!name) return undefined;

  const dir = join(parent, name.trim());
  if (existsSync(dir)) {
    void vscode.window.showErrorMessage(`"${dir}" already exists.`);
    return undefined;
  }

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'README.md'), `# ${name.trim()}\n\nCreated with Osiris.\n`, 'utf8');
  log.info('scaffolded %s', dir);
  return dir;
}
