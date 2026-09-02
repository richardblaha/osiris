import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Stable per-workspace key: the first 12 hex chars of `sha256(absolutePath)`.
 * Used as the authority suffix (`vscode-remote://osiris-devcontainer+<hash>`) and
 * as the DevContainer id-label so a folder always maps to the same container.
 */
export function devcontainerHash(absolutePath: string): string {
  return createHash('sha256').update(resolve(absolutePath)).digest('hex').slice(0, 12);
}

/** Like {@link devcontainerHash} but resolves symlinks first. */
export async function hashHostPath(hostPath: string): Promise<string> {
  return devcontainerHash(await realpath(hostPath));
}
