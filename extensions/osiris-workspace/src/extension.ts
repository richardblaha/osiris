import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import * as vscode from 'vscode';
import { createLogger } from '@osiris/shared-core';
import { HandoverClient } from '@osiris/protocol';
import {
  OSIRIS_AUTHORITY,
  buildFolderUri,
  isOsirisRemote,
  parseAuthorityHash,
} from './authority.js';
import { resolveDevContainerEndpoint } from './resolver.js';
import { resolveServerConfig } from './server-config.js';
import { upDevContainer } from './devcontainer-cli.js';
import { RecentProjectsStore } from './recent-projects.js';
import { showStartView } from './start-view.js';
import { ensureLmProxy, lmProxyRemoteEnv } from './lm-proxy-host.js';
import { createVscodeLmBridge, hasLanguageModelApi } from './lm-bridge.js';
import { TASK_CLASSES } from '@osiris/protocol';
import { taskModelEnv, unsetTaskClasses } from './model-config.js';

const log = createLogger('workspace');

type Location = 'local' | 'in-transit' | 'server';

const DEFAULT_SECRET_ENV_KEYS = ['OSIRIS_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

function setLocationContext(location: Location): void {
  void vscode.commands.executeCommand('setContext', 'osiris.sessionLocation', location);
}

function config() {
  return vscode.workspace.getConfiguration('osiris');
}

/** Feature-detect the proposed resolver API. */
function canResolveAuthorities(): boolean {
  return typeof vscode.workspace.registerRemoteAuthorityResolver === 'function';
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('activating osiris-workspace (remote: %s)', vscode.env.remoteName ?? 'none');

  const recent = new RecentProjectsStore(context.globalState);

  if (canResolveAuthorities()) {
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(OSIRIS_AUTHORITY, {
        async resolve(authority) {
          const hash = parseAuthorityHash(authority);
          const endpoint = await resolveOrRebuild(context, recent, hash);
          return new vscode.ResolvedAuthority(endpoint.host, endpoint.port);
        },
      }),
    );
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  context.subscriptions.push(status);

  const startDeps = {
    recent,
    openInDevContainer: (hostPath: string) => openInDevContainer(context, recent, hostPath),
  };

  const modelsStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
  context.subscriptions.push(modelsStatus);
  refreshModelsStatus(modelsStatus);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('osiris.models')) refreshModelsStatus(modelsStatus);
    }),
  );
  void nudgeIncompleteModels();

  context.subscriptions.push(
    vscode.commands.registerCommand('osiris.openFolder', () =>
      openFolderInDevContainer(context, recent),
    ),
    vscode.commands.registerCommand('osiris.showStart', () => showStartView(context, startDeps)),
    vscode.commands.registerCommand('osiris.configureModels', () =>
      showStartView(context, startDeps, { focus: 'models' }),
    ),
    vscode.commands.registerCommand('osiris.workspace.handoverToServer', () =>
      transferSession('to-server'),
    ),
    vscode.commands.registerCommand('osiris.workspace.fetchToLocal', () =>
      transferSession('to-local'),
    ),
    vscode.commands.registerCommand('osiris.agent.setApiKey', () => setAgentApiKey(context)),
    vscode.commands.registerCommand('osiris.lm.status', () => showLmStatus(context)),
  );

  // The local (ui) extension host owns Docker-side work — a container window
  // inherits nothing here and delegates back to this command.
  if (!vscode.env.remoteName) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        'osiris.desktop.ensureDevContainer',
        (payload: { hostPath: string; serverPort?: number }) =>
          ensureDevContainerLocally(context, recent, payload),
      ),
    );
  }

  // Inside a container we default to 'local'; the desktop/server set the real
  // location via the `osiris.sessionLocation` context during a handover.
  const location: Location = 'local';
  setLocationContext(location);
  updateStatus(status, location);

  const remote = isOsirisRemote(vscode.env.remoteName);
  const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;

  if (!remote && !hasFolder && !vscode.env.remoteName) {
    await handleEmptyWindow(context, recent);
  } else if (config().get<boolean>('devcontainer.enforce', true) && !remote && hasFolder) {
    await guardLocalWindow(context, recent);
  }
}

/** No folder open in a local window: restore the last project or show Osiris Start. */
async function handleEmptyWindow(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
): Promise<void> {
  const projects = await recent.prune(pathExists);
  if (config().get<boolean>('startup.restoreLast', false) && projects[0]) {
    log.info('restoring last project: %s', projects[0].hostPath);
    await openInDevContainer(context, recent, projects[0].hostPath);
    return;
  }
  if (config().get<boolean>('startup.showStartView', true)) {
    showStartView(context, {
      recent,
      openInDevContainer: (hostPath) => openInDevContainer(context, recent, hostPath),
    });
  }
}

/** Resolve the endpoint for `hash`; if the container is gone, rebuild it from the recent list. */
async function resolveOrRebuild(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
  hash: string,
): Promise<{ host: string; port: number }> {
  try {
    return await resolveDevContainerEndpoint(hash);
  } catch (err) {
    const project = recent.find(hash);
    if (!project) throw err;
    log.info('devcontainer %s not found — rebuilding from %s', hash, project.hostPath);
    await ensureDevContainerLocally(context, recent, {
      hostPath: project.hostPath,
      serverPort: project.serverPort,
    });
    return resolveDevContainerEndpoint(hash);
  }
}

