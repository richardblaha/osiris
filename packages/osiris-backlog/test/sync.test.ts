import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaGitRunner } from '../src/git-runner.js';
import { BacklogRepo } from '../src/repo.js';

const git = new ExecaGitRunner();

async function initRepo(remote: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'backlog-sync-'));
  await git.run(['init', '-b', 'main'], { cwd: dir });
  await git.run(['remote', 'add', 'origin', remote], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# S\n', 'utf8');
  await git.run(['add', '-A'], { cwd: dir });
  await git.run(['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('BacklogRepo push/pull (real git, bare remote)', () => {
  let bare: string;
  let repoA: string;
  let repoB: string;

  beforeEach(async () => {
    bare = await mkdtemp(join(tmpdir(), 'backlog-bare-'));
    await git.run(['init', '--bare', '-b', 'main', bare]);
    repoA = await initRepo(bare);
    repoB = await initRepo(bare);
  });
  afterEach(async () => {
    await Promise.all([bare, repoA, repoB].map((d) => rm(d, { recursive: true, force: true })));
  });

  it('push from A, pull into B, and lint is clean', async () => {
    const a = await BacklogRepo.open({ repoRoot: repoA });
    await a.create({ type: 'feat', title: 'Shared task' });
    expect((await a.push()).ok).toBe(true);

    const b = await BacklogRepo.open({ repoRoot: repoB });
    expect(await b.list()).toEqual([]); // hasn't pulled yet
    const pull = await b.pull();
    expect(pull.ok).toBe(true);
    const tasks = await b.list();
    expect(tasks.map((t) => t.title)).toContain('Shared task');

    expect(await b.lint()).toEqual([]);
  });

  it('reports divergence instead of losing local commits', async () => {
    const a = await BacklogRepo.open({ repoRoot: repoA });
    await a.create({ type: 'feat', title: 'A-first' });
    await a.push();

    const b = await BacklogRepo.open({ repoRoot: repoB });
    await b.pull();
    // Both sides commit independently → histories diverge.
    await a.create({ type: 'bug', title: 'A-second' });
    await a.push();
    await b.create({ type: 'chore', title: 'B-second' });

    const pull = await b.pull();
    expect(pull.ok).toBe(false);
    expect(pull.diverged).toBe(true);
  });

  it('autoPush pushes after each mutation', async () => {
    const a = await BacklogRepo.open({ repoRoot: repoA, autoPush: true });
    await a.create({ type: 'feat', title: 'auto' });

    const b = await BacklogRepo.open({ repoRoot: repoB });
    await b.pull();
    expect((await b.list()).map((t) => t.title)).toContain('auto');
  });

  it('lint flags a duplicate id and an unparseable file', async () => {
    const repo = await BacklogRepo.open({ repoRoot: repoA });
    await repo.create({ type: 'feat', title: 'one' }); // id 1
    await writeFile(
      join(repo.worktreePath, 'todo', '[bug]-0001-clash.md'),
      '---\nid: 1\ntype: bug\ntitle: clash\n---\n',
      'utf8',
    );
    await writeFile(join(repo.worktreePath, 'todo', 'not-a-task.md'), 'hello', 'utf8');

    const issues = await repo.lint();
    expect(issues.some((i) => /duplicate id 1/.test(i.message))).toBe(true);
    expect(issues.some((i) => /filename ≠/.test(i.message))).toBe(true);
  });
});
