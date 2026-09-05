import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@richardblaha/shared-core';
import { osirisPaths } from '@richardblaha/dot-osiris';
import type { BacklogBoard, BacklogTask, CreateTaskRequest } from '@richardblaha/protocol';
import { ExecaGitRunner, type GitRunner } from './git-runner.js';
import { BACKLOG_BRANCH, ensureBacklogWorktree } from './orphan.js';
import { discoverStates } from './states.js';
import { parseTaskFile, parseTaskFilename, renderNewTask } from './task.js';

const log = createLogger('backlog:repo');

export interface BacklogRepoOptions {
  /** Root of the source repository. */
  repoRoot: string;
  git?: GitRunner;
  branch?: string;
  /** Override the worktree location (default `.osiris/temp/backlog-worktree`). */
  worktreePath?: string;
  seedStates?: string[];
  /** Seed the orphan branch from this dir on first creation (default `<repo>/.osiris/backlog`). */
  seedFrom?: string;
  /** Git remote for `push()` / `pull()` / `autoPush` (default `origin`). */
  remote?: string;
  /** Push the orphan branch after every mutation (best-effort — a failed push never fails the write). */
  autoPush?: boolean;
}

export interface TaskHistoryEntry {
  hash: string;
  date: string;
  subject: string;
}

export interface SyncResult {
  ok: boolean;
  /** True when local and remote had diverged and a fast-forward was not possible. */
  diverged?: boolean;
  message: string;
}

export type LintSeverity = 'error' | 'warning';

export interface BacklogLintIssue {
  severity: LintSeverity;
  /** `<state>/<filename>` or `(backlog)` for cross-file issues. */
  where: string;
  message: string;
}

/**
 * Reads and writes the file-based backlog on its orphan branch. Every mutation
 * is exactly one commit on `osiris/backlog`; the caller's working branch is
 * never touched.
 */
export class BacklogRepo {
  private constructor(
    private readonly git: GitRunner,
    readonly worktreePath: string,
    readonly branch: string,
    private readonly remote: string,
    private readonly autoPush: boolean,
  ) {}

  static async open(options: BacklogRepoOptions): Promise<BacklogRepo> {
    const git = options.git ?? new ExecaGitRunner();
    const worktreePath =
      options.worktreePath ?? osirisPaths(options.repoRoot).tempFile('backlog-worktree');
    const { branch } = await ensureBacklogWorktree({
      git,
      repoRoot: options.repoRoot,
      worktreePath,
      branch: options.branch ?? BACKLOG_BRANCH,
      seedStates: options.seedStates,
      seedFrom: options.seedFrom ?? osirisPaths(options.repoRoot).backlog,
    });
    return new BacklogRepo(
      git,
      worktreePath,
      branch,
      options.remote ?? 'origin',
      options.autoPush ?? false,
    );
  }

  async states(): Promise<string[]> {
    return discoverStates(this.worktreePath);
  }

