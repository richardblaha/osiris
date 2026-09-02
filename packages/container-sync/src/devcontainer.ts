import { execa } from 'execa';
import type Docker from 'dockerode';
import { createLogger } from '@osiris/shared-core';
import { devcontainerHash } from './hash.js';

/** The slice of `execa` this module needs; overridable in tests. */
export type CommandRunner = (
  file: string,
  args: string[],
  options: { preferLocal: boolean },
) => Promise<{ stdout: string }>;

const log = createLogger('container-sync:devcontainer');

export const HASH_LABEL = 'com.osiris.devcontainer.hash';
export const PORT_LABEL = 'com.osiris.devcontainer.port';

export interface DevContainerUpResult {
  outcome: string;
  containerId: string;
  remoteWorkspaceFolder: string;
}

/** Parse the JSON line the `@devcontainers/cli` prints on `devcontainer up`. */
export function parseDevContainerUp(stdout: string): DevContainerUpResult {
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  let json: Partial<DevContainerUpResult> & { containerId?: string };
  try {
    json = JSON.parse(lastLine) as typeof json;
  } catch {
    throw new Error(`devcontainer up produced no JSON result:\n${stdout}`);
  }
  if (!json.containerId) {
    throw new Error(`devcontainer up did not return a containerId: ${lastLine}`);
  }
  return {
    outcome: json.outcome ?? 'unknown',
    containerId: json.containerId,
    remoteWorkspaceFolder: json.remoteWorkspaceFolder ?? '/workspaces',
  };
}

export interface EnsureDevContainerInput {
  /** Host folder to open. */
  hostPath: string;
  /** Port the in-container VS Code server will listen on. */
  serverPort: number;
  /** Override the command runner (tests). */
  runner?: CommandRunner;
}

export interface DevContainerHandle {
  hash: string;
  containerId: string;
  remoteWorkspaceFolder: string;
  host: string;
  port: number;
}

/**
 * Build/attach the DevContainer for `hostPath`, tagged with the Osiris hash and
 * port id-labels so {@link resolveByHash} can find it later.
 */
export async function ensureDevContainer(
  input: EnsureDevContainerInput,
): Promise<DevContainerHandle> {
  const hash = devcontainerHash(input.hostPath);
  const run: CommandRunner = input.runner ?? (execa as unknown as CommandRunner);
  log.info('devcontainer up for %s (hash %s)', input.hostPath, hash);

  const { stdout } = await run(
    'devcontainer',
    [
      'up',
      '--workspace-folder',
      input.hostPath,
      '--id-label',
      `${HASH_LABEL}=${hash}`,
      '--id-label',
      `${PORT_LABEL}=${input.serverPort}`,
    ],
    { preferLocal: true },
  );

  const result = parseDevContainerUp(stdout);
  return {
    hash,
    containerId: result.containerId,
    remoteWorkspaceFolder: result.remoteWorkspaceFolder,
    host: '127.0.0.1',
    port: input.serverPort,
  };
}

export interface ResolvedDevContainer {
  containerId: string;
  host: string;
  port: number;
}

/**
 * Look up a DevContainer by its Osiris hash label, unpausing it if frozen, and
 * return the endpoint of its VS Code server — used by the remote authority
 * resolver in `osiris-workspace`.
 */
export async function resolveByHash(docker: Docker, hash: string): Promise<ResolvedDevContainer> {
  const matches = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${HASH_LABEL}=${hash}`] }),
  });
  const info = matches[0];
  if (!info) throw new Error(`no Osiris DevContainer for hash ${hash}`);

  const container = docker.getContainer(info.Id);
  if (info.State === 'paused') {
    log.info('unpausing devcontainer %s', info.Id.slice(0, 12));
    await container.unpause();
  } else if (info.State !== 'running') {
    await container.start();
  }

  const portLabel = info.Labels[PORT_LABEL];
  const port = portLabel ? Number(portLabel) : Number.NaN;
  if (!Number.isInteger(port)) {
    throw new Error(`devcontainer ${info.Id.slice(0, 12)} has no ${PORT_LABEL} label`);
  }
  return { containerId: info.Id, host: '127.0.0.1', port };
}
