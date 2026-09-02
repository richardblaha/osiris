/**
 * Osiris runtime hook for the Electron **main process**.
 *
 * The VSCodium source is not vendored, so this module is injected into the
 * upstream main entry by a patch in `patches/` (see `runtime/README.md`):
 *
 *   import('<appRoot>/runtime/osiris-main.mjs')
 *     .then((m) => m.activateOsirisRuntime({ app }));
 *
 * It boots the local dependency stack + telemetry (`@osiris/desktop-host`
 * `bootstrapOsirisRuntime`) and publishes the shared endpoints into the
 * environment the extension host inherits.
 *
 * DevContainer enforcement and the `devcontainer up` / handover work live in the
 * `osiris-workspace` extension (ui kind) — it runs in the local extension host,
 * which unlike this process has the `vscode` API and a real `node_modules`.
 */
import { bootstrapOsirisRuntime } from '@osiris/desktop-host';

/** Pure: read the desktop runtime configuration from the environment. */
export function resolveDesktopConfig(env = process.env) {
  return {
    dashboard: env.OSIRIS_DASHBOARD === 'jaeger' ? 'jaeger' : 'aspire',
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serverPort: Number.parseInt(env.OSIRIS_DEVCONTAINER_PORT ?? '8000', 10) || 8000,
    server: {
      baseUrl: (env.OSIRIS_SERVER_URL ?? '').replace(/\/+$/, ''),
      token: env.OSIRIS_SERVER_TOKEN ?? '',
      registryHost: env.OSIRIS_REGISTRY ?? 'registry.osiris.internal',
    },
  };
}

/**
 * @param {{ app: import('electron').App }} electron
 */
export async function activateOsirisRuntime({ app }) {
  const config = resolveDesktopConfig();

  const runtime = await bootstrapOsirisRuntime({
    dashboard: config.dashboard,
    otlpEndpoint: config.otlpEndpoint,
  });
  app.on('will-quit', () => void runtime.dispose());

  return { runtime, config };
}
