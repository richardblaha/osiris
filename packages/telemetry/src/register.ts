/**
 * Side-effecting entrypoint for `node --import @richardblaha/telemetry/register`.
 * Reads configuration entirely from the environment so no code change is needed
 * in the process being instrumented (upstream server, workers, …).
 *
 *   OTEL_SERVICE_NAME=osiris-server \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   node --import @richardblaha/telemetry/register ./server.js
 */
import { startTelemetry } from './node.js';

await startTelemetry({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'osiris-service',
  serviceVersion: process.env.OSIRIS_VERSION,
  attributes: {
    'osiris.location': process.env.OSIRIS_LOCATION ?? 'local',
  },
});
