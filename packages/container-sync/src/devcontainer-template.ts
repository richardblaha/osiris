import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@osiris/shared-core';

const log = createLogger('container-sync:template');

/**
 * The DevContainer Osiris drops into a project that has none, so every workspace
 * opens inside a container with git identity, an SSH agent, a shared pnpm store
 * and the shared telemetry/inference stack reachable on the host gateway.
 */
export const OSIRIS_DEVCONTAINER_TEMPLATE = `{
  // Written by Osiris because this project had no .devcontainer/devcontainer.json.
  // Edit freely — Osiris never overwrites an existing config.
  "name": "Osiris Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "features": {
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {},
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" }
  },
  "remoteUser": "vscode",
  "updateRemoteUserUID": true,
  "runArgs": [
    "--label=com.osiris.workspace=true",
    "--add-host=host.docker.internal:host-gateway"
  ],
  "mounts": [
    "source=\${localEnv:HOME}/.gitconfig,target=/home/vscode/.gitconfig,type=bind,readonly",
    "source=\${localEnv:SSH_AUTH_SOCK},target=/ssh-agent,type=bind",
    "source=osiris-pnpm-store,target=/home/vscode/.local/share/pnpm/store,type=volume"
  ],
  "containerEnv": {
    "OSIRIS_LOCATION": "container",
    "SSH_AUTH_SOCK": "/ssh-agent",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://host.docker.internal:4318",
    "OSIRIS_OLLAMA_URL": "http://host.docker.internal:11434"
  },
  "postCreateCommand": "test -d .vscode && test ! -d .osiris && cp -r .vscode .osiris || true"
}
`;

export interface EnsureConfigResult {
  /** Absolute path of the devcontainer.json (existing or freshly written). */
  path: string;
  /** True when Osiris wrote the fallback template just now. */
  created: boolean;
}

/**
 * Guarantee `hostPath` has a `.devcontainer/devcontainer.json`. A `.devcontainer.json`
 * at the workspace root also counts. Never overwrites the user's config.
 */
export async function ensureDevcontainerConfig(hostPath: string): Promise<EnsureConfigResult> {
  const target = join(hostPath, '.devcontainer', 'devcontainer.json');
  const candidates = [target, join(hostPath, '.devcontainer.json')];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { path: candidate, created: false };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, OSIRIS_DEVCONTAINER_TEMPLATE, 'utf8');
  log.info('wrote fallback devcontainer.json to %s', target);
  return { path: target, created: true };
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
