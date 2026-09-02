import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapOsirisRuntime, type StackController } from '../src/bootstrap.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

function fakeController(): StackController & { ups: number; downs: number } {
  return {
    ups: 0,
    downs: 0,
    async up() {
      this.ups++;
    },
    async down() {
      this.downs++;
    },
  };
}

describe('bootstrapOsirisRuntime', () => {
  it('starts telemetry, brings the stack up and publishes endpoints', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OSIRIS_OLLAMA_URL;
    delete process.env.OSIRIS_LOCAL_MODEL;
    const controller = fakeController();
    const shutdown = vi.fn(async () => undefined);
    const ensureModelImpl = vi.fn(async () => ({ pulled: true }));

    const runtime = await bootstrapOsirisRuntime({
      stackController: controller,
      startTelemetryImpl: (async () => ({ enabled: true, shutdown })) as never,
      otlpEndpoint: 'http://collector:4318',
      ensureModelImpl,
    });

    expect(controller.ups).toBe(1);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    expect(process.env.OSIRIS_OLLAMA_URL).toBe('http://localhost:11434');
    expect(ensureModelImpl).toHaveBeenCalledWith(
      'qwen3:4b',
      expect.objectContaining({ baseUrl: 'http://localhost:11434' }),
    );
    expect(process.env.OSIRIS_LOCAL_MODEL).toBe('qwen3:4b');
    expect(runtime.stack.services.length).toBeGreaterThan(0);

    await runtime.dispose();
    expect(controller.downs).toBe(1);
    expect(shutdown).toHaveBeenCalled();
  });

  it('hostGateway rewrites the default OTLP + Ollama endpoints', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OSIRIS_OLLAMA_URL;
    await bootstrapOsirisRuntime({
      stackController: fakeController(),
      startTelemetryImpl: (async () => ({ enabled: false, shutdown: async () => undefined })) as never,
      hostGateway: 'host.docker.internal',
      ensureModelImpl: vi.fn(async () => ({ pulled: false })),
    });
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://host.docker.internal:4318');
    expect(process.env.OSIRIS_OLLAMA_URL).toBe('http://host.docker.internal:11434');
  });

  it('a failed model pull does not abort bootstrap', async () => {
    const runtime = await bootstrapOsirisRuntime({
      stackController: fakeController(),
      startTelemetryImpl: (async () => ({ enabled: false, shutdown: async () => undefined })) as never,
      ensureModelImpl: vi.fn(async () => {
        throw new Error('ollama unreachable');
      }),
    });
    expect(runtime.stack.services.length).toBeGreaterThan(0);
  });

  it('pullLocalModel:false skips the model pull entirely', async () => {
    const ensureModelImpl = vi.fn(async () => ({ pulled: false }));
    await bootstrapOsirisRuntime({
      stackController: fakeController(),
      startTelemetryImpl: (async () => ({ enabled: false, shutdown: async () => undefined })) as never,
      pullLocalModel: false,
      ensureModelImpl,
    });
    expect(ensureModelImpl).not.toHaveBeenCalled();
  });

  it('dispose still shuts telemetry down if the stack fails to stop', async () => {
    const shutdown = vi.fn(async () => undefined);
    const runtime = await bootstrapOsirisRuntime({
      stackController: {
        async up() {},
        async down() {
          throw new Error('docker gone');
        },
      },
      startTelemetryImpl: (async () => ({ enabled: false, shutdown })) as never,
      ensureModelImpl: vi.fn(async () => ({ pulled: false })),
    });
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalled();
  });
});
