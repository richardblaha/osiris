import type { Client } from "@libsql/client";
import { FEATURES, NO_QUOTAS, type Feature, type TenantFeatures, type TenantQuotas } from "@osiris/shared";

/** Everything is on until a system admin switches it off, so existing tenants keep working. */
export const DEFAULT_FEATURES: TenantFeatures = Object.fromEntries(FEATURES.map((f) => [f, true])) as TenantFeatures;

/** Which features the tenant may use. Read on every agent step, so implementations cache. */
export interface FeatureSource {
  get(): Promise<TenantFeatures>;
  enabled(feature: Feature): Promise<boolean>;
  /** Built-in tools a system admin switched off for the tenant, by name. */
  disabledTools(): Promise<string[]>;
  /** The tenant's limits (storage, tokens per month, ...). */
  quotas(): Promise<TenantQuotas>;
  /** Rules for every tenant, set by system admins; they come before the tenant's and the user's. */
  systemGuards(): Promise<string>;
}

/**
 * Features kept in the tenant's own database (`tenant_settings.features`): the monolith's store, read now only to
 * import pre-split tenants. Runtimes get their features from control.
 */
export class TenantFeatureStore implements FeatureSource {
  private cached?: Promise<TenantFeatures>;

  constructor(private readonly db: Client) {}

  get(): Promise<TenantFeatures> {
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

  async quotas(): Promise<TenantQuotas> {
    return NO_QUOTAS;
  }

  async systemGuards(): Promise<string> {
    return "";
  }

  async set(changes: Partial<TenantFeatures>): Promise<TenantFeatures> {
    const features = { ...(await this.get()), ...changes };
    await this.db.execute({
      sql: `INSERT INTO tenant_settings (key, value) VALUES ('features', ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [JSON.stringify(features)],
    });
    this.cached = Promise.resolve(features);
    return features;
  }

  private async load(): Promise<TenantFeatures> {
    const { rows } = await this.db.execute("SELECT value FROM tenant_settings WHERE key = 'features'");
    const stored = rows[0] ? (JSON.parse(String(rows[0].value)) as Partial<TenantFeatures>) : {};
    // Features added later default to on.
    return Object.fromEntries(FEATURES.map((f) => [f, stored[f] ?? DEFAULT_FEATURES[f]])) as TenantFeatures;
  }
}

/** The tenant's own record in `tenant_settings`: its display name, and whether it was removed (a kept Turso database). */
export class TenantProfileStore {
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
    return (this.cached ??= this.db.execute("SELECT key, value FROM tenant_settings WHERE key IN ('name', 'archived')").then(
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
      sql: `INSERT INTO tenant_settings (key, value) VALUES (?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, JSON.stringify(value)],
    });
    this.cached = undefined;
  }
}
