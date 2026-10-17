import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createClient } from "@libsql/client";
import * as tar from "tar";
import type { TenantFeatures } from "@osiris/shared";
import { run, type Db } from "@osiris/platform/rqlite.ts";
import { SecretBox } from "@osiris/platform/secrets.ts";
import type { Backups } from "../backups.ts";

export interface LegacyTenant {
  id: string;
  /** The monolith's database of the tenant (`TENANT_DATA_DIR/<id>.db`). */
  dbFile: string;
  /** The monolith's files of the tenant (`FILES_DIR/<id>`), if any. */
  filesDir?: string;
}

/**
 * Brings one tenant from the monolith into the split setup: its name, features and archived flag go to the central
 * database, its secrets are re-sealed with the tenant's own key, and database + files become a backup the tenant's
 * runtime restores on first start. The monolith's files are only read.
 */
export async function importLegacyTenant(
  t: LegacyTenant,
  deps: { db: Db; backups: Backups; oldKey: string; newKey: string },
): Promise<{ name: string; archived: boolean; resealed: number }> {
  const work = await mkdtemp(join(tmpdir(), `osiris-import-${t.id}-`));
  try {
    await mkdir(join(work, "db"), { recursive: true });
    const copyPath = join(work, "db", "tenant.db");
    const source = createClient({ url: `file:${t.dbFile}` });
    await source.execute(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
    source.close();

    const copy = createClient({ url: `file:${copyPath}` });
    const settings = new Map(
      (await copy.execute("SELECT key, value FROM tenant_settings").catch(() => ({ rows: [] }))).rows.map((r) => [String(r.key), JSON.parse(String(r.value)) as unknown]),
    );
    const name = typeof settings.get("name") === "string" && settings.get("name") ? String(settings.get("name")) : t.id;
    const archived = settings.get("archived") === true;
    const features = (settings.get("features") ?? {}) as Partial<TenantFeatures>;

    // Re-seal with the tenant's derived key: the runtime never gets the old shared key.
    const oldBox = new SecretBox(deps.oldKey);
    const newBox = new SecretBox(deps.newKey);
    let resealed = 0;
    for (const r of (await copy.execute("SELECT owner, name, value_enc FROM secrets")).rows) {
      await copy.execute({ sql: "UPDATE secrets SET value_enc = ? WHERE owner = ? AND name = ?", args: [newBox.seal(oldBox.open(String(r.value_enc))), String(r.owner), String(r.name)] });
      resealed++;
    }
    for (const r of (await copy.execute("SELECT owner, name, headers_enc FROM mcp_servers WHERE headers_enc IS NOT NULL")).rows) {
      await copy.execute({ sql: "UPDATE mcp_servers SET headers_enc = ? WHERE owner = ? AND name = ?", args: [newBox.seal(oldBox.open(String(r.headers_enc))), String(r.owner), String(r.name)] });
      resealed++;
    }
    copy.close();

    const now = Date.now();
    await deps.db.execute([
      run(
        `INSERT INTO tenants (id, name, status, features, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        t.id,
        name,
        archived ? "archived" : "active",
        JSON.stringify(features),
        now,
        now,
      ),
    ]);

    if (t.filesDir && existsSync(t.filesDir)) await symlink(t.filesDir, join(work, "files"));
    else await mkdir(join(work, "files"));
    const archive = Readable.from(tar.c({ gzip: true, cwd: work, follow: true, portable: true }, ["db", "files"]));
    await deps.backups.store(t.id, archive, "import");
    return { name, archived, resealed };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
