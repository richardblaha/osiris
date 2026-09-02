# @osiris/orchestrator

The lightweight TypeScript stand-in for the **.NET Aspire AppHost**. One
declarative `StackSpec` describes the local dependency environment; the
`Orchestrator` drives it onto Docker through [`dockerode`](https://github.com/apocas/dockerode).

| Module        | Exports                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `stack.ts`    | `StackSpec`, `ServiceSpec`, `defaultStack()` — collector · dashboard · Ollama · sync worker |
| `runner.ts`   | `Orchestrator` — `up()` / `down()` / `status()` over the Docker engine              |
| `topo.ts`     | `topoSort()` — start-order resolution, fails fast on cycles / unknown deps          |
| `compose.ts`  | `toComposeDocument()` — render the same spec as a `docker compose` file             |

```ts
import { Orchestrator, defaultStack } from '@osiris/orchestrator';

const spec = defaultStack({ dashboard: 'aspire' });
const orchestrator = new Orchestrator();
await orchestrator.up(spec);          // ollama · otel-collector · dashboard · sync-worker
// … wire OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 into the extension host
```

## CLI

```bash
osiris-orchestrator up --dashboard aspire
osiris-orchestrator status
osiris-orchestrator down
```

Telemetry from the orchestrator itself flows through `@opentelemetry/api`; start
`@osiris/telemetry` in the host process to export it.

Pure ESM, built with `tsc` to `dist/`. Tests cover the pure logic (`topo`,
`stack`, `compose`); `runner` needs a live Docker socket and is exercised in the
desktop smoke test.
