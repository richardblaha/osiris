import { createDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import type { TenantDbProvider } from "./provider.ts";
import { openTenant, type Tenant, type TenantDeps } from "./tenant.ts";

const IDS_TTL_MS = 60_000;

/**
 * Opens tenants lazily: on first access the tenant's database is located (and created if needed),
 * migrated, and its stores and agent graph are built. The result is cached for the process lifetime.
 */
export class TenantRegistry {
  private readonly open = new Map<string, Promise<Tenant>>();
  private known?: { at: number; ids: Promise<string[]> };

  constructor(
    private readonly provider: TenantDbProvider,
    private readonly deps: TenantDeps,
  ) {}

  /** Ids of every tenant database, including archived Turso ones. Cached for a minute; opening a tenant adds it. */
  async ids(): Promise<string[]> {
    if (!this.known || Date.now() - this.known.at > IDS_TTL_MS) {
      const loading = this.provider.list();
      loading.catch(() => {
        if (this.known?.ids === loading) this.known = undefined;
      });
      this.known = { at: Date.now(), ids: loading };
    }
    const ids = new Set(await this.known.ids);
    for (const id of this.open.keys()) ids.add(id);
    return [...ids].sort();
  }

  get(tenantId: string): Promise<Tenant> {
    let tenant = this.open.get(tenantId);
    if (!tenant) {
      tenant = this.connect(tenantId);
      // Don't cache failures (e.g. Turso briefly unavailable); the next request retries.
      tenant.catch(() => this.open.delete(tenantId));
      this.open.set(tenantId, tenant);
    }
    return tenant;
  }

  /** Closes a removed tenant and archives its database; the next `get` would start a fresh one. */
  async remove(tenantId: string): Promise<void> {
    const open = this.open.get(tenantId);
    this.open.delete(tenantId);
    const tenant = await open?.catch(() => undefined);
    if (tenant) {
      await tenant.mcp.close();
      tenant.db.close();
    }
    await this.provider.archive(tenantId);
    this.known = undefined;
  }

  private async connect(tenantId: string): Promise<Tenant> {
    const { url, authToken } = await this.provider.locate(tenantId);
    const db = createDb(url, authToken);
    const applied = await migrate(db);
    if (applied.length) console.log(`Tenant ${tenantId}: applied migrations ${applied.join(", ")}`);
    return openTenant(tenantId, db, this.deps);
  }
}
