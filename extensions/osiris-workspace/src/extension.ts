import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import * as vscode from 'vscode';
import { createLogger } from '@osiris/shared-core';
import { HandoverClient } from '@osiris/protocol';
import { OSIRIS_AUTHORITY, buildFolderUri, isOsirisRemote, parseAuthorityHash } from './authority.js';
import { resolveDevContainerEndpoint } from './resolver.js';
import { resolveServerConfig } from './server-config.js';

const log = createLogger('workspace');

type Location = 'local' | 'in-transit' | 'server';

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

  if (canResolveAuthorities()) {
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(OSIRIS_AUTHORITY, {
        async resolve(authority) {
          const hash = parseAuthorityHash(authority);
          const endpoint = await resolveDevContainerEndpoint(hash);
          return new vscode.ResolvedAuthority(endpoint.host, endpoint.port);
        },
      }),
    );
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.commands.registerCommand('osiris.openFolder', () => openFolderInDevContainer()),
    vscode.commands.registerCommand('osiris.workspace.handoverToServer', () =>
      transferSession('to-server'),
    ),
    vscode.commands.registerCommand('osiris.workspace.fetchToLocal', () =>
      transferSession('to-local'),
    ),
  );

  // Inside a container we default to 'local'; the desktop/server set the real
  // location via the `osiris.sessionLocation` context during a handover.
  const location: Location = 'local';
  setLocationContext(location);
  updateStatus(status, location);

  if (config().get<boolean>('devcontainer.enforce', true) && !isOsirisRemote(vscode.env.remoteName)) {
    await guardLocalWindow();
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
  item.command = location === 'server' ? 'osiris.workspace.fetchToLocal' : 'osiris.workspace.handoverToServer';
  item.tooltip = 'Osiris session location — click to move it';
  item.show();
}

async function guardLocalWindow(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;

  const choice = await vscode.window.showWarningMessage(
    'This folder is open outside an Osiris DevContainer. The agent and workspace tasks will not run here.',
    { modal: true },
    'Reopen in DevContainer',
    'Close Folder',
  );

  if (choice === 'Reopen in DevContainer') {
    await reopenInDevContainer(folder);
  } else if (choice === 'Close Folder') {
    await vscode.commands.executeCommand('workbench.action.closeFolder');
  }
}

async function openFolderInDevContainer(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Open in Osiris DevContainer',
  });
  const target = picked?.[0];
  if (target) {
    await reopenInDevContainer({ uri: target, name: basename(target.fsPath), index: 0 });
  }
}

async function reopenInDevContainer(folder: vscode.WorkspaceFolder): Promise<void> {
  const hostPath = folder.uri.fsPath;

  // Container creation needs Docker — delegated to the desktop orchestrator.
  const ensured = await tryExecuteCommand<{ hash: string }>('osiris.desktop.ensureDevContainer', {
    hostPath,
    serverPort: config().get<number>('devcontainer.serverPort', 8000),
  });
  const hash = ensured?.hash ?? localHash(hostPath);

  const uri = vscode.Uri.parse(buildFolderUri(hash, folder.name));
  log.info('reopening %s as %s', hostPath, uri.toString());
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
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
    { location: vscode.ProgressLocation.Notification, title: `Osiris: ${direction}`, cancellable: false },
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
          const done = await tryExecuteCommand<{ webUrl: string }>('osiris.desktop.performHandover', {
            sessionId: session.sessionId,
            prepare: prep,
          });
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
