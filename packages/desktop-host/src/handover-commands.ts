import { createHash } from 'node:crypto';
import Docker from 'dockerode';
import { createLogger } from '@osiris/shared-core';
import {
  HandoverClient,
  type FetchPrepareResponse,
  type HandoverPrepareResponse,
} from '@osiris/protocol';
import {
  ensureDevContainer,
  freeze as freezeSession,
  thaw as thawSession,
  thawInPlace,
  uploadVolumeResumable,
} from '@osiris/container-sync';

const log = createLogger('desktop-host:handover');

const DEFAULT_MOUNT = '/workspaces';

export interface DesktopHandoverDeps {
  server: { baseUrl: string; token: string; registryHost: string };
  docker?: Docker;
  workspaceMountPath?: string;
  serverPort?: number;
  /** Persist agent state into the volume just before the freeze. */
  snapshotAgent?: () => Promise<void>;
  makeClient?: (baseUrl: string, token: string) => HandoverClient;
  freezeImpl?: typeof freezeSession;
  thawImpl?: typeof thawSession;
  ensureDevContainerImpl?: typeof ensureDevContainer;
  uploadVolume?: (url: string, token: string, tar: NodeJS.ReadableStream) => Promise<{ sha256: string }>;
  downloadVolume?: (url: string, token: string) => Promise<Buffer>;
}

export type CommandHandlers = Record<string, (payload: unknown) => Promise<unknown>>;

/**
 * The `osiris.desktop.*` command handlers the `osiris-workspace` extension
 * delegates Docker-heavy work to. Register each into `vscode.commands`.
 */
export function createDesktopHandoverCommands(deps: DesktopHandoverDeps): CommandHandlers {
  const docker = deps.docker ?? new Docker();
  const mount = deps.workspaceMountPath ?? DEFAULT_MOUNT;
  const doFreeze = deps.freezeImpl ?? freezeSession;
  const doThaw = deps.thawImpl ?? thawSession;
  const doEnsure = deps.ensureDevContainerImpl ?? ensureDevContainer;
  const upload = deps.uploadVolume ?? defaultUploadVolume;
  const download = deps.downloadVolume ?? defaultDownloadVolume;
  const client = (): HandoverClient =>
    (deps.makeClient ?? ((baseUrl, token) => new HandoverClient({ baseUrl, token })))(
      deps.server.baseUrl,
      deps.server.token,
    );

  return {
    'osiris.desktop.ensureDevContainer': async (payload) => {
      const { hostPath, serverPort } = payload as { hostPath: string; serverPort?: number };
      const handle = await doEnsure({ hostPath, serverPort: serverPort ?? deps.serverPort ?? 8000 });
      return { hash: handle.hash, containerId: handle.containerId };
    },

    'osiris.desktop.performHandover': async (payload) => {
      const { sessionId, prepare, containerId } = payload as {
        sessionId: string;
        prepare: HandoverPrepareResponse;
        containerId: string;
      };
      const imageRef = `${deps.server.registryHost}/workspaces/${sessionId}:local`;

      try {
        const frozen = await doFreeze(docker, {
          containerId,
          workspaceMountPath: mount,
          imageRef,
          snapshot: deps.snapshotAgent,
        });
        const { sha256 } = await upload(prepare.volumeUploadUrl, deps.server.token, frozen.volumeTar);

        const result = await client().commitHandover(
          sessionId,
          {
            imageRef,
            imageDigest: frozen.imageDigest,
            volumeDigest: sha256,
            agentStateDigest: sha256,
            sha256,
          },
          `handover-${sessionId}`,
        );
        return { webUrl: result.webUrl };
      } catch (err) {
        log.warn('handover failed, rolling back: %s', String(err));
        await thawInPlace(docker, containerId).catch(() => undefined);
        await client().abortHandover(sessionId).catch(() => undefined);
        throw err;
      }
    },

    'osiris.desktop.performFetch': async (payload) => {
      const { sessionId, prepare } = payload as { sessionId: string; prepare: FetchPrepareResponse };
      const tar = await download(prepare.volumeDownloadUrl, deps.server.token);

      await doThaw(docker, {
        imageRef: prepare.imageRef,
        volumeName: `osiris-${sessionId}`,
        workspaceMountPath: mount,
        restorePath: '/',
        volumeTar: tar,
        containerName: `osiris-${sessionId}`,
        labels: { 'com.osiris.session': sessionId },
      });

      const digest = `sha256:${createHash('sha256').update(tar).digest('hex')}`;
      await client().commitFetch(sessionId, { volumeDigest: digest, agentStateDigest: digest });
      return { ok: true };
    },
  };
}

async function defaultUploadVolume(
  url: string,
  token: string,
  tar: NodeJS.ReadableStream,
): Promise<{ sha256: string }> {
  const { sha256 } = await uploadVolumeResumable(url, tar, { token });
  return { sha256 };
}

async function defaultDownloadVolume(url: string, token: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`volume download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
