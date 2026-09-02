import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const OSIRIS_AUTHORITY = 'osiris-devcontainer';

export type OpenTarget =
  | { kind: 'osiris-remote'; authority: string }
  | { kind: 'host-path'; path: string };

/**
 * Decide what the shell should do with something the user asked to open —
 * an already-resolved Osiris remote, or a raw host path that must be routed
 * through the "Open in Osiris DevContainer" flow.
 */
export function classifyOpenTarget(raw: string): OpenTarget {
  if (raw.startsWith('vscode-remote://')) {
    const authority = raw.slice('vscode-remote://'.length).split('/')[0] ?? '';
    if (authority === OSIRIS_AUTHORITY || authority.startsWith(`${OSIRIS_AUTHORITY}+`)) {
      return { kind: 'osiris-remote', authority };
    }
  }
  const path = raw.startsWith('file://') ? fileURLToPath(raw) : raw;
  return { kind: 'host-path', path };
}

/** Mirror of `@osiris/container-sync`'s `devcontainerHash`. */
export function devcontainerHash(hostPath: string): string {
  return createHash('sha256').update(resolve(hostPath)).digest('hex').slice(0, 12);
}

export interface ReopenPlan {
  hash: string;
  folderName: string;
  folderUri: string;
}

/** Compute the `vscode-remote://osiris-devcontainer+<hash>/…` URI for a host folder. */
export function planReopen(hostPath: string): ReopenPlan {
  const hash = devcontainerHash(hostPath);
  const folderName = resolve(hostPath).split(/[\\/]/).filter(Boolean).at(-1) ?? 'workspace';
  return {
    hash,
    folderName,
    folderUri: `vscode-remote://${OSIRIS_AUTHORITY}+${hash}/workspaces/${folderName}`,
  };
}