  async list(): Promise<BacklogTask[]> {
    const states = await this.states();
    const tasks: BacklogTask[] = [];
    for (const state of states) {
      const dir = join(this.worktreePath, state);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'PROCESS.md') continue;
        const content = await readFile(join(dir, file), 'utf8');
        const parsed = parseTaskFile(state, file, content);
        if (parsed.ok) tasks.push(parsed.value);
        else log.warn('skipping %s/%s: %s', state, file, parsed.error.message);
      }
    }
    return tasks.sort((a, b) => a.id - b.id);
  }

  async board(): Promise<BacklogBoard> {
    const [states, tasks] = await Promise.all([this.states(), this.list()]);
    return { branch: this.branch, states, tasks };
  }

  async get(id: number): Promise<BacklogTask | undefined> {
    return (await this.list()).find((t) => t.id === id);
  }

  private async nextId(): Promise<number> {
    const tasks = await this.list();
    return tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  }

  private async commit(paths: string[], message: string): Promise<void> {
    await this.git.run(['add', '--', ...paths], { cwd: this.worktreePath });
    const res = await this.git.run(['commit', '-m', message], { cwd: this.worktreePath });
    if (res.exitCode !== 0 && !/nothing to commit/i.test(res.stdout + res.stderr)) {
      throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
    }
    if (this.autoPush) {
      const push = await this.push();
      if (!push.ok) log.warn('autoPush: %s', push.message);
    }
  }

  async create(input: CreateTaskRequest): Promise<BacklogTask> {
    const states = await this.states();
    const state = input.state ?? states[0] ?? 'todo';
    if (!states.includes(state)) throw new Error(`unknown state "${state}"`);
    const id = await this.nextId();
    const { filename, content } = renderNewTask({
      type: input.type,
      id,
      title: input.title,
      assignee: input.assignee,
      labels: input.labels,
      body: input.body,
    });
    const dir = join(this.worktreePath, state);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), content, 'utf8');
    await this.commit(
      [`${state}/${filename}`],
      `add: [${input.type}]-${String(id).padStart(4, '0')} ${input.title}`,
    );
    log.info('created #%d in %s', id, state);
    return (await this.get(id))!;
  }

  async move(id: number, toState: string): Promise<BacklogTask> {
    const task = await this.get(id);
    if (!task) throw new Error(`no task with id ${id}`);
    const states = await this.states();
    if (!states.includes(toState)) throw new Error(`unknown state "${toState}"`);
    if (task.state === toState) return task;

    await mkdir(join(this.worktreePath, toState), { recursive: true });
    const from = `${task.state}/${task.filename}`;
    const to = `${toState}/${task.filename}`;
    const mv = await this.git.run(['mv', from, to], { cwd: this.worktreePath });
    if (mv.exitCode !== 0) throw new Error(`git mv failed: ${mv.stderr}`);

    await this.commit(
      [from, to],
      `move: [${task.type}]-${String(id).padStart(4, '0')} ${task.state} → ${toState}`,
    );
    log.info('moved #%d %s → %s', id, task.state, toState);
    return (await this.get(id))!;
  }

  async history(id: number): Promise<TaskHistoryEntry[]> {
    const task = await this.get(id);
    if (!task) return [];
    // `--follow` takes a single pathspec; `:(literal)` stops git reading the
    // `[type]` brackets in the filename as a glob character class.
    const res = await this.git.run(
      ['log', '--follow', '--format=%H %cs %s', '--', `:(literal)${task.state}/${task.filename}`],
      { cwd: this.worktreePath },
    );
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(' ');
        return { hash: parts[0] ?? '', date: parts[1] ?? '', subject: parts.slice(2).join(' ') };
      });
  }

  /** Push the orphan branch to `remote` (`osiris/backlog:osiris/backlog`). */
  async push(remote = this.remote): Promise<SyncResult> {
    const res = await this.git.run(['push', remote, `${this.branch}:${this.branch}`], {
      cwd: this.worktreePath,
    });
    if (res.exitCode === 0) {
      const message = /Everything up-to-date/i.test(res.stderr) ? 'up to date' : 'pushed';
      log.info('push → %s: %s', remote, message);
      return { ok: true, message };
    }
    return { ok: false, message: (res.stderr || res.stdout).trim() || 'push failed' };
  }

  /**
   * Fetch the orphan branch from `remote` and fast-forward. Returns
   * `{ ok:false, diverged:true }` when local commits would be lost — the caller
   * resolves that (there is no automatic merge of a file-based backlog).
   */
  async pull(remote = this.remote): Promise<SyncResult> {
    const fetch = await this.git.run(['fetch', remote, this.branch], { cwd: this.worktreePath });
    if (fetch.exitCode !== 0) {
      return {
        ok: false,
        message: `nothing to pull (${(fetch.stderr || 'no such branch').trim()})`,
      };
    }
    const merge = await this.git.run(['merge', '--ff-only', 'FETCH_HEAD'], {
      cwd: this.worktreePath,
    });
    if (merge.exitCode === 0) {
      const message = /Already up to date/i.test(merge.stdout) ? 'up to date' : 'fast-forwarded';
      log.info('pull ← %s: %s', remote, message);
      return { ok: true, message };
    }
    return { ok: false, diverged: true, message: 'local and remote backlog have diverged' };
  }

  /**
   * Static checks over every task file: parseable, filename id matches the
   * frontmatter id, ids unique, assignee (if any) is a plausible agent name.
   */
  async lint(): Promise<BacklogLintIssue[]> {
    const issues: BacklogLintIssue[] = [];
    const states = await this.states();
    const seenIds = new Map<number, string>();

    for (const state of states) {
      const dir = join(this.worktreePath, state);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'PROCESS.md') continue;
        const where = `${state}/${file}`;
        const fromName = parseTaskFilename(file);
        if (!fromName) {
          issues.push({ severity: 'error', where, message: 'filename ≠ [<type>]-<id>-<slug>.md' });
          continue;
        }
        const parsed = parseTaskFile(state, file, await readFile(join(dir, file), 'utf8'));
        if (!parsed.ok) {
          issues.push({ severity: 'error', where, message: parsed.error.message });
          continue;
        }
        const existing = seenIds.get(fromName.id);
        if (existing) {
          issues.push({
            severity: 'error',
            where,
            message: `duplicate id ${fromName.id} (also ${existing})`,
          });
        }
        seenIds.set(fromName.id, where);
      }
    }
    return issues;
  }
}
