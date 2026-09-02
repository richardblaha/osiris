import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DockerHandoverExecutor, type WebIdeLauncher } from '../src/docker-executor.js';
import { InMemoryVolumeStore } from '../src/executors.js';

const digest = `sha256:${'a'.repeat(64)}`;

function webIde(): WebIdeLauncher & { launched: string[]; stopped: string[] } {
  return {
    launched: [],
    stopped: [],
    async launch({ sessionId, containerId }) {
      this.launched.push(`${sessionId}:${containerId}`);
      return { webUrl: `http://osiris.test/ide/${sessionId}` };
    },
    async stop({ sessionId }) {
      this.stopped.push(sessionId);
    },
  };
}

describe('DockerHandoverExecutor', () => {
  it('provision: reads the volume, thaws, then launches the Web IDE', async () => {
    const volumes = new InMemoryVolumeStore();
    await volumes.write('s1', 0, Buffer.from('tar-bytes'));
    await volumes.finalize('s1');

    const ide = webIde();
    const thawImpl = vi.fn(async () => ({ containerId: 'cabc123' }));

    const executor = new DockerHandoverExecutor({
      volumes,
      webIde: ide,
      registryHost: 'r.osiris',
      publicBaseUrl: 'http://osiris.test',
      thawImpl: thawImpl as never,
    });

    const result = await executor.provision({
      sessionId: 's1',
      commit: {
        imageRef: 'r.osiris/workspaces/s1:local',
        imageDigest: digest,
        volumeDigest: digest,
        agentStateDigest: digest,
        sha256: digest,
      },
    });

    expect(result.webUrl).toBe('http://osiris.test/ide/s1');
    expect(ide.launched).toEqual(['s1:cabc123']);
    expect(thawImpl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ imageRef: 'r.osiris/workspaces/s1:local', containerName: 'osiris-s1' }),
    );
  });

  it('freezeForFetch: freezes, stores the tar for download, returns pull refs', async () => {
    const volumes = new InMemoryVolumeStore();
    const freezeImpl = vi.fn(async () => ({
      imageRef: 'ignored',
      imageDigest: digest,
      volumeTar: Readable.from(Buffer.from('frozen-tar')),
      restorePath: '/',
    }));

    const executor = new DockerHandoverExecutor({
      volumes,
      webIde: webIde(),
      registryHost: 'r.osiris',
      publicBaseUrl: 'http://osiris.test',
      freezeImpl: freezeImpl as never,
    });

    const refs = await executor.freezeForFetch({ sessionId: 's2' });
    expect(refs.imageRef).toBe('r.osiris/workspaces/s2:server');
    expect(refs.volumeDownloadUrl).toBe('http://osiris.test/api/v1/sessions/s2/volume');

    const parts: Buffer[] = [];
    for await (const chunk of await volumes.read('s2')) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString()).toBe('frozen-tar');
  });
});
