#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTelemetry } from '@osiris/telemetry';
import { createLogger } from '@osiris/shared-core';
import { buildServer } from './app.js';
import { FileSessionStore } from './session-store.js';
import { FileVolumeStore } from './executors.js';
import { createWorkspaceConsoleDeps, resolveWorkspaceRoot } from './console-workspace.js';

const log = createLogger('server');

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => existsSync(p));
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
  const stateDir = process.env.OSIRIS_STATE_DIR;

  if (!token) {
    log.warn('OSIRIS_SERVER_TOKEN is unset — the API is running without authentication');
  }
  if (stateDir) {
    log.info('persisting session + volume state under %s', stateDir);
  } else {
    log.warn('OSIRIS_STATE_DIR is unset — session state is in-memory and lost on restart');
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const consoleEnabled =
    process.env.OSIRIS_CONSOLE !== '0' &&
    (process.env.OSIRIS_WORKSPACE_ROOT !== undefined || existsSync(join(workspaceRoot, '.osiris')));
  if (consoleEnabled) {
    log.info('console API enabled for workspace %s', workspaceRoot);
  }

  const app = buildServer({
    token,
    publicBaseUrl,
    leaseSweepMs: 30_000,
    gitReposDir: process.env.OSIRIS_GIT_REPOS_DIR,
    console: consoleEnabled ? createWorkspaceConsoleDeps(workspaceRoot) : undefined,
    spaDir:
      process.env.OSIRIS_CONSOLE_SPA_DIR ??
      firstExisting([
        fileURLToPath(new URL('../public/', import.meta.url)),
        fileURLToPath(new URL('../../osiris-console/dist/', import.meta.url)),
      ]),
    store: stateDir ? new FileSessionStore(join(stateDir, 'sessions')) : undefined,
    volumes: stateDir ? new FileVolumeStore(join(stateDir, 'volumes')) : undefined,
    registry: process.env.OSIRIS_REGISTRY
      ? {
          url: process.env.OSIRIS_REGISTRY,
          repository: 'workspaces',
          token: process.env.OSIRIS_REGISTRY_TOKEN ?? '',
        }
      : undefined,
  });

  await app.listen({ port, host });
  log.info('osiris-server listening on %s:%d', host, port);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app
        .close()
        .then(() => telemetry.shutdown())
        .finally(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.error('failed to start: %s', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
