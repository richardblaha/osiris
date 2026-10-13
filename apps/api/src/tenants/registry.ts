import { createDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import type { TenantDbProvider } from "./provider.ts";
import { openTenant, type Tenant, type TenantDeps } from "./tenant.ts";

/**
 * Opens tenants lazily: on first access the tenant's database is located (and created if needed),
 * migrated, and its stores and agent graph are built. The result is cached for the process lifetime.
 */
export class TenantRegistry {
  private readonly open = new Map<string, Promise<Tenant>>();

  constructor(
    private readonly provider: TenantDbProvider,
    private readonly deps: TenantDeps,
  ) {}

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

  private async connect(tenantId: string): Promise<Tenant> {
    const { url, authToken } = await this.provider.locate(tenantId);
    const db = createDb(url, authToken);
    const applied = await migrate(db);
    if (applied.length) console.log(`Tenant ${tenantId}: applied migrations ${applied.join(", ")}`);
    return openTenant(tenantId, db, this.deps);
  }
}
