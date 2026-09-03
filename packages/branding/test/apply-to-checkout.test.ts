import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rewriteConfigFolder, sweepConfigFolder } from '../scripts/apply-to-checkout.mjs';

describe('rewriteConfigFolder', () => {
  it('renames the workspace config folder', () => {
    expect(rewriteConfigFolder(`export const FOLDER_CONFIG_FOLDER_NAME = '.vscode';`)).toBe(
      `export const FOLDER_CONFIG_FOLDER_NAME = '.osiris';`,
    );
    expect(rewriteConfigFolder(`joinPath(folder, '.vscode/tasks.json')`)).toBe(
      `joinPath(folder, '.osiris/tasks.json')`,
    );
    expect(rewriteConfigFolder(`folder.toResource('.vscode')`)).toBe(
      `folder.toResource('.osiris')`,
    );
    expect(rewriteConfigFolder(`'.vscode\\\\launch.json'`)).toBe(`'.osiris\\\\launch.json'`);
  });

  it('leaves unrelated identifiers alone', () => {
    const src = `
      const authority = 'vscode-remote://x';
      const scheme = 'vscode-userdata';
      import x from './vscode-proposed.d.ts';
      // the .vscode-test folder is ignored
      const ignore = '.vscodeignore';
    `;
    expect(rewriteConfigFolder(src)).toBe(src);
  });

  it('leaves the `vscode` identifier alone — only path literals are renamed', () => {
    const src = `
      const g = (globalThis as any).vscode;
      if (model.uri.scheme === Schemas.vscode) return;
      const engine = manifest.engines.vscode;
      return auxiliaryWindow?.vscode?.ipcRenderer;
    `;
    expect(rewriteConfigFolder(src)).toBe(src);
    expect(rewriteConfigFolder(`join(folder, '.vscode', 'launch.json')`)).toBe(
      `join(folder, '.osiris', 'launch.json')`,
    );
  });
});

describe('sweepConfigFolder', () => {
  let dir: string;
  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'branding-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rewrites every workbench .ts and reports the changed files', async () => {
    await write(
      'src/vs/workbench/services/configuration/common/configuration.ts',
      `export const FOLDER_CONFIG_FOLDER_NAME = '.vscode';`,
    );
    await write(
      'src/vs/workbench/contrib/snippets/browser/snippetsService.ts',
      `const f = folder.toResource('.vscode');`,
    );
    await write('src/vs/workbench/contrib/x/y.test.ts', `const s = '.vscode/settings.json';`);

    const { changed, stray } = await sweepConfigFolder(dir);

    expect(changed.sort()).toEqual([
      'src/vs/workbench/contrib/snippets/browser/snippetsService.ts',
      'src/vs/workbench/services/configuration/common/configuration.ts',
    ]);
    expect(stray).toEqual([]);
    expect(
      await readFile(
        join(dir, 'src/vs/workbench/contrib/snippets/browser/snippetsService.ts'),
        'utf8',
      ),
    ).toContain(".toResource('.osiris')");
    // .test.ts is skipped by the sweep and by the scan
    expect(await readFile(join(dir, 'src/vs/workbench/contrib/x/y.test.ts'), 'utf8')).toContain(
      '.vscode/settings.json',
    );
  });

  it('sweeps src/vs/platform too (the diagnostics service reads a launch config)', async () => {
    await write('src/vs/workbench/services/a/a.ts', `const s = '.vscode/tasks.json';`);
    await write(
      'src/vs/platform/diagnostics/node/diagnosticsService.ts',
      `const launchConfig = join(folder, '.vscode', 'launch.json');`,
    );

    const { changed, stray } = await sweepConfigFolder(dir);

    expect(changed.sort()).toEqual([
      'src/vs/platform/diagnostics/node/diagnosticsService.ts',
      'src/vs/workbench/services/a/a.ts',
    ]);
    expect(stray).toEqual([]);
  });

  it('flags a `.vscode` path literal that survives outside every sweep tree', async () => {
    await write('src/vs/workbench/services/a/a.ts', `const s = '.vscode/tasks.json';`);
    await write('src/vs/base/node/nls.ts', `const d = '.vscode';`);
    // the `vscode` identifier in an un-swept tree is not a stray reference
    await write('src/vs/base/common/platform.ts', `nodeProcess = $globalThis.vscode.process;`);

    const { changed, stray } = await sweepConfigFolder(dir);

    expect(changed).toEqual(['src/vs/workbench/services/a/a.ts']);
    expect(stray).toEqual([
      { file: 'src/vs/base/node/nls.ts', line: 1, text: `const d = '.vscode';` },
    ]);
  });
});
