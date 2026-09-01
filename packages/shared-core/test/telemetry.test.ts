import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleTelemetryReporter,
  NoopTelemetryReporter,
  createTelemetry,
  isTelemetryDisabled,
} from '../src/telemetry.js';

describe('telemetry', () => {
  it('detects the opt-out env values', () => {
    expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: 'off' })).toBe(true);
    expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: '0' })).toBe(true);
    expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: 'FALSE' })).toBe(true);
    expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: 'on' })).toBe(false);
    expect(isTelemetryDisabled({})).toBe(false);
  });

  it('createTelemetry returns noop by default', () => {
    expect(createTelemetry()).toBeInstanceOf(NoopTelemetryReporter);
  });

  it('createTelemetry honours the opt-out even with a reporter supplied', () => {
    const reporter = new ConsoleTelemetryReporter();
    const result = createTelemetry({ env: { OSIRIS_TELEMETRY: 'off' }, reporter });
    expect(result).toBeInstanceOf(NoopTelemetryReporter);
  });

  it('createTelemetry returns the console reporter in debug mode', () => {
    expect(createTelemetry({ debug: true })).toBeInstanceOf(ConsoleTelemetryReporter);
  });

  it('console reporter writes events to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new ConsoleTelemetryReporter().event({ name: 'test' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
