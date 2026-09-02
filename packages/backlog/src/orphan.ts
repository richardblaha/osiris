import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@osiris/shared-core';
import type { GitRunner } from './git-runner.js';
import { DEFAULT_STATES } from './states.js';

const log = createLogger('backlog:orphan');

/** The dedicated branch the backlog lives on. Never merged into source branches. */
export const BACKLOG_BRANCH = 'osiris/backlog';

export interface EnsureWorktreeOptions {
  git: GitRunner;
  /** Root of the source repository (contains `.git`). */
  repoRoot: string;
  /** Where to check out the orphan branch. Default `<repoRoot>/.osiris/temp/backlog-worktree`. */
  worktreePath: string;
  branch?: string;
  /** State folders to seed when creating the branch. */
  seedStates?: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(git: GitRunner, repoRoot: string, branch: string): Promise<boolean> {
  const res = await git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  });
  return res.exitCode === 0;
}

async function worktreeRegistered(git: GitRunner, repoRoot: string, worktreePath: string): Promise<boolean> {
  const res = await git.run(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  return res.stdout.split('\n').some((line) => line === `worktree ${worktreePath}`);
}

async function seedBacklog(
  git: GitRunner,
  worktreePath: string,
  states: string[],
): Promise<void> {
  await writeFile(
    join(worktreePath, 'PROCESS.md'),
    '# Backlog process\n\nSee `@osiris/dot-osiris` template for the full convention. States are the\nsub-folders here; tasks are `[<type>]-<id>-<slug>.md` files. Managed on the\n`osiris/backlog` orphan branch.\n',
    'utf8',
  );
  for (const state of states) {
    await mkdir(join(worktreePath, state), { recursive: true });
    await writeFile(join(worktreePath, state, '.gitkeep'), '', 'utf8');
  }
  await git.run(['add', '-A'], { cwd: worktreePath });
  await git.run(['commit', '-m', 'chore(backlog): initialise orphan branch'], { cwd: worktreePath });
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  createdBranch: boolean;
}

/**
 * Guarantee the orphan `branch` exists and is checked out as a git worktree at
 * `worktreePath` — without ever changing the caller's current branch. Idempotent.
 */
export async function ensureBacklogWorktree(
  options: EnsureWorktreeOptions,
): Promise<EnsureWorktreeResult> {
  const branch = options.branch ?? BACKLOG_BRANCH;
  const { git, repoRoot, worktreePath } = options;
  const states = options.seedStates ?? [...DEFAULT_STATES];

  const topLevel = await git.run(['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (topLevel.exitCode !== 0) {
    throw new Error(`not a git repository: ${repoRoot}`);
  }

  await git.run(['worktree', 'prune'], { cwd: repoRoot });

  if (await worktreeRegistered(git, repoRoot, worktreePath)) {
    return { worktreePath, branch, createdBranch: false };
  }

  // A leftover directory that git does not know about would make `worktree add` fail.
  if (await exists(worktreePath)) {
    log.warn('removing stale backlog worktree dir %s', worktreePath);
    await rm(worktreePath, { recursive: true, force: true });
  }
  await mkdir(worktreePath, { recursive: true });
  await rm(worktreePath, { recursive: true, force: true });

  const hasBranch = await branchExists(git, repoRoot, branch);
  if (hasBranch) {
    const add = await git.run(['worktree', 'add', worktreePath, branch], { cwd: repoRoot });
    if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    return { worktreePath, branch, createdBranch: false };
  }

  // Create the orphan branch in its own worktree.
  const orphan = await git.run(['worktree', 'add', '--orphan', '-b', branch, worktreePath], {
    cwd: repoRoot,
  });
  if (orphan.exitCode !== 0) {
    // Older git without `--orphan`: detach, then orphan-checkout inside the worktree.
    const detach = await git.run(['worktree', 'add', '--detach', worktreePath], { cwd: repoRoot });
    if (detach.exitCode !== 0) throw new Error(`git worktree add --detach failed: ${detach.stderr}`);
    await git.run(['checkout', '--orphan', branch], { cwd: worktreePath });
    await git.run(['rm', '-rf', '--quiet', '.'], { cwd: worktreePath });
  }

  await seedBacklog(git, worktreePath, states);
  log.info('created orphan branch %s at %s', branch, worktreePath);
  return { worktreePath, branch, createdBranch: true };
}
