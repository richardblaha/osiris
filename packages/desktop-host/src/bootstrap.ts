import { createLogger } from '@osiris/shared-core';
import { startTelemetry, type TelemetryHandle } from '@osiris/telemetry';
import {
  Orchestrator,
  defaultStack,
  ensureOllamaModel,
  stackModel,
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
  /**
   * Host the shared stack (OTLP collector, Ollama) is reachable at. Defaults to
   * `localhost` for the desktop's own extension host; pass `host.docker.internal`
   * when these endpoints are propagated into a project DevContainer.
   */
  hostGateway?: string;
  stackController?: StackController;
  startTelemetryImpl?: typeof startTelemetry;
  /** Pull the local chat model into Ollama after the stack is up. Default `true`. */
  pullLocalModel?: boolean;
  /** Override the model tag; defaults to the stack's `OSIRIS_LOCAL_MODEL`. */
  localModel?: string;
  /** Injectable for tests. */
  ensureModelImpl?: typeof ensureOllamaModel;
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

  const gateway = options.hostGateway ?? 'localhost';
  const ollamaUrl = options.ollamaUrl ?? `http://${gateway}:11434`;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??= options.otlpEndpoint ?? `http://${gateway}:4318`;
  process.env.OSIRIS_OLLAMA_URL ??= ollamaUrl;
  process.env.OSIRIS_LOCATION ??= 'local';

  const model = options.localModel ?? stackModel(stack);
  if (options.pullLocalModel ?? true) {
    const ensureModel = options.ensureModelImpl ?? ensureOllamaModel;
    try {
      const { pulled } = await ensureModel(model, {
        baseUrl: ollamaUrl,
        onProgress: ({ status, fraction }) =>
          log.info(
            'model %s: %s%s',
            model,
            status,
            fraction !== undefined ? ` ${Math.round(fraction * 100)}%` : '',
          ),
      });
      process.env.OSIRIS_LOCAL_MODEL ??= model;
      log.info('local model %s %s', model, pulled ? 'pulled' : 'present');
    } catch (err) {
      log.warn('local model %s unavailable: %s', model, String(err));
    }
  }

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
