/**
 * Osiris runtime hook for the Electron **main process**.
 *
 * The VSCodium source is not vendored, so this module is injected into the
 * upstream main entry by a patch in `patches/` (see `runtime/README.md`):
 *
 *   import('<appRoot>/runtime/osiris-main.mjs')
 *     .then((m) => m.activateOsirisRuntime({ app, dialog, ipcMain, openWorkbench }));
 *
 * It boots the local dependency stack + telemetry (`@osiris/desktop-host`
 * `bootstrapOsirisRuntime`), installs the DevContainer open-folder guard, and
 * registers the `osiris.desktop.*` handlers the `osiris-workspace` extension
 * delegates Docker work to.
 */
import {
  bootstrapOsirisRuntime,
  createDesktopHandoverCommands,
  installDevContainerGuard,
} from '@osiris/desktop-host';

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
 * @param {{
 *   app: import('electron').App,
 *   dialog: import('electron').Dialog,
 *   ipcMain: import('electron').IpcMain,
 *   openWorkbench: (options: { folderUri: string }) => void,
 * }} electron
 */
export async function activateOsirisRuntime({ app, dialog, ipcMain, openWorkbench }) {
  const config = resolveDesktopConfig();

  const runtime = await bootstrapOsirisRuntime({
    dashboard: config.dashboard,
    otlpEndpoint: config.otlpEndpoint,
  });
  app.on('will-quit', () => void runtime.dispose());

  const commands = createDesktopHandoverCommands({
    server: config.server,
    serverPort: config.serverPort,
  });

  installDevContainerGuard({
    electron: {
      onOpenFile: (listener) =>
        app.on('open-file', (event, filePath) => {
          event.preventDefault();
          listener(filePath);
        }),
      onSecondInstance: (listener) =>
        app.on('second-instance', (_event, argv) => listener(argv)),
      handleIpc: (channel, listener) => ipcMain.handle(channel, () => listener()),
      showConfirm: async ({ message, detail, confirmLabel }) => {
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message,
          detail,
          buttons: [confirmLabel, 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        });
        return response === 0;
      },
      pickFolder: async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
    openWorkbench,
    ensureDevContainer: (hostPath) =>
      commands['osiris.desktop.ensureDevContainer']({ hostPath, serverPort: config.serverPort }),
  });

  return { runtime, commands };
}
