import { basename } from 'node:path';
import { createLogger } from '@richardblaha/shared-core';
import { classifyOpenTarget, planReopen } from './folder-routing.js';

const log = createLogger('desktop-host:guard');

/** The Electron primitives the guard needs — passed in so this package needs no `electron` dep. */
export interface ElectronBridge {
  onOpenFile(listener: (path: string) => void): void;
  onSecondInstance(listener: (argv: string[]) => void): void;
  handleIpc(channel: string, listener: () => Promise<void> | void): void;
  showConfirm(options: {
    message: string;
    detail: string;
    confirmLabel: string;
  }): Promise<boolean>;
  pickFolder(): Promise<string | undefined>;
}

export interface GuardDeps {
  electron: ElectronBridge;
  /** Open (or focus) a workbench window on a folder URI. */
  openWorkbench(options: { folderUri: string }): void;
  /** Build/attach the DevContainer for a host path (delegates to `@osiris/container-sync`). */
  ensureDevContainer(hostPath: string): Promise<{ hash: string }>;
  /** Extract a folder path from CLI argv, if present (`--folder-uri`, `--folder`, positional). */
  folderFromArgv?(argv: string[]): string | undefined;
}

/**
 * Intercept every way a folder can be opened and route raw host paths through
 * "Open in Osiris DevContainer". A path that already resolves to an
 * `osiris-devcontainer` authority is passed straight through.
 */
export function installDevContainerGuard(deps: GuardDeps): void {
  const route = (raw: string): void => void handleOpen(raw, deps);

  deps.electron.onOpenFile(route);
  deps.electron.onSecondInstance((argv) => {
    const folder = (deps.folderFromArgv ?? defaultFolderFromArgv)(argv);
    if (folder) route(folder);
  });
  deps.electron.handleIpc('osiris.openFolder', async () => {
    const picked = await deps.electron.pickFolder();
    if (picked) await handleOpen(picked, deps);
  });

  log.info('devcontainer guard installed');
}

async function handleOpen(raw: string, deps: GuardDeps): Promise<void> {
  const target = classifyOpenTarget(raw);
  if (target.kind === 'osiris-remote') {
    deps.openWorkbench({ folderUri: raw });
    return;
  }

  const hostPath = target.path;
  const confirmed = await deps.electron.showConfirm({
    message: 'Osiris runs every workspace inside a DevContainer',
    detail: `"${hostPath}" is on your host filesystem. Osiris will build/attach its DevContainer and open the folder inside it.`,
    confirmLabel: 'Open in Osiris DevContainer',
  });
  if (!confirmed) return;

  const plan = planReopen(hostPath);
  try {
    await deps.ensureDevContainer(hostPath);
  } catch (err) {
    log.warn('ensureDevContainer failed for %s: %s', hostPath, String(err));
  }
  log.info('reopening %s as %s', basename(hostPath), plan.folderUri);
  deps.openWorkbench({ folderUri: plan.folderUri });
}

export function defaultFolderFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--folder-uri' || arg === '--folder') return argv[i + 1];
    if (arg?.startsWith('--folder-uri=')) return arg.slice('--folder-uri='.length);
    if (arg?.startsWith('--folder=')) return arg.slice('--folder='.length);
  }
  const positional = argv.slice(2).find((a) => !a.startsWith('-'));
  return positional;
}
