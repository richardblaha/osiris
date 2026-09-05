import { setTimeout as sleep } from 'node:timers/promises';
import Docker from 'dockerode';
import { createLogger } from '@richardblaha/shared-core';
import { topoSort } from './topo.js';
import type { HealthCheck, ServiceSpec, StackSpec } from './stack.js';

const log = createLogger('orchestrator');

const PROJECT_LABEL = 'com.osiris.project';
const SERVICE_LABEL = 'com.osiris.service';

export interface OrchestratorOptions {
  docker?: Docker;
}

export interface ServiceStatus {
  service: string;
  state: string;
  status: string;
}

/**
 * Drives a {@link StackSpec} onto the local Docker engine. Idempotent: `up`
 * recreates each service, `down` removes everything carrying the project label.
 */
export class Orchestrator {
  private readonly docker: Docker;

  constructor(options: OrchestratorOptions = {}) {
    this.docker = options.docker ?? new Docker();
  }

  async up(spec: StackSpec): Promise<void> {
    await this.ensureNetwork(spec.network);
    for (const svc of topoSort(spec.services)) {
      await this.startService(spec, svc);
    }
    log.info('stack "%s" is up (%d services)', spec.project, spec.services.length);
  }

  async down(spec: StackSpec): Promise<void> {
    const containers = await this.listProject(spec);
    await Promise.all(
      containers.map((info) =>
        this.docker
          .getContainer(info.Id)
          .remove({ force: true })
          .catch(() => undefined),
      ),
    );
    log.info('stack "%s" is down', spec.project);
  }

  async status(spec: StackSpec): Promise<ServiceStatus[]> {
    const containers = await this.listProject(spec);
    return containers.map((info) => ({
      service: info.Labels[SERVICE_LABEL] ?? '(unknown)',
      state: info.State,
      status: info.Status,
    }));
  }

  private listProject(spec: StackSpec): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${PROJECT_LABEL}=${spec.project}`] }),
    });
  }

  private async ensureNetwork(name: string): Promise<void> {
    const existing = await this.docker.listNetworks({
      filters: JSON.stringify({ name: [name] }),
    });
    if (!existing.some((net) => net.Name === name)) {
      log.info('creating network %s', name);
      await this.docker.createNetwork({ Name: name, Driver: 'bridge' });
    }
  }

  private async startService(spec: StackSpec, svc: ServiceSpec): Promise<void> {
    const containerName = `${spec.project}-${svc.name}`;
    await this.docker
      .getContainer(containerName)
      .remove({ force: true })
      .catch(() => undefined);

    await this.pull(svc.image);
    log.info('starting %s (%s)', containerName, svc.image);

    const container = await this.docker.createContainer({
      name: containerName,
      Image: svc.image,
      Cmd: svc.cmd,
      Env: Object.entries(svc.env ?? {}).map(([key, value]) => `${key}=${value}`),
      Labels: {
        [PROJECT_LABEL]: spec.project,
        [SERVICE_LABEL]: svc.name,
      },
      HostConfig: {
        NetworkMode: spec.network,
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: (svc.volumes ?? []).map((mount) => `${mount.source}:${mount.target}`),
        PortBindings: Object.fromEntries(
          (svc.ports ?? []).map((port) => [
            `${port.container}/tcp`,
            [{ HostPort: String(port.host) }],
          ]),
        ),
      },
    });

    await container.start();
    if (svc.health?.url) {
      await this.waitHealthy(containerName, svc.health);
    }
  }

  private async pull(image: string): Promise<void> {
    const stream = (await this.docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  private async waitHealthy(containerName: string, health: HealthCheck): Promise<void> {
    const retries = health.retries ?? 20;
    const intervalMs = health.intervalMs ?? 1500;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (health.url) {
          const res = await fetch(health.url);
          if (res.ok) return;
        }
      } catch (error) {
        log.debug('%s not healthy yet (attempt %d): %s', containerName, attempt, String(error));
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `service ${containerName} did not pass its health check after ${retries} attempts`,
    );
  }
}
