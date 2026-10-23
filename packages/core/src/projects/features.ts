import type { Client } from "@libsql/client";
import { FEATURES, NO_QUOTAS, type Feature, type Guard, type ProjectFeatures, type UserDefaults, type ProjectQuotas } from "@osiris/shared";

/** Everything is on until a system admin switches it off, so existing projects keep working. */
export const DEFAULT_FEATURES: ProjectFeatures = Object.fromEntries(FEATURES.map((f) => [f, true])) as ProjectFeatures;

/** Which features the project may use. Read on every agent step, so implementations cache. */
export interface FeatureSource {
  get(): Promise<ProjectFeatures>;
  enabled(feature: Feature): Promise<boolean>;
  /** Built-in tools a system admin switched off for the project, by name. */
  disabledTools(): Promise<string[]>;
  /** The project's limits (storage, tokens per month, ...). */
  quotas(): Promise<ProjectQuotas>;
  /** Rules for every project, set by system admins; they come before the project's and the user's. */
  systemGuards(): Promise<Guard[]>;
  /** The system's defaults for users' assistant settings. */
  userDefaults?(): Promise<Partial<UserDefaults>>;
}

/**
 * Features kept in the project's own database (`project_settings.features`): the monolith's store, read now only to
 * import pre-split projects. Runtimes get their features from control.
 */
export class ProjectFeatureStore implements FeatureSource {
  private cached?: Promise<ProjectFeatures>;

  constructor(private readonly db: Client) {}

  get(): Promise<ProjectFeatures> {
    return (this.cached ??= this.load().catch((err) => {
      this.cached = undefined;
      throw err;
    }));
  }

  async enabled(feature: Feature): Promise<boolean> {
    return (await this.get())[feature];
  }

  /** The monolith had no per-tool switches or quotas. */
  async disabledTools(): Promise<string[]> {
    return [];
  }

  async quotas(): Promise<ProjectQuotas> {
    return NO_QUOTAS;
  }

  async systemGuards(): Promise<Guard[]> {
    return [];
  }

  async set(changes: Partial<ProjectFeatures>): Promise<ProjectFeatures> {
    const features = { ...(await this.get()), ...changes };
    await this.db.execute({
      sql: `INSERT INTO project_settings (key, value) VALUES ('features', ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [JSON.stringify(features)],
    });
    this.cached = Promise.resolve(features);
    return features;
  }

  private async load(): Promise<ProjectFeatures> {
    const { rows } = await this.db.execute("SELECT value FROM project_settings WHERE key = 'features'");
    const stored = rows[0] ? (JSON.parse(String(rows[0].value)) as Partial<ProjectFeatures>) : {};
    // Features added later default to on.
    return Object.fromEntries(FEATURES.map((f) => [f, stored[f] ?? DEFAULT_FEATURES[f]])) as ProjectFeatures;
  }
}

/** The project's own record in `project_settings`: its display name, and whether it was removed (a kept Turso database). */
export class ProjectProfileStore {
  private cached?: Promise<{ name: string | null; archived: boolean }>;

  constructor(private readonly db: Client) {}

  async name(): Promise<string | null> {
    return (await this.get()).name;
  }

  async archived(): Promise<boolean> {
    return (await this.get()).archived;
  }

  async setName(name: string): Promise<void> {
    await this.put("name", name);
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.put("archived", archived);
  }

  private get() {
    return (this.cached ??= this.db.execute("SELECT key, value FROM project_settings WHERE key IN ('name', 'archived')").then(
      ({ rows }) => {
        const value = (key: string) => {
          const row = rows.find((r) => r.key === key);
          return row ? (JSON.parse(String(row.value)) as unknown) : undefined;
        };
        const name = value("name");
        return { name: typeof name === "string" && name ? name : null, archived: value("archived") === true };
      },
      (err) => {
        this.cached = undefined;
        throw err;
      },
    ));
  }

  private async put(key: string, value: unknown) {
    await this.db.execute({
      sql: `INSERT INTO project_settings (key, value) VALUES (?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, JSON.stringify(value)],
    });
    this.cached = undefined;
  }
}
