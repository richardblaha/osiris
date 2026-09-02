import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@osiris/shared-core';
import { osirisPaths } from '@osiris/dot-osiris';
import type { BacklogBoard, BacklogTask, CreateTaskRequest } from '@osiris/protocol';
import { ExecaGitRunner, type GitRunner } from './git-runner.js';
import { BACKLOG_BRANCH, ensureBacklogWorktree } from './orphan.js';
import { discoverStates } from './states.js';
import { parseTaskFile, renderNewTask } from './task.js';

const log = createLogger('backlog:repo');

export interface BacklogRepoOptions {
  /** Root of the source repository. */
  repoRoot: string;
  git?: GitRunner;
  branch?: string;
  /** Override the worktree location (default `.osiris/temp/backlog-worktree`). */
  worktreePath?: string;
  seedStates?: string[];
}

export interface TaskHistoryEntry {
  hash: string;
  date: string;
  subject: string;
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
    });
    return new BacklogRepo(git, worktreePath, branch);
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
    await this.commit([`${state}/${filename}`], `add: [${input.type}]-${String(id).padStart(4, '0')} ${input.title}`);
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

  /** Pull the latest orphan-branch state if it tracks a remote. Best-effort. */
  async sync(): Promise<void> {
    await this.git.run(['pull', '--ff-only'], { cwd: this.worktreePath });
  }
}
