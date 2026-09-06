/**
 * Telemetry abstraction. Osiris ships **no** telemetry backend by default — the
 * factory returns a no-op reporter unless a host explicitly provides one, and
 * `OSIRIS_TELEMETRY=off` forces the no-op regardless.
 */

export interface TelemetryEvent {
  name: string;
  properties?: Record<string, string | number | boolean | undefined>;
  measurements?: Record<string, number>;
}

export interface TelemetryReporter {
  readonly enabled: boolean;
  event(event: TelemetryEvent): void;
  exception(error: Error, properties?: TelemetryEvent['properties']): void;
  flush(): Promise<void>;
  dispose(): void;
}

export class NoopTelemetryReporter implements TelemetryReporter {
  readonly enabled = false;
  event(): void {}
  exception(): void {}
  async flush(): Promise<void> {}
  dispose(): void {}
}

export class ConsoleTelemetryReporter implements TelemetryReporter {
  readonly enabled = true;

  event(event: TelemetryEvent): void {
    console.error('[osiris:telemetry] event', JSON.stringify(event));
  }

  exception(error: Error, properties?: TelemetryEvent['properties']): void {
    console.error('[osiris:telemetry] exception', error.message, properties ?? {});
  }

  async flush(): Promise<void> {}
  dispose(): void {}
}

export interface TelemetryEnv {
  /** Usually `process.env`. */
  readonly OSIRIS_TELEMETRY?: string;
}

export interface CreateTelemetryOptions {
  env?: TelemetryEnv;
  /** A host-supplied reporter (e.g. wrapping VS Code's `TelemetryLogger`). */
  reporter?: TelemetryReporter;
  /** Force the console reporter when no host reporter is supplied (dev only). */
  debug?: boolean;
}

const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disabled']);

export function isTelemetryDisabled(env: TelemetryEnv = {}): boolean {
  const raw = (env.OSIRIS_TELEMETRY ?? '').trim().toLowerCase();
  return OFF_VALUES.has(raw);
}

export function createTelemetry(options: CreateTelemetryOptions = {}): TelemetryReporter {
  if (isTelemetryDisabled(options.env)) {
    return new NoopTelemetryReporter();
  }
  if (options.reporter) {
    return options.reporter;
  }
  if (options.debug) {
    return new ConsoleTelemetryReporter();
  }
  return new NoopTelemetryReporter();
}
