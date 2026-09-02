import { describe, expect, it } from 'vitest';
import { startTelemetry } from '../src/node.js';

describe('startTelemetry', () => {
  it('returns a disabled no-op handle when OSIRIS_TELEMETRY is off', async () => {
    const handle = await startTelemetry({
      serviceName: 'test',
      env: { OSIRIS_TELEMETRY: 'off' },
    });
    expect(handle.enabled).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