export function deactivate(): void {
  log.info('deactivating osiris-workspace');
}

function updateStatus(item: vscode.StatusBarItem, location: Location): void {
  const label: Record<Location, string> = {
    local: '$(vm) Osiris: Local',
    'in-transit': '$(sync~spin) Osiris: In transit',
    server: '$(cloud) Osiris: Server',
  };
  item.text = label[location];
  item.command =
    location === 'server' ? 'osiris.workspace.fetchToLocal' : 'osiris.workspace.handoverToServer';
  item.tooltip = 'Osiris session location — click to move it';
  item.show();
}

/** Status-bar nudge while some task classes still fall back to the default local model. */
function refreshModelsStatus(item: vscode.StatusBarItem): void {
  const unset = unsetTaskClasses(vscode.workspace.getConfiguration('osiris.models'));
  if (unset.length === 0) {
    item.hide();
    return;
  }
  item.text = `$(warning) Models ${TASK_CLASSES.length - unset.length}/${TASK_CLASSES.length}`;
  item.tooltip = `${unset.length} task class(es) use the default local model — click to configure`;
  item.command = 'osiris.configureModels';
  item.show();
}

/**
 * One-shot startup reminder (bod 6). Skipped when it would duplicate the Start
 * page's own Models section (empty window with the Start view enabled), or when
 * the user chose "don't remind me".
 */
async function nudgeIncompleteModels(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('osiris.models');
  if (cfg.get<boolean>('remindIncomplete', true) === false) return;
  const unset = unsetTaskClasses(cfg);
  if (unset.length === 0) return;

  const hasFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  const startViewWillShow =
    !hasFolder &&
    !vscode.env.remoteName &&
    config().get<boolean>('startup.showStartView', true) &&
    !config().get<boolean>('startup.restoreLast', false);
  if (startViewWillShow) return;

  const pick = await vscode.window.showInformationMessage(
    'Some task models are not set — Osiris is using the default local model (Qwen 4B).',
    'Configure',
    "Don't remind me",
  );
  if (pick === 'Configure') {
    await vscode.commands.executeCommand('osiris.configureModels');
  } else if (pick === "Don't remind me") {
    await cfg.update('remindIncomplete', false, vscode.ConfigurationTarget.Global);
  }
}

async function guardLocalWindow(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const choice = await vscode.window.showWarningMessage(
    'This folder is open outside an Osiris DevContainer. The agent and workspace tasks will not run here.',
    { modal: true },
    'Reopen in DevContainer',
    'Close Folder',
  );

  if (choice === 'Reopen in DevContainer') {
    await openInDevContainer(context, recent, folder.uri.fsPath);
  } else if (choice === 'Close Folder') {
    await vscode.commands.executeCommand('workbench.action.closeFolder');
  }
}

async function openFolderInDevContainer(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Open in Osiris DevContainer',
  });
  if (picked?.[0]) await openInDevContainer(context, recent, picked[0].fsPath);
}

/** Build/attach the DevContainer for `hostPath` and open the remote window on it. */
async function openInDevContainer(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
  hostPath: string,
): Promise<void> {
  const name = basename(hostPath);
  const ensured = await tryExecuteCommand<{ hash: string }>('osiris.desktop.ensureDevContainer', {
    hostPath,
    serverPort: config().get<number>('devcontainer.serverPort', 8000),
  });
  const hash = ensured?.hash ?? localHash(hostPath);

  const uri = vscode.Uri.parse(buildFolderUri(hash, name));
  log.info('opening %s as %s', hostPath, uri.toString());
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
}

/**
 * The `osiris.desktop.ensureDevContainer` handler: bring the DevContainer up via
 * the `devcontainer` CLI, injecting the agent's API keys from the keychain, and
 * record the project so it can be restored / rebuilt later.
 */
async function ensureDevContainerLocally(
  context: vscode.ExtensionContext,
  recent: RecentProjectsStore,
  payload: { hostPath: string; serverPort?: number },
): Promise<{ hash: string; containerId: string }> {
  const serverPort = payload.serverPort ?? config().get<number>('devcontainer.serverPort', 8000);
  const hash = localHash(payload.hostPath);
  const proxy = await ensureLmProxy(context);
  const remoteEnv = {
    ...(await collectAgentSecrets(context)),
    ...taskModelEnv(vscode.workspace.getConfiguration('osiris.models')),
    ...lmProxyRemoteEnv(proxy),
  };

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Osiris: preparing DevContainer' },
    () =>
      upDevContainer({
        hostPath: payload.hostPath,
        hash,
        serverPort,
        remoteEnv,
        webIdeFeatureRef: config().get<string>('devcontainer.webIdeFeature') || undefined,
      }),
  );
  await recent.remember({
    hostPath: payload.hostPath,
    name: basename(payload.hostPath),
    hash,
    serverPort,
  });
  log.info('devcontainer %s ready (%s)', hash, result.containerId.slice(0, 12));
  return { hash, containerId: result.containerId };
}

