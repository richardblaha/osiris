import { createLogger } from '@osiris/shared-core';
import { type Exec, findByLabel, wake } from './docker-cli.js';

const log = createLogger('workspace:resolver');

/** id-labels set by `@osiris/container-sync`'s `ensureDevContainer`. */
export const HASH_LABEL = 'com.osiris.devcontainer.hash';
export const PORT_LABEL = 'com.osiris.devcontainer.port';

export interface DevContainerEndpoint {
  containerId: string;
  host: string;
  port: number;
}

/**
 * Resolve `osiris-devcontainer+<hash>` to a live VS Code server endpoint: find
 * the container by its hash label, wake it if paused/stopped, and read the port
 * from its port label.
 */
export async function resolveDevContainerEndpoint(
  hash: string,
  exec?: Exec,
): Promise<DevContainerEndpoint> {
  const container = await findByLabel(HASH_LABEL, hash, exec);
  if (!container) {
    throw new Error(`no Osiris DevContainer is registered for hash ${hash}`);
  }

  await wake(container, exec);

  const portLabel = container.labels[PORT_LABEL];
  const port = portLabel === undefined ? Number.NaN : Number(portLabel);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`DevContainer ${container.id} is missing a valid ${PORT_LABEL} label`);
  }

  log.info('resolved %s → 127.0.0.1:%d', hash, port);
  return { containerId: container.id, host: '127.0.0.1', port };
}
