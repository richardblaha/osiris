import { execa } from 'execa';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunOptions {
  cwd?: string;
  /** Extra environment for this one invocation (e.g. `GIT_COMMITTER_DATE`). */
  env?: Record<string, string>;
}

/** The slice of `git` this package needs. Swap for a fake in tests. */
export interface GitRunner {
  run(args: string[], options?: GitRunOptions): Promise<GitResult>;
}

export class ExecaGitRunner implements GitRunner {
  constructor(private readonly defaultCwd?: string) {}

  async run(args: string[], options: GitRunOptions = {}): Promise<GitResult> {
    const result = await execa('git', args, {
      cwd: options.cwd ?? this.defaultCwd,
      reject: false,
      env: {
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Osiris',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'osiris@localhost',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Osiris',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'osiris@localhost',
        ...options.env,
      },
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 0,
    };
  }
}

/** Records every invocation; returns queued or default-empty results. */
export class FakeGitRunner implements GitRunner {
  readonly calls: string[][] = [];
  private readonly responses = new Map<string, GitResult>();

  /** Match by a prefix of the joined args, e.g. `'rev-parse'`. */
  stub(argPrefix: string, result: Partial<GitResult>): void {
    this.responses.set(argPrefix, { stdout: '', stderr: '', exitCode: 0, ...result });
  }

  async run(args: string[]): Promise<GitResult> {
    this.calls.push(args);
    const joined = args.join(' ');
    for (const [prefix, result] of this.responses) {
      if (joined.startsWith(prefix)) return result;
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  /** Convenience for assertions: the git subcommands issued, in order. */
  subcommands(): string[] {
    return this.calls.map((c) => c.find((a) => !a.startsWith('-')) ?? '');
  }
}
