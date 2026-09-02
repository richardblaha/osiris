/**
 * A thin `devcontainer` CLI wrapper for the local (ui) extension host — enough to
 * bring a project's DevContainer up and start its openvscode-server. Heavier
 * Docker work (freeze/thaw) still lives in `@osiris/container-sync`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDevcontainerConfig } from '@osiris/container-sync/devcontainer-template';
import { createLogger } from '@osiris/shared-core';
import { HASH_LABEL, PORT_LABEL } from './resolver.js';

const execFileAsync = promisify(execFile);
const log = createLogger('workspace:devcontainer-cli');

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultExec: Exec = (file, args) =>
  execFileAsync(file, args, { maxBuffer: 32 * 1024 * 1024, env: process.env });

export interface UpDevContainerInput {
  hostPath: string;
  hash: string;
  serverPort: number;
  /** `KEY=VALUE` env for the container (agent API keys re-read from the keychain). */
  remoteEnv?: Record<string, string>;
  /** Feature ref for projects that bring their own config; '' skips injection. */
  webIdeFeatureRef?: string;
  exec?: Exec;
}

export interface UpDevContainerResult {
  containerId: string;
  remoteWorkspaceFolder: string;
}

/** Parse the trailing JSON line `devcontainer up` prints. */
export function parseUpResult(stdout: string): UpDevContainerResult {
  const line = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  let json: { outcome?: string; containerId?: string; remoteWorkspaceFolder?: string };
  try {
    json = JSON.parse(line) as typeof json;
  } catch {
    throw new Error(`devcontainer up produced no JSON result:\n${stdout}`);
  }
  if (!json.containerId) throw new Error(`devcontainer up returned no containerId: ${line}`);
  return {
    containerId: json.containerId,
    remoteWorkspaceFolder: json.remoteWorkspaceFolder ?? '/workspaces',
  };
}

const DEFAULT_FEATURE = 'ghcr.io/osiris-ide/osiris/web-ide:1';

/**
 * Ensure the DevContainer for `hostPath` is up (writing the Osiris fallback
 * config first if the project has none), tag it with the Osiris id-labels, and
 * start its in-container server.
 */
export async function upDevContainer(input: UpDevContainerInput): Promise<UpDevContainerResult> {
  const exec = input.exec ?? defaultExec;
  const feature = input.webIdeFeatureRef ?? DEFAULT_FEATURE;

  const config = await ensureDevcontainerConfig(input.hostPath, {
    serverPort: input.serverPort,
    webIdeFeatureRef: feature || undefined,
  });
  if (config.created) log.info('wrote the Osiris fallback devcontainer.json');

  const args = [
    'up',
    '--workspace-folder',
    input.hostPath,
    '--id-label',
    `${HASH_LABEL}=${input.hash}`,
    '--id-label',
    `${PORT_LABEL}=${input.serverPort}`,
  ];
  if (!config.created && feature) {
    args.push('--additional-features', JSON.stringify({ [feature]: { port: input.serverPort } }));
  }
  for (const [key, value] of Object.entries(input.remoteEnv ?? {})) {
    args.push('--remote-env', `${key}=${value}`);
  }

  log.info('devcontainer up %s', input.hostPath);
  const { stdout } = await exec('devcontainer', args);
  const result = parseUpResult(stdout);

  try {
    await exec('devcontainer', [
      'exec',
      '--workspace-folder',
      input.hostPath,
      'osiris-web-ide',
      'start',
    ]);
  } catch (err) {
    log.warn('in-container server may not be running yet: %s', String(err));
  }

  return result;
}
