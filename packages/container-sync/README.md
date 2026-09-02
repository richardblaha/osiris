# @osiris/container-sync

Container mobility for the **session handover** protocol: DevContainer
lifecycle, freeze/thaw of a running session, image commit/push and workspace-
volume transfer. Wire types come from [`@osiris/protocol`](../protocol).

| Module           | Exports                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| `devcontainer.ts`| `ensureDevContainer()` (`devcontainer up` + Osiris id-labels), `resolveByHash()` (find + unpause + endpoint), `parseDevContainerUp()` |
| `hash.ts`        | `devcontainerHash()` / `hashHostPath()` — the stable `sha256(path)[0..12]` key    |
| `freeze.ts`      | `freeze()` — snapshot → `pause` → `commit` → `push` → volume tar; `thawInPlace()` rollback |
| `thaw.ts`        | `thaw()` — `pull` → recreate volume from tar → `create` + `start`                 |
| `registry.ts`    | `pushImage()` / `pullImage()` / `imageDigest()` over the internal OCI registry     |
| `digest.ts`      | `sha256Digest()`, `createDigestingStream()` — `ContentDigest` for the volume tar  |

```ts
import Docker from 'dockerode';
import { freeze, thawInPlace, sessionImageRef } from '@osiris/container-sync';

const docker = new Docker();
try {
  const frozen = await freeze(docker, {
    containerId,
    workspaceMountPath: '/workspaces',
    imageRef: sessionImageRef({ registry, workspaceId, sessionId }),
    snapshot: () => session.persist(),          // @osiris/agent-core
  });
  // stream frozen.volumeTar to the server's resumable upload, hashing as you go
} catch (err) {
  await thawInPlace(docker, containerId);        // roll back, keep running locally
  throw err;
}
```

The Docker-touching functions require a live Docker socket and are exercised in
the desktop smoke test; unit tests cover the pure helpers (`image-ref`, `hash`,
`digest`, `parseDevContainerUp`). Pure ESM, `tsc` to `dist/`.
