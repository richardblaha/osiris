import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createLogger } from '@osiris/shared-core';
import { renderStartHtml, type StartViewModels } from './start-view-html.js';
import type { RecentProjectsStore } from './recent-projects.js';
import { createVscodeLmBridge, hasLanguageModelApi } from './lm-bridge.js';
import {
  PROVIDERS,
  buildExport,
  isValidSpec,
  parseImport,
  secretKeysFor,
  taskClassStates,
} from './model-config.js';

const log = createLogger('workspace:start');

export interface StartViewDeps {
  recent: RecentProjectsStore;
  /** Reopen `hostPath` inside its Osiris DevContainer. */
  openInDevContainer(hostPath: string): Promise<void>;
}

export interface ShowStartOptions {
  /** Scroll to and highlight the Models section. */
  focus?: 'models';
}

function nonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

async function lmModelIds(): Promise<string[]> {
  if (!hasLanguageModelApi()) return [];
  try {
    return (await createVscodeLmBridge().listModels()).map((m) => m.id);
  } catch (err) {
    log.debug('LM model list failed: %s', String(err));
    return [];
  }
}

async function secretsPresent(context: vscode.ExtensionContext): Promise<string[]> {
  const keys = [...new Set(PROVIDERS.map((p) => p.secretEnvKey).filter((k): k is string => !!k))];
  const present: string[] = [];
  for (const key of keys) if (await context.secrets.get(key)) present.push(key);
  return present;
}

async function buildModelsState(
  context: vscode.ExtensionContext,
  focus: boolean,
): Promise<StartViewModels> {
  const cfg = vscode.workspace.getConfiguration('osiris.models');
  const states = taskClassStates(cfg);
  return {
    rows: states.map((s) => ({
      id: s.id,
      label: s.label,
      userSpec: s.userSpec,
      fallbackSpec: s.spec,
      suggested: s.suggested,
    })),
    lmModels: await lmModelIds(),
    secretsPresent: await secretsPresent(context),
    hasFolder: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    focus,
  };
}

/** Open (or reveal) the Osiris Start webview. */
export function showStartView(
  context: vscode.ExtensionContext,
  deps: StartViewDeps,
  options: ShowStartOptions = {},
): void {
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
      models: await buildModelsState(context, options.focus === 'models'),
    });
    options.focus = undefined; // only highlight on first render
  };

  panel.webview.onDidReceiveMessage(
    async (msg: {
      type: string;
      hash?: string;
      value?: boolean;
      target?: 'global' | 'workspace';
      entries?: { taskClass: string; spec: string }[];
    }) => {
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
        case 'saveModels':
          await saveModels(context, msg.target ?? 'global', msg.entries ?? []);
          await render();
          break;
        case 'exportModels':
          await exportModels();
          break;
        case 'importModels':
          if (await importModels()) await render();
          break;
      }
    },
    undefined,
    context.subscriptions,
  );

  void render();
}

function config() {
  return vscode.workspace.getConfiguration('osiris');
}

async function saveModels(
  context: vscode.ExtensionContext,
  target: 'global' | 'workspace',
  entries: { taskClass: string; spec: string }[],
): Promise<void> {
  const scope =
    target === 'workspace'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  const cfg = vscode.workspace.getConfiguration('osiris.models');

  for (const entry of entries) {
    if (entry.spec && !isValidSpec(entry.spec)) {
      void vscode.window.showWarningMessage(
        `Osiris: "${entry.spec}" is not a valid <provider>/<model> spec — skipped.`,
      );
      continue;
    }
    await cfg.update(entry.taskClass, entry.spec || undefined, scope);
  }

  for (const key of secretKeysFor(entries.map((e) => e.spec).filter(Boolean))) {
    if (await context.secrets.get(key)) continue;
    const value = await vscode.window.showInputBox({
      title: `API key for ${key}`,
      prompt: 'Stored in the OS keychain — never written to settings.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value) await context.secrets.store(key, value);
  }

  void vscode.window.showInformationMessage(
    `Osiris: model configuration saved to ${target === 'workspace' ? 'the project' : 'user settings'}.`,
  );
}

async function exportModels(): Promise<void> {
  const data = buildExport(vscode.workspace.getConfiguration('osiris.models'));
  const uri = await vscode.window.showSaveDialog({
    saveLabel: 'Export',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.file('osiris-models.json'),
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8'));
  void vscode.window.showInformationMessage('Osiris: model configuration exported (no API keys).');
}

async function importModels(): Promise<boolean> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import',
    filters: { JSON: ['json'] },
  });
  if (!picked?.[0]) return false;

  let parsed;
  try {
    const raw = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
    parsed = parseImport(JSON.parse(raw));
  } catch (err) {
    void vscode.window.showErrorMessage(`Osiris: invalid model file — ${(err as Error).message}`);
    return false;
  }

  const target = await vscode.window.showQuickPick(
    ['User settings', 'Project settings'],
    { title: 'Import model configuration into…' },
  );
  if (!target) return false;
  const scope =
    target === 'Project settings'
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  const cfg = vscode.workspace.getConfiguration('osiris.models');
  if (parsed.defaultProvider) await cfg.update('defaultProvider', parsed.defaultProvider, scope);
  for (const [cls, spec] of Object.entries(parsed.models)) await cfg.update(cls, spec, scope);
  void vscode.window.showInformationMessage('Osiris: model configuration imported.');
  return true;
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
