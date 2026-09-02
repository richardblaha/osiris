import { createLogger } from '@osiris/shared-core';
import { startTelemetry, type TelemetryHandle } from '@osiris/telemetry';
import {
  Orchestrator,
  defaultStack,
  type DefaultStackOptions,
  type StackSpec,
} from '@osiris/orchestrator';

const log = createLogger('desktop-host');

/** The subset of {@link Orchestrator} the bootstrap drives — injectable for tests. */
export interface StackController {
  up(spec: StackSpec): Promise<void>;
  down(spec: StackSpec): Promise<void>;
}

export interface BootstrapOptions {
  serviceVersion?: string;
  dashboard?: DefaultStackOptions['dashboard'];
  otlpEndpoint?: string;
  ollamaUrl?: string;
  stackController?: StackController;
  startTelemetryImpl?: typeof startTelemetry;
}

export interface OsirisRuntime {
  stack: StackSpec;
  telemetry: TelemetryHandle;
  dispose(): Promise<void>;
}

/**
 * Bring up the local dependency stack and telemetry, and publish the shared
 * endpoints into `process.env` so the extension host inherits them. Call the
 * returned `dispose()` on app quit.
 */
export async function bootstrapOsirisRuntime(options: BootstrapOptions = {}): Promise<OsirisRuntime> {
  const start = options.startTelemetryImpl ?? startTelemetry;
  const telemetry = await start({
    serviceName: 'osiris-desktop',
    serviceVersion: options.serviceVersion,
    endpoint: options.otlpEndpoint,
    attributes: { 'osiris.location': 'local' },
  });

  const stack = defaultStack({ dashboard: options.dashboard ?? 'aspire' });
  const controller = options.stackController ?? new Orchestrator();
  await controller.up(stack);

  const otlp = options.otlpEndpoint ?? 'http://localhost:4318';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= otlp;
  process.env.OSIRIS_OLLAMA_URL ??= options.ollamaUrl ?? 'http://localhost:11434';
  process.env.OSIRIS_LOCATION ??= 'local';

  log.info('osiris runtime up — %d services, telemetry %s', stack.services.length, telemetry.enabled ? 'on' : 'off');

  return {
    stack,
    telemetry,
    dispose: async () => {
      await controller.down(stack).catch((err: unknown) => log.warn('stack down failed: %s', String(err)));
      await telemetry.shutdown();
    },
  };
}
