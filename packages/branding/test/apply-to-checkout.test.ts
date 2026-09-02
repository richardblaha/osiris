import { describe, expect, it } from 'vitest';
import { rewriteConfigFolder } from '../scripts/apply-to-checkout.mjs';

describe('rewriteConfigFolder', () => {
  it('renames the workspace config folder', () => {
    expect(rewriteConfigFolder(`export const FOLDER_CONFIG_FOLDER_NAME = '.vscode';`)).toBe(
      `export const FOLDER_CONFIG_FOLDER_NAME = '.osiris';`,
    );
    expect(rewriteConfigFolder(`joinPath(folder, '.vscode/tasks.json')`)).toBe(
      `joinPath(folder, '.osiris/tasks.json')`,
    );
    expect(rewriteConfigFolder(`'.vscode\\\\launch.json'`)).toBe(`'.osiris\\\\launch.json'`);
  });

  it('leaves unrelated identifiers alone', () => {
    const src = `
      const authority = 'vscode-remote://x';
      const scheme = 'vscode-userdata';
      import x from './vscode-proposed.d.ts';
      // the .vscode-test folder is ignored
    `;
    expect(rewriteConfigFolder(src)).toBe(src);
  });
});
