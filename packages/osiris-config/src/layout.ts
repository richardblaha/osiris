import { join } from 'node:path';

/** The workspace config directory name. Osiris reads `.vscode` as `.osiris`. */
export const OSIRIS_DIR = '.osiris';

/**
 * Sub-folders of `.osiris/`. `temp` is always git-ignored; the rest are
 * committed (on their normal branches, except `backlog/` which is managed on an
 * orphan branch — see `@richardblaha/osiris-backlog`).
 */
export const OSIRIS_SUBDIRS = ['agents', 'memory', 'backlog', 'actions', 'temp'] as const;
export type OsirisSubdir = (typeof OSIRIS_SUBDIRS)[number];

/** Config files at `.osiris/` root that carry platform (non-editor) settings. */
export const OSIRIS_CONFIG_FILES = ['crew.json', 'memory.json', 'mcp.json'] as const;
export type OsirisConfigFile = (typeof OSIRIS_CONFIG_FILES)[number];

/** Path within `.osiris/temp/` that never enters git. */
export const OSIRIS_TEMP_GITIGNORE_ENTRY = `${OSIRIS_DIR}/temp/`;

/**
 * Absolute paths for one workspace's `.osiris/` tree. Construct with a project
 * root; every getter is a pure `path.join`, no I/O.
 */
export class OsirisPaths {
  constructor(readonly root: string) {}

  /** `<root>/.osiris` */
  get dir(): string {
    return join(this.root, OSIRIS_DIR);
  }

  subdir(name: OsirisSubdir): string {
    return join(this.dir, name);
  }

  get agents(): string {
    return this.subdir('agents');
  }
  get memory(): string {
    return this.subdir('memory');
  }
  get backlog(): string {
    return this.subdir('backlog');
  }
  get actions(): string {
    return this.subdir('actions');
  }
  get temp(): string {
    return this.subdir('temp');
  }

  configFile(name: OsirisConfigFile): string {
    return join(this.dir, name);
  }

  /** A file under `.osiris/temp/` (agent scratchpads, caches, worktrees). */
  tempFile(...segments: string[]): string {
    return join(this.temp, ...segments);
  }

  /** An arbitrary path relative to `.osiris/` (e.g. `agents/architect.md`). */
  resolve(relative: string): string {
    return join(this.dir, relative);
  }
}

export function osirisPaths(root: string): OsirisPaths {
  return new OsirisPaths(root);
}
