import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../src/init.js';
import { resolveOsirisFile, listOsirisDir } from '../src/resolve.js';
import { OsirisPaths } from '../src/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dot-osiris-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('initWorkspace', () => {
  it('scaffolds a working .osiris on an empty dir', async () => {
    const result = await initWorkspace(dir);
    expect(result.written).toContain(join('.osiris', 'backlog', 'PROCESS.md'));
    expect(result.written).toContain(join('.osiris', 'agents', 'architect.md'));
    expect(result.gitignoreChanged).toBe(true);

    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.osiris/temp/');
  });

  it('is a no-op on a second run', async () => {
    await initWorkspace(dir);
    const again = await initWorkspace(dir);
    expect(again.written).toEqual([]);
    expect(again.gitignoreChanged).toBe(false);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it('keeps a user file unless force is set', async () => {
    const paths = new OsirisPaths(dir);
    await mkdir(paths.agents, { recursive: true });
    await writeFile(paths.resolve('agents/architect.md'), 'MINE', 'utf8');

    await initWorkspace(dir);
    expect(await readFile(paths.resolve('agents/architect.md'), 'utf8')).toBe('MINE');

    await initWorkspace(dir, { force: true });
    expect(await readFile(paths.resolve('agents/architect.md'), 'utf8')).not.toBe('MINE');
  });
});

describe('resolveOsirisFile', () => {
  it('prefers the project copy and falls back to the template', async () => {
    const paths = new OsirisPaths(dir);

    const fromTemplate = await resolveOsirisFile(paths, 'agents/reviewer.md');
    expect(fromTemplate?.source).toBe('template');

    await mkdir(paths.agents, { recursive: true });
    await writeFile(paths.resolve('agents/reviewer.md'), '---\nname: reviewer\n---\nlocal', 'utf8');
    const fromProject = await resolveOsirisFile(paths, 'agents/reviewer.md');
    expect(fromProject?.source).toBe('project');
    expect(fromProject?.content).toContain('local');
  });

  it('lists a merged view of a subdir', async () => {
    const paths = new OsirisPaths(dir);
    const agents = await listOsirisDir(paths, 'agents', { filter: (p) => p.endsWith('.md') });
    const names = agents.map((a) => a.relPath).sort();
    expect(names).toEqual([
      'architect.md',
      'implementer.md',
      'researcher.md',
      'reviewer.md',
    ]);
    expect(agents.every((a) => a.source === 'template')).toBe(true);
  });
});
