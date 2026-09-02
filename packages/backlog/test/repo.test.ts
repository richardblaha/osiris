import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecaGitRunner, FakeGitRunner } from '../src/git-runner.js';
import { BacklogRepo } from '../src/repo.js';

const git = new ExecaGitRunner();

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'backlog-repo-'));
  await git.run(['init', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# Sample\n', 'utf8');
  await git.run(['add', '-A'], { cwd: dir });
  await git.run(['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('BacklogRepo (integration, real git)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await initRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the orphan branch and round-trips a task through states', async () => {
    const repo = await BacklogRepo.open({ repoRoot: dir });
    expect(repo.branch).toBe('osiris/backlog');

    const created = await repo.create({ type: 'bug', title: 'Parser crash', body: 'boom' });
    expect(created.id).toBe(1);
    expect(created.state).toBe('todo');

    const mainLogBefore = await git.run(['log', '--oneline', 'main'], { cwd: dir });

    const moved = await repo.move(1, 'in-progress');
    expect(moved.state).toBe('in-progress');

    // Exactly one commit per mutation on the orphan branch...
    const orphanLog = await git.run(['log', '--oneline', 'osiris/backlog'], { cwd: dir });
    const subjects = orphanLog.stdout.split('\n').map((l) => l.replace(/^\S+ /, ''));
    expect(subjects).toEqual([
      'move: [bug]-0001 todo → in-progress',
      'add: [bug]-0001 Parser crash',
      'chore(backlog): initialise orphan branch',
    ]);

    // ...and nothing on main.
    const mainLogAfter = await git.run(['log', '--oneline', 'main'], { cwd: dir });
    expect(mainLogAfter.stdout).toBe(mainLogBefore.stdout);

    const board = await repo.board();
    expect(board.tasks).toHaveLength(1);
    expect(board.states).toEqual(['todo', 'in-progress', 'review', 'done']);

    const history = await repo.history(1);
    expect(history.map((h) => h.subject)).toContain('move: [bug]-0001 todo → in-progress');
  });

  it('is idempotent — a second open reuses the worktree', async () => {
    await BacklogRepo.open({ repoRoot: dir });
    const again = await BacklogRepo.open({ repoRoot: dir });
    const tasks = await again.list();
    expect(tasks).toEqual([]);
  });

  it('move to the same state is a no-op (no commit)', async () => {
    const repo = await BacklogRepo.open({ repoRoot: dir });
    await repo.create({ type: 'chore', title: 'x' });
    const before = await git.run(['rev-parse', 'osiris/backlog'], { cwd: dir });
    await repo.move(1, 'todo');
    const after = await git.run(['rev-parse', 'osiris/backlog'], { cwd: dir });
    expect(after.stdout).toBe(before.stdout);
  });
});

describe('ensureBacklogWorktree (FakeGitRunner)', () => {
  it('short-circuits when the worktree is already registered — no fs writes', async () => {
    const fake = new FakeGitRunner();
    const wt = '/nonexistent/backlog-worktree';
    fake.stub('rev-parse --show-toplevel', { stdout: '/repo' });
    fake.stub('worktree list --porcelain', { stdout: `worktree ${wt}\nHEAD abc\nbranch refs/heads/osiris/backlog\n` });

    const repo = await BacklogRepo.open({ repoRoot: '/repo', git: fake, worktreePath: wt });
    expect(repo.branch).toBe('osiris/backlog');
    expect(fake.subcommands()).not.toContain('commit');
    expect(fake.calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false);
  });
});
