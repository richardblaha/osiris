import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DbLocation {
  url: string;
  authToken?: string;
}

/** Finds a tenant's database, creating it on first use. `tenantId` is a validated slug (see auth/tenants.ts). */
export interface TenantDbProvider {
  locate(tenantId: string): Promise<DbLocation>;
  /** Takes a removed tenant's database out of use but keeps its data. Called after the tenant's client is closed. */
  archive(tenantId: string): Promise<void>;
}

/** Local development: one SQLite file per tenant, `<dir>/<tenant>.db`. */
export function fileProvider(dir: string): TenantDbProvider {
  return {
    async locate(tenantId) {
      return { url: `file:${join(resolve(dir), `${tenantId}.db`)}` };
    },
    // Renamed rather than deleted: a new tenant with the same slug starts empty and the old data can be restored.
    async archive(tenantId) {
      const base = join(resolve(dir), `${tenantId}.db`);
      const archived = `${base}.deleted-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(base + suffix)) renameSync(base + suffix, archived + suffix);
      }
    },
  };
}

export interface TursoOptions {
  org: string;
  /** Turso group the databases are created in; its token (`dbToken`) opens every database in the group. */
  group: string;
  /** Platform API token, used only to look up and create databases. */
  apiToken: string;
  dbToken: string;
  /** Database name is `<prefix><tenant>`. */
  prefix: string;
  fetch?: typeof fetch;
}

/** Production: one Turso database per tenant, created through the Platform API on first use. */
export function tursoProvider({ org, group, apiToken, dbToken, prefix, fetch: f = fetch }: TursoOptions): TenantDbProvider {
  const base = `https://api.turso.tech/v1/organizations/${encodeURIComponent(org)}/databases`;
  const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" };

  const hostname = async (res: Response, action: string) => {
    if (!res.ok) throw new Error(`Turso ${action} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { database: { Hostname: string } }).database.Hostname;
  };

  return {
    async locate(tenantId) {
      const name = `${prefix}${tenantId}`;
      if (name.length > 64) throw new Error(`Turso database name too long: ${name}`);

      let res = await f(`${base}/${name}`, { headers });
      if (res.status === 404) {
        res = await f(base, { method: "POST", headers, body: JSON.stringify({ name, group }) });
        // Another replica created it meanwhile.
        if (res.status === 409) res = await f(`${base}/${name}`, { headers });
      }
      return { url: `libsql://${await hostname(res, `lookup of ${name}`)}`, authToken: dbToken };
    },
    // Turso databases can't be renamed, so the database is kept as is: recreating the slug brings the data back.
    async archive(tenantId) {
      console.warn(`Tenant ${tenantId} removed; Turso database ${prefix}${tenantId} is kept.`);
    },
  };
}
