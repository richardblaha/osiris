import { describe, expect, it } from 'vitest';
import { classifyOpenTarget, devcontainerHash, planReopen } from '../src/folder-routing.js';
import { defaultFolderFromArgv } from '../src/guard.js';

describe('classifyOpenTarget', () => {
  it('recognises an Osiris remote authority', () => {
    expect(classifyOpenTarget('vscode-remote://osiris-devcontainer+abc123/workspaces/p')).toEqual({
      kind: 'osiris-remote',
      authority: 'osiris-devcontainer+abc123',
    });
  });

  it('treats other remotes and bare paths as host paths', () => {
    expect(classifyOpenTarget('vscode-remote://dev-container+x/w')).toMatchObject({ kind: 'host-path' });
    expect(classifyOpenTarget('/home/me/project')).toEqual({ kind: 'host-path', path: '/home/me/project' });
    expect(classifyOpenTarget('file:///home/me/project')).toEqual({
      kind: 'host-path',
      path: '/home/me/project',
    });
  });
});

describe('planReopen', () => {
  it('builds the authority URI with a stable hash', () => {
    const plan = planReopen('/home/me/project');
    expect(plan.hash).toBe(devcontainerHash('/home/me/project'));
    expect(plan.folderName).toBe('project');
    expect(plan.folderUri).toBe(
      `vscode-remote://osiris-devcontainer+${plan.hash}/workspaces/project`,
    );
  });
});

describe('defaultFolderFromArgv', () => {
  it('reads --folder-uri, --folder= and a positional path', () => {
    expect(defaultFolderFromArgv(['node', 'main', '--folder-uri', 'u'])).toBe('u');
    expect(defaultFolderFromArgv(['node', 'main', '--folder=/p'])).toBe('/p');
    expect(defaultFolderFromArgv(['node', 'main', '/some/path'])).toBe('/some/path');
    expect(defaultFolderFromArgv(['node', 'main', '--verbose'])).toBeUndefined();
  });
});
