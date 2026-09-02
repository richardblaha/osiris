/**
 * The list of projects Osiris has opened in a DevContainer, kept in the
 * extension's global state. It powers the Osiris Start view, the "restore last
 * project on launch" preference, and lets the remote authority resolver rebuild
 * a container it can no longer find (hash → host path).
 */

export interface RecentProject {
  /** Absolute host path of the project folder. */
  hostPath: string;
  /** Display name (folder basename). */
  name: string;
  /** `devcontainerHash(hostPath)` — the authority suffix and container id-label. */
  hash: string;
  /** Port the in-container server was told to listen on. */
  serverPort: number;
  /** ISO timestamp of the most recent open. */
  lastOpenedAt: string;
}

/** The `vscode.Memento` shape, so this module needs no `vscode` import. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = 'osiris.recentProjects';
const DEFAULT_CAP = 12;

/** Newest first. */
export function sortRecent(projects: RecentProject[]): RecentProject[] {
  return [...projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

/** Merge `entry` in (de-duped by hash), newest first, capped. */
export function upsertRecent(
  projects: RecentProject[],
  entry: RecentProject,
  cap: number = DEFAULT_CAP,
): RecentProject[] {
  const rest = projects.filter((p) => p.hash !== entry.hash);
  return sortRecent([entry, ...rest]).slice(0, cap);
}

export class RecentProjectsStore {
  constructor(
    private readonly memento: KeyValueStore,
    private readonly cap: number = DEFAULT_CAP,
  ) {}

  list(): RecentProject[] {
    return sortRecent(this.memento.get<RecentProject[]>(KEY) ?? []);
  }

  find(hash: string): RecentProject | undefined {
    return this.list().find((p) => p.hash === hash);
  }

  async remember(entry: Omit<RecentProject, 'lastOpenedAt'>): Promise<void> {
    const full: RecentProject = { ...entry, lastOpenedAt: new Date().toISOString() };
    await this.memento.update(KEY, upsertRecent(this.list(), full, this.cap));
  }

  async forget(hash: string): Promise<void> {
    await this.memento.update(
      KEY,
      this.list().filter((p) => p.hash !== hash),
    );
  }

  /** Drop entries whose host folder no longer exists. */
  async prune(exists: (hostPath: string) => boolean | Promise<boolean>): Promise<RecentProject[]> {
    const kept: RecentProject[] = [];
    for (const project of this.list()) {
      if (await exists(project.hostPath)) kept.push(project);
    }
    if (kept.length !== this.list().length) await this.memento.update(KEY, kept);
    return kept;
  }
}
