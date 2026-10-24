/** What should run for a project: the spec of its `Project` resource. */
export interface ProjectSpec {
  id: string;
  name: string;
  /** Archived projects: runtime stopped and never woken, data kept. */
  suspended: boolean;
  /** Minutes without activity before the runtime sleeps; 0 = always on. */
  idleMinutes: number;
  storageGb: number;
}

/** Runs project runtimes: the operator through `Project` resources in the cluster, child processes locally. */
export interface Orchestrator {
  apply(spec: ProjectSpec): Promise<void>;
  /** Asks for the runtime to be started; returns at once. */
  wake(id: string): Promise<void>;
  /** Base URL of the project's runtime. */
  endpoint(id: string): string;
  close?(): Promise<void>;
  /** What runs now, by project (the operator's `Project` status); projects missing there are unknown. */
  statuses(): Promise<Map<string, ProjectStatus>>;
}

export interface ProjectStatus {
  phase: "Running" | "Sleeping" | "Suspended" | "Unknown";
  /** ISO time. */
  lastActivity?: string;
  /** The operator's last problem with it. */
  message?: string;
}
