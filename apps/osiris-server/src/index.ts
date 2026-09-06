#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoordinationV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import { startTelemetry } from '@richardblaha/osiris-telemetry';
import { createLogger } from '@richardblaha/osiris-core';
import { buildServer } from './app.js';
import { InMemorySessionStore } from './session-store.js';
import { StubSessionExecutor, type SessionExecutor } from './executors.js';
import { KubernetesSessionExecutor } from './kubernetes-executor.js';
import { startSessionWatch } from './k8s-session-watch.js';
import { createWorkspaceConsoleDeps, resolveWorkspaceRoot } from './console-workspace.js';

const log = createLogger('server');

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
}

/** Build the Kubernetes-backed executor + start its informer, or fall back to the stub. */
function setupSessionExecutor(
  store: InMemorySessionStore,
): { executor: SessionExecutor; stop?: () => Promise<void> } {
  const namespace = process.env.OSIRIS_K8S_NAMESPACE;
  if (!namespace) {
    log.warn('OSIRIS_K8S_NAMESPACE is unset — sessions run against an in-memory stub, not osiris-kind');
    return { executor: new StubSessionExecutor() };
  }

  const kubeConfig = new KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kubeConfig.loadFromCluster();
  } else {
    kubeConfig.loadFromDefault();
  }
  const customObjectsApi = kubeConfig.makeApiClient(CustomObjectsApi);
  const coordinationApi = kubeConfig.makeApiClient(CoordinationV1Api);

  const executor = new KubernetesSessionExecutor({ namespace, customObjectsApi, coordinationApi });
  const watch = startSessionWatch(kubeConfig, customObjectsApi, namespace, store);
  log.info('sessions backed by osiris-kind-operator (namespace %s)', namespace);
  return { executor, stop: watch.stop };
}

async function main(): Promise<void> {
  const telemetry = await startTelemetry({
    serviceName: 'osiris-server',
    serviceVersion: process.env.OSIRIS_VERSION,
    attributes: { 'osiris.location': 'server' },
  });

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const publicBaseUrl = process.env.OSIRIS_PUBLIC_URL ?? `http://localhost:${port}`;
  const token = process.env.OSIRIS_SERVER_TOKEN ?? '';

  if (!token) {
    log.warn('OSIRIS_SERVER_TOKEN is unset — the API is running without authentication');
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const consoleEnabled =
    process.env.OSIRIS_CONSOLE !== '0' &&
    (process.env.OSIRIS_WORKSPACE_ROOT !== undefined || existsSync(join(workspaceRoot, '.osiris')));
  if (consoleEnabled) {
    log.info('console API enabled for workspace %s', workspaceRoot);
  }

  const store = new InMemorySessionStore();
  const { executor, stop: stopSessionWatch } = setupSessionExecutor(store);

  const app = buildServer({
    token,
    publicBaseUrl,
    store,
    executor,
    gitReposDir: process.env.OSIRIS_GIT_REPOS_DIR,
    console: consoleEnabled ? createWorkspaceConsoleDeps(workspaceRoot) : undefined,
    spaDir:
      process.env.OSIRIS_CONSOLE_SPA_DIR ??
      firstExisting([
        fileURLToPath(new URL('../public/', import.meta.url)),
        fileURLToPath(new URL('../../osiris-console/dist/', import.meta.url)),
      ]),
  });

  await app.listen({ port, host });
  log.info('osiris-server listening on %s:%d', host, port);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .then(() => stopSessionWatch?.())
        .then(() => telemetry.shutdown())
        .finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.error('failed to start: %s', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
