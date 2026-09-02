import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.js';

const exec = promisify(execFile);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'doctor-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const by = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  checks.find((c) => c.name === name);

describe('runDoctor', () => {
  it('fails the git check outside a repo, warns on a missing .osiris/', async () => {
    const checks = await runDoctor(dir, {});
    expect(by(checks, 'git repository')?.level).toBe('fail');
    expect(by(checks, '.osiris/ folder')?.level).toBe('warn');
    // Agents still resolve from the bundled template.
    expect(by(checks, 'crew agents')?.detail).toContain('architect');
  });

  it('is all-green for an initialised workspace', async () => {
    await exec('git', ['init', '-b', 'main'], { cwd: dir });
    await exec('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
    await exec('git', ['config', 'user.name', 'T'], { cwd: dir });
    await writeFile(join(dir, 'README.md'), '# x\n', 'utf8');
    await exec('git', ['add', '-A'], { cwd: dir });
    await exec('git', ['commit', '-m', 'i'], { cwd: dir });
    const { runCli } = await import('../src/run.js');
    await runCli(['init'], { cwd: dir, out: () => {}, err: () => {}, env: process.env });

    const checks = await runDoctor(dir, {});
    expect(checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(by(checks, 'backlog')?.detail).toMatch(/branch osiris\/backlog/);
  });
});
