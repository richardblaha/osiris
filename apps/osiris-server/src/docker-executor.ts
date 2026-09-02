import Docker from 'dockerode';
import {
  freeze as freezeSession,
  imageDigest,
  sessionImageRef,
  thaw as thawSession,
} from '@osiris/container-sync';
import { createLogger } from '@osiris/shared-core';
import type { HandoverCommitRequest } from '@osiris/protocol';
import type { HandoverExecutor, VolumeStore } from './executors.js';

const log = createLogger('server:docker-executor');

export interface WebIdeLauncher {
  /** Attach an `openvscode-server` to the thawed container and return its URL. */
  launch(input: { sessionId: string; containerId: string }): Promise<{ webUrl: string }>;
  /** Stop the Web IDE for a session (fetch-to-local teardown). */
  stop(input: { sessionId: string }): Promise<void>;
}

export interface DockerHandoverExecutorOptions {
  volumes: VolumeStore;
  webIde: WebIdeLauncher;
  registryHost: string;
  publicBaseUrl: string;
  docker?: Docker;
  workspaceMountPath?: string;
  thawImpl?: typeof thawSession;
  freezeImpl?: typeof freezeSession;
}

/** Real server-side handover: `@osiris/container-sync` `thaw()` + a Web IDE launcher. */
export class DockerHandoverExecutor implements HandoverExecutor {
  private readonly docker: Docker;
  private readonly mount: string;
  private readonly doThaw: typeof thawSession;
  private readonly doFreeze: typeof freezeSession;

  constructor(private readonly options: DockerHandoverExecutorOptions) {
    this.docker = options.docker ?? new Docker();
    this.mount = options.workspaceMountPath ?? '/workspaces';
    this.doThaw = options.thawImpl ?? thawSession;
    this.doFreeze = options.freezeImpl ?? freezeSession;
  }

  async provision(input: {
    sessionId: string;
    commit: HandoverCommitRequest;
  }): Promise<{ webUrl: string }> {
    const tar = await collect(await this.options.volumes.read(input.sessionId));
    const { containerId } = await this.doThaw(this.docker, {
      imageRef: input.commit.imageRef,
      volumeName: containerName(input.sessionId),
      workspaceMountPath: this.mount,
      restorePath: '/',
      volumeTar: tar,
      containerName: containerName(input.sessionId),
      labels: { 'com.osiris.session': input.sessionId },
      env: { OSIRIS_LOCATION: 'server' },
    });
    log.info('thawed session %s as %s', input.sessionId, containerId.slice(0, 12));
    return this.options.webIde.launch({ sessionId: input.sessionId, containerId });
  }

  async freezeForFetch(input: { sessionId: string }): Promise<{
    imageRef: string;
    imageDigest: string;
    volumeDownloadUrl: string;
  }> {
    const imageRef = sessionImageRef({
      registry: this.options.registryHost,
      workspaceId: input.sessionId,
      sessionId: 'server',
    });
    const frozen = await this.doFreeze(this.docker, {
      containerId: containerName(input.sessionId),
      workspaceMountPath: this.mount,
      imageRef,
    });
    await this.options.volumes.write(input.sessionId, 0, await collect(frozen.volumeTar));
    await this.options.volumes.finalize(input.sessionId);

    return {
      imageRef,
      imageDigest: await imageDigest(this.docker, imageRef).catch(() => frozen.imageDigest),
      volumeDownloadUrl: `${this.options.publicBaseUrl}/api/v1/sessions/${input.sessionId}/volume`,
    };
  }

  async teardown(input: { sessionId: string }): Promise<void> {
    await this.options.webIde.stop(input).catch(() => undefined);
    await this.docker
      .getContainer(containerName(input.sessionId))
      .remove({ force: true })
      .catch(() => undefined);
    await this.options.volumes.discard(input.sessionId);
  }
}

function containerName(sessionId: string): string {
  return `osiris-${sessionId}`;
}

async function collect(source: AsyncIterable<string | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) {
    parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}
