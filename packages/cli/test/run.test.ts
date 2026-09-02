import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/run.js';

const exec = promisify(execFile);

let dir: string;

async function gitRepo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'osiris-cli-'));
  await exec('git', ['init', '-b', 'main'], { cwd: d });
  await exec('git', ['config', 'user.email', 'a@b.c'], { cwd: d });
  await exec('git', ['config', 'user.name', 'Test'], { cwd: d });
  await writeFile(join(d, 'README.md'), '# Test project\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: d });
  await exec('git', ['commit', '-m', 'init'], { cwd: d });
  return d;
}

function io(cwd: string): CliIo & { stdout: string; stderr: string } {
  const bag = { stdout: '', stderr: '' };
  return {
    ...bag,
    cwd,
    env: { ...process.env, OSIRIS_CREW_PROVIDER: 'echo' },
    out(t: string) {
      this.stdout += t;
    },
    err(t: string) {
      this.stderr += t;
    },
  };
}

beforeEach(async () => {
  dir = await gitRepo();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('osiris CLI', () => {
  it('prints usage for --help', async () => {
    const o = io(dir);
    expect(await runCli(['--help'], o)).toBe(0);
    expect(o.stdout).toContain('osiris — multi-agent workspace CLI');
  });

  it('init → agent list → backlog new/list/move', async () => {
    let o = io(dir);
    expect(await runCli(['init'], o)).toBe(0);
    expect(o.stdout).toContain('written');

    o = io(dir);
    expect(await runCli(['agent', 'list'], o)).toBe(0);
    expect(o.stdout).toContain('architect');

    o = io(dir);
    expect(await runCli(['backlog', 'new', 'Parser', 'crash', '--type', 'bug'], o)).toBe(0);
    expect(o.stdout).toMatch(/created #\d+: todo\//);

    o = io(dir);
    await runCli(['backlog', 'move', '2', 'review'], o);
    expect(o.stdout).toContain('→ review');

    o = io(dir);
    await runCli(['backlog', 'list'], o);
    expect(o.stdout).toContain('review (1)');

    // The move lives on the orphan branch, not main.
    const mainLog = await exec('git', ['log', '--oneline', 'main'], { cwd: dir });
    expect(mainLog.stdout.trim().split('\n')).toHaveLength(1);
    const orphan = await exec('git', ['log', '--oneline', 'osiris/backlog'], { cwd: dir });
    expect(orphan.stdout).toContain('todo → review');
  });

  it('memory reindex then search finds a seeded note', async () => {
    await runCli(['init'], io(dir));
    await writeFile(
      join(dir, '.osiris', 'memory', 'decisions.md'),
      '# No .NET\n\nThe Osiris platform has no .NET anywhere in build or runtime.',
      'utf8',
    );
    let o = io(dir);
    expect(await runCli(['memory', 'reindex'], o)).toBe(0);
    expect(o.stdout).toContain('embed calls');

    o = io(dir);
    await runCli(['memory', 'search', 'dotnet runtime', '-k', '1'], o);
    expect(o.stdout).toContain('decisions.md');
  });

  it('crew run (echo provider) completes', async () => {
    await runCli(['init'], io(dir));
    const o = io(dir);
    expect(await runCli(['crew', 'run', 'summarise the repo'], o)).toBe(0);
    expect(o.stderr).toContain('architect');
  });
});
