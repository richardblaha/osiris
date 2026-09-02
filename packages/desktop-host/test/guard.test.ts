import { describe, expect, it, vi } from 'vitest';
import { installDevContainerGuard, type ElectronBridge } from '../src/guard.js';
import { createDesktopHandoverCommands } from '../src/handover-commands.js';

function fakeElectron() {
  const listeners: {
    openFile?: (p: string) => void;
    secondInstance?: (argv: string[]) => void;
    ipc: Map<string, () => Promise<void> | void>;
  } = { ipc: new Map() };
  const bridge: ElectronBridge = {
    onOpenFile: (l) => {
      listeners.openFile = l;
    },
    onSecondInstance: (l) => {
      listeners.secondInstance = l;
    },
    handleIpc: (channel, l) => {
      listeners.ipc.set(channel, l);
    },
    showConfirm: vi.fn(async () => true),
    pickFolder: vi.fn(async () => '/home/me/proj'),
  };
  return { bridge, listeners };
}

describe('installDevContainerGuard', () => {
  it('routes a host path through ensureDevContainer and opens the authority URI', async () => {
    const { bridge, listeners } = fakeElectron();
    const openWorkbench = vi.fn();
    const ensureDevContainer = vi.fn(async () => ({ hash: 'deadbeef0000' }));

    installDevContainerGuard({ electron: bridge, openWorkbench, ensureDevContainer });
    listeners.openFile?.('/home/me/proj');
    await vi.waitFor(() => expect(openWorkbench).toHaveBeenCalled());

    expect(ensureDevContainer).toHaveBeenCalledWith('/home/me/proj');
    expect(openWorkbench.mock.calls[0]?.[0].folderUri).toMatch(
      /^vscode-remote:\/\/osiris-devcontainer\+[0-9a-f]{12}\/workspaces\/proj$/,
    );
  });

  it('passes an existing Osiris authority straight through', async () => {
    const { bridge, listeners } = fakeElectron();
    const openWorkbench = vi.fn();
    installDevContainerGuard({
      electron: bridge,
      openWorkbench,
      ensureDevContainer: vi.fn(),
    });

    const uri = 'vscode-remote://osiris-devcontainer+abc123def456/workspaces/p';
    listeners.openFile?.(uri);
    await vi.waitFor(() => expect(openWorkbench).toHaveBeenCalledWith({ folderUri: uri }));
  });

  it('does nothing when the user cancels the confirm', async () => {
    const { bridge, listeners } = fakeElectron();
    (bridge.showConfirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const openWorkbench = vi.fn();
    installDevContainerGuard({ electron: bridge, openWorkbench, ensureDevContainer: vi.fn() });

    listeners.openFile?.('/home/me/proj');
    await Promise.resolve();
    await Promise.resolve();
    expect(openWorkbench).not.toHaveBeenCalled();
  });
});

describe('createDesktopHandoverCommands', () => {
  it('exposes the three osiris.desktop commands', () => {
    const handlers = createDesktopHandoverCommands({
      server: { baseUrl: 'http://s', token: 't', registryHost: 'r.osiris' },
    });
    expect(Object.keys(handlers).sort()).toEqual([
      'osiris.desktop.ensureDevContainer',
      'osiris.desktop.performFetch',
      'osiris.desktop.performHandover',
    ]);
  });

  it('performHandover: freeze → upload → commit, then rolls back on failure', async () => {
    const order: string[] = [];
    const commitHandover = vi.fn(async () => ({ webUrl: 'http://s/ide/x', location: 'server' as const }));
    const abortHandover = vi.fn(async () => undefined);

    const handlers = createDesktopHandoverCommands({
      server: { baseUrl: 'http://s', token: 't', registryHost: 'r.osiris' },
      makeClient: () => ({ commitHandover, abortHandover }) as never,
      freezeImpl: (async () => {
        order.push('freeze');
        return { imageRef: 'r.osiris/x:local', imageDigest: `sha256:${'a'.repeat(64)}`, volumeTar: {}, restorePath: '/' };
      }) as never,
      uploadVolume: async () => {
        order.push('upload');
        return { sha256: `sha256:${'b'.repeat(64)}` };
      },
      thawImpl: vi.fn() as never,
    });

    const ok = await handlers['osiris.desktop.performHandover']?.({
      sessionId: 's1',
      prepare: { volumeUploadUrl: 'http://s/up' },
      containerId: 'c1',
    });
    expect(order).toEqual(['freeze', 'upload']);
    expect((ok as { webUrl: string }).webUrl).toContain('/ide/');
    expect(commitHandover).toHaveBeenCalledOnce();

    // now make upload fail → rollback path
    const failing = createDesktopHandoverCommands({
      server: { baseUrl: 'http://s', token: 't', registryHost: 'r.osiris' },
      makeClient: () => ({ commitHandover, abortHandover }) as never,
      freezeImpl: (async () => ({ imageRef: 'x', imageDigest: 'd', volumeTar: {}, restorePath: '/' })) as never,
      uploadVolume: async () => {
        throw new Error('network down');
      },
      thawImpl: vi.fn() as never,
    });
    await expect(
      failing['osiris.desktop.performHandover']?.({
        sessionId: 's1',
        prepare: { volumeUploadUrl: 'http://s/up' },
        containerId: 'c1',
      }),
    ).rejects.toThrow('network down');
    expect(abortHandover).toHaveBeenCalledWith('s1');
  });
});
