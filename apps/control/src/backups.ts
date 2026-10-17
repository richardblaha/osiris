import { Transform, type Readable } from "node:stream";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";

/** Why a snapshot was taken: before sleeping, daily while awake, on demand, or the import of pre-split data. */
export const BACKUP_REASON = /^[a-z][a-z-]{0,19}$/;
/** At least this many backups per tenant are kept, however old. */
const KEEP_MIN = 3;

export interface BackupInfo {
  key: string;
  bytes: number;
  reason: string;
  createdAt: number;
}

/**
 * Tenant snapshots (database + files, tar.gz) in object storage. Runtimes stream them here before sleeping and daily;
 * a runtime that starts on an empty volume restores the newest one. Control holds the storage credentials.
 */
export class Backups {
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectStore,
    private readonly retentionDays: number,
  ) {}

  async store(tenantId: string, body: Readable, reason: string, now = Date.now()): Promise<BackupInfo> {
    if (!BACKUP_REASON.test(reason)) throw new Error("Invalid backup reason");
    const key = `backups/${tenantId}/${new Date(now).toISOString().replace(/[:.]/g, "-")}-${reason}.tar.gz`;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    body.on("error", (err) => counter.destroy(err));
    await this.objects.put(key, body.pipe(counter), "application/gzip");
    await this.db.execute([run("INSERT INTO backups (key, tenant_id, bytes, reason, created_at) VALUES (?, ?, ?, ?, ?)", key, tenantId, bytes, reason, now)]);
    return { key, bytes, reason, createdAt: now };
  }

  async list(tenantId: string): Promise<BackupInfo[]> {
    const rows = await this.db.query<{ key: string; bytes: number; reason: string; created_at: number }>(
      "SELECT * FROM backups WHERE tenant_id = ? ORDER BY created_at DESC",
      [tenantId],
      { fresh: true },
    );
    return rows.map((r) => ({ key: r.key, bytes: Number(r.bytes), reason: r.reason, createdAt: Number(r.created_at) }));
  }

  async latest(tenantId: string): Promise<{ info: BackupInfo; body: Readable } | null> {
    for (const info of await this.list(tenantId)) {
      const obj = await this.objects.get(info.key);
      if (obj) return { info, body: obj.body };
    }
    return null;
  }

  /** Deletes backups older than the retention period, keeping the newest few of every tenant. */
  async prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60_000;
    const tenants = await this.db.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM backups");
    for (const { tenant_id } of tenants) {
      const old = (await this.list(tenant_id)).slice(KEEP_MIN).filter((b) => b.createdAt < cutoff);
      if (!old.length) continue;
      await this.objects.delete(old.map((b) => b.key));
      await this.db.execute(old.map((b) => run("DELETE FROM backups WHERE key = ?", b.key)));
    }
  }
}
