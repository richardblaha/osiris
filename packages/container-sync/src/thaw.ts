import type Docker from 'dockerode';
import { createLogger } from '@osiris/shared-core';
import { pullImage, type RegistryAuth } from './registry.js';

const log = createLogger('container-sync:thaw');

export interface ThawInput {
  imageRef: string;
  /** Named volume to create and populate from the tar. */
  volumeName: string;
  /** Absolute mount path inside the new container. */
  workspaceMountPath: string;
  /** Path `freeze()` reported as `restorePath` (parent of the mount). */
  restorePath: string;
  /** The workspace-volume tar produced by `freeze()`. */
  volumeTar: Buffer | NodeJS.ReadableStream;
  containerName: string;
  labels?: Record<string, string>;
  env?: Record<string, string>;
  registryAuth?: RegistryAuth;
}

export interface ThawResult {
  containerId: string;
}

/**
 * Restore a frozen session on this host: pull the image, recreate the workspace
 * volume from the tar, then create and start the container.
 */
export async function thaw(docker: Docker, input: ThawInput): Promise<ThawResult> {
  await pullImage(docker, input.imageRef, input.registryAuth);

  await docker.createVolume({ Name: input.volumeName, Labels: input.labels });

  log.info('creating %s from %s', input.containerName, input.imageRef);
  const container = await docker.createContainer({
    name: input.containerName,
    Image: input.imageRef,
    Labels: input.labels,
    Env: Object.entries(input.env ?? {}).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      Binds: [`${input.volumeName}:${input.workspaceMountPath}`],
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  await container.putArchive(input.volumeTar, { path: input.restorePath });
  await container.start();

  log.info('thawed session as %s', container.id.slice(0, 12));
  return { containerId: container.id };
}
