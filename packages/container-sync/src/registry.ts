import type Docker from 'dockerode';
import { createLogger } from '@osiris/shared-core';
import { followProgress } from './docker-progress.js';

const log = createLogger('container-sync:registry');

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

/** `docker push` of a fully-qualified image ref to the internal OCI registry. */
export async function pushImage(
  docker: Docker,
  imageRef: string,
  auth?: RegistryAuth,
): Promise<void> {
  log.info('pushing %s', imageRef);
  const image = docker.getImage(imageRef);
  const stream = await image.push({}, undefined, auth);
  await followProgress(docker, stream);
}

/** `docker pull` of a fully-qualified image ref. */
export async function pullImage(
  docker: Docker,
  imageRef: string,
  auth?: RegistryAuth,
): Promise<void> {
  log.info('pulling %s', imageRef);
  const stream = await docker.pull(imageRef, auth ? { authconfig: auth } : {});
  await followProgress(docker, stream);
}

/** The image's content digest (`sha256:…`) after a commit or pull. */
export async function imageDigest(docker: Docker, imageRef: string): Promise<string> {
  const info = (await docker.getImage(imageRef).inspect()) as { Id: string };
  return info.Id;
}
