import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceServices } from '../src/workspace.js';
import { watchMemory } from '../src/watch.js';
import { runCli } from '../src/run.js';

const exec = promisify(execFile);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watch-'));
  await exec('git', ['init', '-b', 'main'], { cwd: dir });
  await runCli(['init'], { cwd: dir, out: () => {}, err: () => {}, env: process.env });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('watchMemory', () => {
  it('reindexes once on start and again when a .md file changes', async () => {
    const services = new WorkspaceServices(dir, process.env);
    const summaries: string[] = [];
    const abort = new AbortController();

    const done = watchMemory(services, {
      debounceMs: 50,
      signal: abort.signal,
      onReindex: (s) => summaries.push(s),
    });

    // Wait for the initial index, then touch a file.
    await new Promise((r) => setTimeout(r, 150));
    expect(summaries).toHaveLength(1);

    await mkdir(join(dir, '.osiris', 'memory', 'sub'), { recursive: true });
    await writeFile(
      join(dir, '.osiris', 'memory', 'sub', 'note.md'),
      '# Note\n\nA fresh fact about the orphan branch.',
      'utf8',
    );

    await new Promise((r) => setTimeout(r, 400));
    abort.abort();
    await done;

    expect(summaries.length).toBeGreaterThanOrEqual(2);
    expect(summaries[1]).toMatch(/chunk/);
  });
});
