/**
 * A `StackSpec` is the whole declaration of a local dependency environment — the
 * TypeScript analogue of an Aspire AppHost's `builder.AddContainer(...)` calls.
 * The same value drives {@link Orchestrator} (dockerode) and
 * {@link toComposeDocument} (a plain `docker compose` file).
 */

import { DEFAULT_LOCAL_EMBED_MODEL, DEFAULT_LOCAL_MODEL, DEFAULT_OLLAMA_IMAGE } from './ollama.js';

export interface PortMapping {
  host: number;
  container: number;
}

export interface VolumeMount {
  /** Named volume or host path. */
  source: string;
  target: string;
}

export interface HealthCheck {
  /** Polled from the host until it responds `2xx`. */
  url?: string;
  retries?: number;
  intervalMs?: number;
}

export interface ServiceSpec {
  name: string;
  image: string;
  cmd?: string[];
  env?: Record<string, string>;
  ports?: PortMapping[];
  volumes?: VolumeMount[];
  health?: HealthCheck;
  /** Names of services that must be started first. */
  dependsOn?: string[];
}

export interface StackSpec {
  /** Container-name prefix + `com.osiris.project` label + compose project name. */
  project: string;
  /** Shared bridge network every service joins. */
  network: string;
  services: ServiceSpec[];
}

export interface DefaultStackOptions {
  /** Local trace/metric UI. `aspire` (default) understands metrics too. */
  dashboard?: 'aspire' | 'jaeger';
  ollamaImage?: string;
  syncWorkerImage?: string;
  /**
   * Chat model to auto-pull into Ollama once the stack is healthy (see
   * {@link ensureOllamaModel}). Recorded on the `ollama` service as
   * `OSIRIS_LOCAL_MODEL`; read it back with {@link stackModel}.
   */
  model?: string;
  /**
   * Embedding model to auto-pull. Defaults to {@link DEFAULT_LOCAL_EMBED_MODEL};
   * pass `null` or `''` to skip it. Recorded as `OSIRIS_LOCAL_EMBED_MODEL`;
   * read it back with {@link stackEmbedModel}.
   */
  embedModel?: string | null;
}

const OTLP_ENDPOINT = 'http://otel-collector:4318';

/**
 * The stack the Osiris desktop brings up on launch: an OTLP collector, a
 * dashboard, Ollama for local inference and the container-sync worker.
 */
export function defaultStack(options: DefaultStackOptions = {}): StackSpec {
  const dashboard: ServiceSpec =
    options.dashboard === 'jaeger'
      ? {
          name: 'otel-dashboard',
          image: 'jaegertracing/all-in-one:1.60',
          env: { COLLECTOR_OTLP_ENABLED: 'true' },
          ports: [{ host: 16686, container: 16686 }],
        }
      : {
          name: 'otel-dashboard',
          image: 'mcr.microsoft.com/dotnet/aspire-dashboard:9.0',
          env: { DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: 'true' },
          ports: [{ host: 18888, container: 18888 }],
        };

  return {
    project: 'osiris',
    network: 'osiris-net',
    services: [
      {
        name: 'otel-collector',
        image: 'otel/opentelemetry-collector-contrib:0.109.0',
        cmd: ['--config=/etc/otelcol/config.yaml'],
        volumes: [{ source: 'osiris-otelcol', target: '/etc/otelcol' }],
        ports: [
          { host: 4317, container: 4317 },
          { host: 4318, container: 4318 },
        ],
      },
      dashboard,
      {
        name: 'ollama',
        image: options.ollamaImage ?? DEFAULT_OLLAMA_IMAGE,
        env: {
          OSIRIS_LOCAL_MODEL: options.model ?? DEFAULT_LOCAL_MODEL,
          OSIRIS_LOCAL_EMBED_MODEL:
            options.embedModel === null ? '' : (options.embedModel ?? DEFAULT_LOCAL_EMBED_MODEL),
        },
        ports: [{ host: 11434, container: 11434 }],
        volumes: [{ source: 'osiris-ollama', target: '/root/.ollama' }],
        health: { url: 'http://localhost:11434/api/tags', retries: 30, intervalMs: 2000 },
      },
      {
        // Built from packages/container-sync; see the architecture spec.
        name: 'sync-worker',
        image: options.syncWorkerImage ?? 'osiris/container-sync-worker:0.1.0',
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT },
        dependsOn: ['otel-collector'],
      },
    ],
  };
}

/**
 * The chat model recorded on a stack's `ollama` service by {@link defaultStack}.
 * Falls back to {@link DEFAULT_LOCAL_MODEL} for hand-built specs.
 */
export function stackModel(spec: StackSpec): string {
  const ollama = spec.services.find((svc) => svc.name === 'ollama');
  return ollama?.env?.OSIRIS_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL;
}

/**
 * The embedding model recorded on a stack's `ollama` service, or `undefined`
 * when embeddings were disabled with `defaultStack({ embedModel: null })`.
 */
export function stackEmbedModel(spec: StackSpec): string | undefined {
  const ollama = spec.services.find((svc) => svc.name === 'ollama');
  return ollama?.env?.OSIRIS_LOCAL_EMBED_MODEL || undefined;
}
