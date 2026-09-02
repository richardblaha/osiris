/**
 * Pure configuration helpers — no OpenTelemetry imports, so this module stays
 * cheap to load and easy to test.
 */

/** Values of `OSIRIS_TELEMETRY` that force the no-op path (repo-wide convention). */
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disabled']);

export function isTelemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return OFF_VALUES.has((env.OSIRIS_TELEMETRY ?? '').trim().toLowerCase());
}

/**
 * Reduce any OTLP endpoint the user might supply to a clean base URL:
 * strips a trailing slash and an accidental `/v1/{traces,metrics,logs}` suffix.
 */
export function normalizeOtlpEndpoint(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/v1\/(?:traces|metrics|logs)$/, '');
}

export function resolveEndpoint(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return normalizeOtlpEndpoint(
    explicit ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  );
}
