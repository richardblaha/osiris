# @osiris/shared-core

Shared, runtime-light building blocks used by the Osiris extensions and apps.

| Module         | Exports                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `result.ts`    | `Result<T,E>`, `ok`, `err`, `isOk`, `unwrap`, `mapResult`                                                   |
| `logger.ts`    | `createLogger(scope)` — leveled logger with an `[osiris:…]` prefix                                          |
| `events.ts`    | `EventBus<TMap>`, the `OsirisEvents` channel map                                                            |
| `telemetry.ts` | `TelemetryReporter`, `createTelemetry()` (no-op unless a host opts in; `OSIRIS_TELEMETRY=off` forces no-op) |
| `types.ts`     | Domain types for `osiris-ai`, `osiris-dexpi`, `osiris-step`                                                 |

```ts
import { createLogger, EventBus, type OsirisEvents } from '@osiris/shared-core';

const log = createLogger('dexpi');
const bus = new EventBus<OsirisEvents>();
bus.on('osiris:dexpi:parsed', (e) => log.info('parsed %s equipment', e.equipmentCount));
```

Pure ESM, built with `tsc` to `dist/`.
