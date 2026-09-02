import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@osiris/shared-core';

const log = createLogger('container-sync:template');

/**
 * Default OCI ref of the Osiris "web IDE" DevContainer feature (openvscode-server).
 * Must match `features-namespace` in `.github/workflows/publish-features.yml`
 * (currently `ghcr.io/<owner>/<repo>/web-ide`). Override per-install with the
 * `osiris.devcontainer.webIdeFeature` setting or `webIdeFeatureRef`.
 */
export const DEFAULT_WEB_IDE_FEATURE = 'ghcr.io/richardblaha/osiris/web-ide:1';

export interface DevcontainerTemplateOptions {
  /** Port the in-container VS Code server listens on and that is published to host loopback. */
  serverPort?: number;
  /** Override the web-ide feature ref (tests / air-gapped registries). */
  webIdeFeatureRef?: string;
}

/**
 * The DevContainer Osiris drops into a project that has none. It gives every
 * workspace git identity, an SSH agent, a shared pnpm store, the shared
 * telemetry/inference stack on the host gateway, and an openvscode-server
 * (via the web-ide feature) published on host loopback for the remote authority
 * resolver to connect to.
 */
export function renderOsirisDevcontainer(options: DevcontainerTemplateOptions = {}): string {
  const port = options.serverPort ?? 8000;
  const feature = options.webIdeFeatureRef ?? DEFAULT_WEB_IDE_FEATURE;
  return `{
  // Written by Osiris because this project had no .devcontainer/devcontainer.json.
  // Edit freely — Osiris never overwrites an existing config.
  "name": "Osiris Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "features": {
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {},
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/devcontainers/features/python:1": { "version": "3.12", "installTools": false },
    "${feature}": { "port": ${port} }
  },
  // node (npx) + python cover most MCP servers; add more features for others.
  "appPort": ["127.0.0.1:${port}:${port}"],
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
    "OSIRIS_WEB_IDE_PORT": "${port}",
    "SSH_AUTH_SOCK": "/ssh-agent",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://host.docker.internal:4318",
    "OSIRIS_OLLAMA_URL": "http://host.docker.internal:11434"
  },
  "postStartCommand": "osiris-web-ide start || true",
  "postCreateCommand": "test -d .vscode && test ! -d .osiris && cp -r .vscode .osiris || true"
}
`;
}

/** @deprecated use {@link renderOsirisDevcontainer} — kept for callers that want the default string. */
export const OSIRIS_DEVCONTAINER_TEMPLATE = renderOsirisDevcontainer();

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
export async function ensureDevcontainerConfig(
  hostPath: string,
  options: DevcontainerTemplateOptions = {},
): Promise<EnsureConfigResult> {
  const target = join(hostPath, '.devcontainer', 'devcontainer.json');
  const candidates = [target, join(hostPath, '.devcontainer.json')];
  for (const candidate of candidates) {
    if (await exists(candidate)) return { path: candidate, created: false };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderOsirisDevcontainer(options), 'utf8');
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
