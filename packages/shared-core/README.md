# @osiris/shared-core

Shared, runtime-light building blocks used by the Osiris extensions and apps.

| Module         | Exports                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `result.ts`    | `Result<T,E>`, `ok`, `err`, `isOk`, `unwrap`, `mapResult`                                                   |
| `logger.ts`    | `createLogger(scope)` — leveled logger with an `[osiris:…]` prefix                                          |
| `events.ts`    | `EventBus<TMap>`, the `OsirisEvents` channel map                                                            |
| `telemetry.ts` | `TelemetryReporter`, `createTelemetry()` (no-op unless a host opts in; `OSIRIS_TELEMETRY=off` forces no-op) |
| `types.ts`     | Domain types for `osiris-ai` (agent descriptors, run options)                                               |

```ts
import { createLogger, EventBus, type OsirisEvents } from '@osiris/shared-core';

const log = createLogger('agent');
const bus = new EventBus<OsirisEvents>();
bus.on('osiris:agent:run-finished', (e) => log.info('run %s ok=%s', e.runId, e.ok));
```

Pure ESM, built with `tsc` to `dist/`.
