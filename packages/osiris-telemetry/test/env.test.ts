import { describe, expect, it } from 'vitest';
import { isTelemetryDisabled, normalizeOtlpEndpoint, resolveEndpoint } from '../src/env.js';

describe('isTelemetryDisabled', () => {
  it('detects the opt-out values regardless of case/whitespace', () => {
    for (const value of ['off', '0', ' FALSE ', 'no', 'disabled']) {
      expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: value })).toBe(true);
    }
  });

  it('is enabled by default and for other values', () => {
    expect(isTelemetryDisabled({})).toBe(false);
    expect(isTelemetryDisabled({ OSIRIS_TELEMETRY: 'on' })).toBe(false);
  });
});

describe('normalizeOtlpEndpoint', () => {
  it('strips trailing slashes and an accidental signal suffix', () => {
    expect(normalizeOtlpEndpoint('http://localhost:4318/')).toBe('http://localhost:4318');
    expect(normalizeOtlpEndpoint('http://collector:4318/v1/traces')).toBe('http://collector:4318');
  });
});

describe('resolveEndpoint', () => {
  it('prefers the explicit value, then the env var, then the default', () => {
    expect(resolveEndpoint('http://explicit:4318', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env:4318' })).toBe(
      'http://explicit:4318',
    );
    expect(resolveEndpoint(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env:4318' })).toBe(
      'http://env:4318',
    );
    expect(resolveEndpoint(undefined, {})).toBe('http://localhost:4318');
  });
});
