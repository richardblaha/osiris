# @richardblaha/protocol

The single source of truth for the **Desktop ⇄ Server** wire contract. Every
schema is a [zod](https://zod.dev) object; the matching TypeScript type is
`z.infer`-ed and exported under the same name.

| Module       | Exports                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `session.ts` | `SessionDescriptor`, `SessionLocation` (`local` \| `in-transit` \| `server`), `Lease`, `ContentDigest`, `CreateSessionRequest` |
| `handover.ts`| `HandoverPrepareResponse`, `HandoverCommitRequest`/`Response`, `FetchPrepareResponse`, `TransferProgress`, `TransferPhase` |
| `events.ts`  | `SessionEvent` — the SSE discriminated union (`session.frozen`, `transfer.progress`, `session.resumed`, `lease.expired`) |
| `routes.ts`  | `routes.*` URL builders, `API_BASE`, protocol `headers`                                                             |

```ts
import { SessionDescriptor, routes, headers } from '@richardblaha/protocol';

const res = await fetch(base + routes.handoverPrepare(id), {
  method: 'POST',
  headers: { [headers.lease]: descriptor.lease!.etag },
});
const descriptor = SessionDescriptor.parse(await (await fetch(base + routes.session(id))).json());
```

Consumed by `apps/osiris-server` and `extensions/osiris-workspace`; it is the
root of the Turborepo build graph, so a contract change rebuilds both sides.

Pure ESM, built with `tsc` to `dist/`.
