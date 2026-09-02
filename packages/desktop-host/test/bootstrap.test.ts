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
    const controller = fakeController();
    const shutdown = vi.fn(async () => undefined);

    const runtime = await bootstrapOsirisRuntime({
      stackController: controller,
      startTelemetryImpl: (async () => ({ enabled: true, shutdown })) as never,
      otlpEndpoint: 'http://collector:4318',
    });

    expect(controller.ups).toBe(1);
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://collector:4318');
    expect(process.env.OSIRIS_OLLAMA_URL).toBe('http://localhost:11434');
    expect(runtime.stack.services.length).toBeGreaterThan(0);

    await runtime.dispose();
    expect(controller.downs).toBe(1);
    expect(shutdown).toHaveBeenCalled();
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
    });
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalled();
  });
});
