import { Transform, type Readable } from "node:stream";
import type { ObjectStore } from "@osiris/platform/objects.ts";
import { run, type Db } from "@osiris/platform/rqlite.ts";

/** Why a snapshot was taken: before sleeping, daily while awake, on demand, or the import of pre-split data. */
export const BACKUP_REASON = /^[a-z][a-z-]{0,19}$/;
/** At least this many backups per project are kept, however old. */
const KEEP_MIN = 3;

export interface BackupInfo {
  key: string;
  bytes: number;
  reason: string;
  createdAt: number;
}

/**
 * Project snapshots (database + files, tar.gz) in object storage. Runtimes stream them here before sleeping and daily;
 * a runtime that starts on an empty volume restores the newest one. Control holds the storage credentials.
 */
export class Backups {
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectStore,
    private readonly retentionDays: number,
  ) {}

  async store(projectId: string, body: Readable, reason: string, now = Date.now()): Promise<BackupInfo> {
    if (!BACKUP_REASON.test(reason)) throw new Error("Invalid backup reason");
    const key = `backups/${projectId}/${new Date(now).toISOString().replace(/[:.]/g, "-")}-${reason}.tar.gz`;
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    body.on("error", (err) => counter.destroy(err));
    await this.objects.put(key, body.pipe(counter), "application/gzip");
    await this.db.execute([run("INSERT INTO backups (key, project_id, bytes, reason, created_at) VALUES (?, ?, ?, ?, ?)", key, projectId, bytes, reason, now)]);
    return { key, bytes, reason, createdAt: now };
  }

  async list(projectId: string): Promise<BackupInfo[]> {
    const rows = await this.db.query<{ key: string; bytes: number; reason: string; created_at: number }>(
      "SELECT * FROM backups WHERE project_id = ? ORDER BY created_at DESC",
      [projectId],
      { fresh: true },
    );
    return rows.map((r) => ({ key: r.key, bytes: Number(r.bytes), reason: r.reason, createdAt: Number(r.created_at) }));
  }

  /** Every project's newest backup, by project. */
  async newest(): Promise<Map<string, BackupInfo>> {
    const rows = await this.db.query<{ project_id: string; key: string; bytes: number; reason: string; created_at: number }>(
      `SELECT b.project_id, b.key, b.bytes, b.reason, b.created_at FROM backups b
       JOIN (SELECT project_id, MAX(created_at) AS m FROM backups GROUP BY project_id) x ON x.project_id = b.project_id AND x.m = b.created_at`,
    );
    return new Map(rows.map((r) => [r.project_id, { key: r.key, bytes: Number(r.bytes), reason: r.reason, createdAt: Number(r.created_at) }]));
  }

  async latest(projectId: string): Promise<{ info: BackupInfo; body: Readable } | null> {
    for (const info of await this.list(projectId)) {
      const obj = await this.objects.get(info.key);
      if (obj) return { info, body: obj.body };
    }
    return null;
  }

  /** Deletes backups older than the retention period, keeping the newest few of every project. */
  async prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * 24 * 60 * 60_000;
    const projects = await this.db.query<{ project_id: string }>("SELECT DISTINCT project_id FROM backups");
    for (const { project_id } of projects) {
      const old = (await this.list(project_id)).slice(KEEP_MIN).filter((b) => b.createdAt < cutoff);
      if (!old.length) continue;
      await this.objects.delete(old.map((b) => b.key));
      await this.db.execute(old.map((b) => run("DELETE FROM backups WHERE key = ?", b.key)));
    }
  }
}
