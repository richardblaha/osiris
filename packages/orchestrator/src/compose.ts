import type { StackSpec } from './stack.js';

/**
 * Render a {@link StackSpec} as a Docker Compose document (Compose Spec shape).
 * Serialize with `yaml` / `JSON.stringify` and run
 * `docker compose -p <project> -f - up -d` for environments where talking to the
 * Docker socket from Node isn't an option.
 */
export function toComposeDocument(spec: StackSpec): ComposeDocument {
  const services: Record<string, ComposeService> = {};
  const volumes: Record<string, Record<string, never>> = {};

  for (const svc of spec.services) {
    for (const mount of svc.volumes ?? []) {
      volumes[mount.source] = {};
    }
    services[svc.name] = {
      image: svc.image,
      networks: [spec.network],
      restart: 'unless-stopped',
      ...(svc.cmd ? { command: svc.cmd } : {}),
      ...(svc.env ? { environment: svc.env } : {}),
      ...(svc.ports?.length
        ? { ports: svc.ports.map((p) => `${p.host}:${p.container}`) }
        : {}),
      ...(svc.volumes?.length
        ? { volumes: svc.volumes.map((m) => `${m.source}:${m.target}`) }
        : {}),
      ...(svc.dependsOn?.length ? { depends_on: svc.dependsOn } : {}),
    };
  }

  return {
    name: spec.project,
    services,
    networks: { [spec.network]: { driver: 'bridge' } },
    ...(Object.keys(volumes).length > 0 ? { volumes } : {}),
  };
}

export interface ComposeService {
  image: string;
  networks: string[];
  restart: string;
  command?: string[];
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  depends_on?: string[];
}

export interface ComposeDocument {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { driver: string }>;
  volumes?: Record<string, Record<string, never>>;
}