/** API keys the agent needs, taken from SecretStorage first, then the host env. */
async function collectAgentSecrets(
  context: vscode.ExtensionContext,
): Promise<Record<string, string>> {
  const keys = config().get<string[]>('agent.secretEnvKeys', DEFAULT_SECRET_ENV_KEYS);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = (await context.secrets.get(key)) ?? process.env[key];
    if (value) out[key] = value;
  }
  if (Object.keys(out).length) {
    log.info('injecting %d agent secret(s) into the container', Object.keys(out).length);
  }
  return out;
}

/** Show which editor language models the crew can use, and the proxy state. */
async function showLmStatus(context: vscode.ExtensionContext): Promise<void> {
  if (!hasLanguageModelApi()) {
    void vscode.window.showWarningMessage(
      'Osiris: this editor has no Language Model API. Crew runs fall back to OSIRIS_CREW_PROVIDER (ollama/echo).',
    );
    return;
  }
  const models = await createVscodeLmBridge().listModels();
  const proxy = await ensureLmProxy(context);
  const lines = models.map(
    (m) => `• ${m.id}${m.maxInputTokens ? ` (${m.maxInputTokens} tok)` : ''}`,
  );
  void vscode.window.showInformationMessage(
    `Osiris LM: ${models.length} model(s) — ${lines.join(', ') || 'none'}. ` +
      (proxy ? `Proxy for containers: ${proxy.containerUrl}` : 'Proxy not started.'),
  );
}

async function setAgentApiKey(context: vscode.ExtensionContext): Promise<void> {
  const keys = config().get<string[]>('agent.secretEnvKeys', DEFAULT_SECRET_ENV_KEYS);
  const key = await vscode.window.showQuickPick(keys, {
    title: 'Which agent API key?',
    placeHolder: 'Environment variable name',
  });
  if (!key) return;
  const value = await vscode.window.showInputBox({
    title: `Value for ${key}`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  if (value === '') {
    await context.secrets.delete(key);
    void vscode.window.showInformationMessage(`Osiris: cleared ${key}.`);
  } else {
    await context.secrets.store(key, value);
    void vscode.window.showInformationMessage(`Osiris: stored ${key} in the OS keychain.`);
  }
}

async function transferSession(direction: 'to-server' | 'to-local'): Promise<void> {
  const server = resolveServerConfig({
    url: config().get('server.url'),
    tokenEnv: config().get('server.tokenEnv'),
  });
  if (!server) {
    void vscode.window.showErrorMessage('Set "osiris.server.url" to move sessions between hosts.');
    return;
  }
  if (!server.token) {
    void vscode.window.showErrorMessage(
      `No Osiris Server token — set the ${String(config().get('server.tokenEnv'))} environment variable.`,
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const client = new HandoverClient({ baseUrl: server.baseUrl, token: server.token });
  const hash = localHash(folder.uri.fsPath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Osiris: ${direction}`,
      cancellable: false,
    },
    async (progress) => {
      try {
        setLocationContext('in-transit');
        progress.report({ message: 'preparing…' });

        const session = await client.createSession({
          workspaceId: folder.name,
          devcontainerHash: hash,
          origin: direction === 'to-server' ? 'desktop' : 'server',
        });

        if (direction === 'to-server') {
          const prep = await client.prepareHandover(session.sessionId);
          progress.report({ message: 'freezing and uploading…' });
          const done = await tryExecuteCommand<{ webUrl: string }>(
            'osiris.desktop.performHandover',
            {
              sessionId: session.sessionId,
              prepare: prep,
            },
          );
          if (done?.webUrl) {
            const open = await vscode.window.showInformationMessage(
              'Session is now running on the Osiris Server.',
              'Open Web IDE',
            );
            if (open) await vscode.env.openExternal(vscode.Uri.parse(done.webUrl));
          }
          setLocationContext('server');
        } else {
          await client.prepareFetch(session.sessionId);
          progress.report({ message: 'restoring locally…' });
          await tryExecuteCommand('osiris.desktop.performFetch', { sessionId: session.sessionId });
          setLocationContext('local');
        }
      } catch (err) {
        setLocationContext(direction === 'to-server' ? 'local' : 'server');
        void vscode.window.showErrorMessage(`Osiris handover failed: ${(err as Error).message}`);
      }
    },
  );
}

async function tryExecuteCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  const all = await vscode.commands.getCommands(true);
  if (!all.includes(command)) {
    void vscode.window.showWarningMessage(
      `This step needs the Osiris desktop app (command "${command}" is not available here).`,
    );
    return undefined;
  }
  return vscode.commands.executeCommand<T>(command, ...args);
}

/** Mirror of `@osiris/container-sync`'s `devcontainerHash` (no dockerode dep here). */
function localHash(absolutePath: string): string {
  return createHash('sha256').update(resolvePath(absolutePath)).digest('hex').slice(0, 12);
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? p;
}

function pathExists(p: string): boolean {
  return existsSync(p);
}
