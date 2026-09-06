/**
 * OTLP-first OpenTelemetry bootstrap for Osiris Node services.
 *
 * `startTelemetry()` wires traces, metrics and logs to a single OTLP/HTTP
 * endpoint (default `http://localhost:4318`, overridable per environment so the
 * server can point at any enterprise backend). It is idempotent and honours the
 * repo-wide `OSIRIS_TELEMETRY=off` opt-out.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { isTelemetryDisabled, resolveEndpoint } from './env.js';

export interface TelemetryOptions {
  /** `service.name` — the component emitting telemetry, e.g. `osiris-server`. */
  serviceName: string;
  serviceVersion?: string;
  /** OTLP/HTTP base URL. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  endpoint?: string;
  /** Extra resource attributes: `deployment.environment`, `osiris.session.id`, … */
  attributes?: Record<string, string | number | boolean>;
  /** Metric export cadence. Default 15s. */
  metricIntervalMillis?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TelemetryHandle {
  readonly enabled: boolean;
  /** Flush and detach all exporters. Safe to call more than once. */
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TelemetryHandle = {
  enabled: false,
  shutdown: async () => undefined,
};

let active: NodeSDK | undefined;
let signalHooksInstalled = false;

export async function startTelemetry(options: TelemetryOptions): Promise<TelemetryHandle> {
  const env = options.env ?? process.env;
  if (active || isTelemetryDisabled(env)) {
    return NOOP_HANDLE;
  }

  const base = resolveEndpoint(options.endpoint, env);

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? '0.0.0',
      'osiris.component': options.serviceName,
      ...options.attributes,
    }),
  );

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
        exportIntervalMillis: options.metricIntervalMillis ?? 15_000,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${base}/v1/logs` }),
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  active = sdk;

  const handle: TelemetryHandle = {
    enabled: true,
    shutdown: async () => {
      if (!active) return;
      const stopping = active;
      active = undefined;
      await stopping.shutdown();
    },
  };

  installSignalHooks(handle);
  return handle;
}

function installSignalHooks(handle: TelemetryHandle): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void handle.shutdown().finally(() => process.exit(0));
    });
  }
}
