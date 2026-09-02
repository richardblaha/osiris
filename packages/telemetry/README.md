# @osiris/telemetry

OTLP-first OpenTelemetry bootstrap for every Osiris Node process — the server,
the orchestrator, the container-sync worker and the agent. One call wires
**traces, metrics and logs** to a single OTLP/HTTP endpoint.

| Export                | Purpose                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| `startTelemetry(opts)`| Start the `NodeSDK` (auto-instrumentations + OTLP exporters). Idempotent. Returns a `{ enabled, shutdown() }` handle and installs `SIGTERM`/`SIGINT` flush hooks. |
| `isTelemetryDisabled` | The `OSIRIS_TELEMETRY=off` check (repo-wide convention).                       |
| `resolveEndpoint`     | Explicit option → `OTEL_EXPORTER_OTLP_ENDPOINT` → `http://localhost:4318`.     |
| `@osiris/telemetry/register` | Side-effecting entry for `node --import`, configured from env only.     |

```ts
import { startTelemetry } from '@osiris/telemetry';

const telemetry = await startTelemetry({
  serviceName: 'osiris-server',
  serviceVersion: process.env.OSIRIS_VERSION,
  attributes: { 'deployment.environment': 'production', 'osiris.location': 'server' },
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, // any enterprise backend
});
// … on shutdown: await telemetry.shutdown();
```

```bash
# instrument a process without touching its code
OTEL_SERVICE_NAME=osiris-web node --import @osiris/telemetry/register ./server/index.mjs
```

`OSIRIS_TELEMETRY=off` forces the no-op path, matching
`@osiris/shared-core`'s telemetry default. Pure ESM, built with `tsc` to `dist/`.
