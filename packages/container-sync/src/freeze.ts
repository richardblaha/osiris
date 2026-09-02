import { posix } from 'node:path';
import type Docker from 'dockerode';
import { createLogger } from '@osiris/shared-core';
import { parseImageRef } from './image-ref.js';
import { imageDigest, pushImage, type RegistryAuth } from './registry.js';

const log = createLogger('container-sync:freeze');

export interface FreezeInput {
  containerId: string;
  /** Absolute mount path of the workspace volume inside the container. */
  workspaceMountPath: string;
  /** Target ref, e.g. `registry.osiris.internal/workspaces/ws1:s1`. */
  imageRef: string;
  registryAuth?: RegistryAuth;
  /** Persist agent state into the volume before the freeze (WAL checkpoint etc.). */
  snapshot?: () => Promise<void>;
}

export interface FreezeResult {
  imageRef: string;
  imageDigest: string;
  /** Tar of `workspaceMountPath`; hash it while uploading to get `volumeDigest`. */
  volumeTar: NodeJS.ReadableStream;
  /** Path to pass to `putArchive` on the far side. */
  restorePath: string;
}

/**
 * Freeze a running session: snapshot the agent, pause the process tree, commit
 * and push the container image, and open a tar stream of the workspace volume
 * (volumes are excluded from `commit`, so they travel separately).
 *
 * On any failure before the caller commits the handover, call
 * {@link thawInPlace} to `unpause` and carry on locally.
 */
export async function freeze(docker: Docker, input: FreezeInput): Promise<FreezeResult> {
  const container = docker.getContainer(input.containerId);

  if (input.snapshot) {
    log.info('snapshotting agent state');
    await input.snapshot();
  }

  log.info('pausing %s', input.containerId.slice(0, 12));
  await container.pause();

  const { registry, repository, tag } = parseImageRef(input.imageRef);
  const repo = registry ? `${registry}/${repository}` : repository;
  log.info('committing → %s', input.imageRef);
  await container.commit({ repo, tag, pause: false });

  await pushImage(docker, input.imageRef, input.registryAuth);

  const volumeTar = await container.getArchive({ path: input.workspaceMountPath });

  return {
    imageRef: input.imageRef,
    imageDigest: await imageDigest(docker, input.imageRef),
    volumeTar,
    restorePath: posix.dirname(input.workspaceMountPath),
  };
}

/** Roll a freeze back: unpause the still-local container. */
export async function thawInPlace(docker: Docker, containerId: string): Promise<void> {
  await docker.getContainer(containerId).unpause();
}
