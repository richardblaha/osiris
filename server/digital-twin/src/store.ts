import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DigitalTwin, DigitalTwinRelationship, DtdlInterface, DtdlModelData } from "@osiris/shared/dtdl.ts";
import { LocalDb, run, type Statement } from "@osiris/platform/rqlite.ts";
import { toRelationship, type SourceSnapshot, type SourceTwin } from "./twin.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, source TEXT NOT NULL, document TEXT NOT NULL, upload_time INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS twins (dt_id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT NOT NULL, contents TEXT NOT NULL, etag TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS relationships (source_id TEXT NOT NULL, relationship_id TEXT NOT NULL, name TEXT NOT NULL, target_id TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (source_id, relationship_id))`,
  `CREATE INDEX IF NOT EXISTS relationships_target ON relationships (target_id)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

/** A twin's properties: everything but the `$` fields. */
const contentsOf = (t: SourceTwin | DigitalTwin) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("$")).sort(([a], [b]) => a.localeCompare(b)));
const etagOf = (model: string, contents: Record<string, unknown>) => `W/"${createHash("sha256").update(JSON.stringify([model, contents])).digest("hex").slice(0, 20)}"`;
const iso = (ms: number) => new Date(ms).toISOString();

interface TwinRow {
  dt_id: string;
  model: string;
  contents: string;
  etag: string;
  updated_at: number;
}
interface RelRow {
  source_id: string;
  relationship_id: string;
  name: string;
  target_id: string;
}

const twinOf = (r: TwinRow): DigitalTwin => ({
  $dtId: r.dt_id,
  $etag: r.etag,
  $metadata: { $model: r.model, $lastUpdateTime: iso(r.updated_at) },
  ...(JSON.parse(r.contents) as Record<string, unknown>),
});
const relOf = (r: RelRow): DigitalTwinRelationship => ({ $relationshipId: r.relationship_id, $sourceId: r.source_id, $relationshipName: r.name, $targetId: r.target_id });

/** What a sync changed: the history writes it (and a checkpoint writes everything). */
export interface SyncResult {
  ts: number;
  added: DigitalTwin[];
  changed: { before: DigitalTwin; after: DigitalTwin; changed: string[] }[];
  removed: DigitalTwin[];
  relationshipsAdded: DigitalTwinRelationship[];
  relationshipsRemoved: DigitalTwinRelationship[];
}

/**
 * The twin's structure in one SQLite file (DATA_DIR/twin.db; one replica, one writer): the DTDL models, the twins and
 * their relationships, each owned by the adapter that wrote it. Time series (telemetry and history) stay in
 * OpenTelemetry's ClickHouse.
 */
export class TwinStore {
  private constructor(private readonly db: LocalDb) {}

  static async open(path: string): Promise<TwinStore> {
    if (!path.startsWith(":")) mkdirSync(dirname(path), { recursive: true });
    const db = new LocalDb(path);
    await db.execute(SCHEMA.map((sql) => run(sql)));
    return new TwinStore(db);
  }

  close() {
    return this.db.close();
  }

  /** Writes an adapter's models (new or changed ones get a new upload time); ones it no longer has go. */
  async putModels(source: string, docs: DtdlInterface[], now: number): Promise<void> {
    const have = new Map((await this.db.query<{ id: string; document: string }>(`SELECT id, document FROM models WHERE source = ?`, [source])).map((r) => [r.id, r.document]));
    const statements: Statement[] = [];
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      if (have.get(doc["@id"]) !== json) statements.push(run(`INSERT OR REPLACE INTO models (id, source, document, upload_time) VALUES (?, ?, ?, ?)`, doc["@id"], source, json, now));
      have.delete(doc["@id"]);
    }
    for (const id of have.keys()) statements.push(run(`DELETE FROM models WHERE id = ? AND source = ?`, id, source));
    await this.db.execute(statements);
  }

  async models(): Promise<DtdlModelData[]> {
    const rows = await this.db.query<{ id: string; document: string; upload_time: number }>(`SELECT id, document, upload_time FROM models ORDER BY id`);
    return rows.map((r) => {
      const model = JSON.parse(r.document) as DtdlInterface;
      return {
        id: r.id,
        ...(model.displayName ? { displayName: typeof model.displayName === "string" ? { en: model.displayName } : model.displayName } : {}),
        ...(model.description ? { description: typeof model.description === "string" ? { en: model.description } : model.description } : {}),
        uploadTime: iso(r.upload_time),
        decommissioned: false,
        model,
      };
    });
  }

  async twins(): Promise<DigitalTwin[]> {
    return (await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins ORDER BY dt_id`)).map(twinOf);
  }

  async twin(id: string): Promise<DigitalTwin | undefined> {
    const [row] = await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins WHERE dt_id = ?`, [id]);
    return row && twinOf(row);
  }

  async relationships(filter: { source?: string; target?: string } = {}): Promise<DigitalTwinRelationship[]> {
    const where = filter.source ? `WHERE source_id = ?` : filter.target ? `WHERE target_id = ?` : "";
    const args = filter.source ? [filter.source] : filter.target ? [filter.target] : [];
    return (await this.db.query<RelRow>(`SELECT source_id, relationship_id, name, target_id FROM relationships ${where} ORDER BY source_id, relationship_id`, args)).map(relOf);
  }

  async meta(key: string): Promise<string | undefined> {
    return (await this.db.query<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]))[0]?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.execute([run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value)]);
  }

  /**
   * Makes the adapter's twins and relationships what its snapshot says, in one transaction, and tells what changed.
   * An unchanged twin keeps its etag and update time.
   */
  async sync(source: string, snapshot: SourceSnapshot, now: number): Promise<SyncResult> {
    const before = new Map((await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins WHERE source = ?`, [source])).map((r) => [r.dt_id, twinOf(r)]));
    const result: SyncResult = { ts: now, added: [], changed: [], removed: [], relationshipsAdded: [], relationshipsRemoved: [] };
    const statements: Statement[] = [];
    const seen = new Set<string>();
    for (const t of snapshot.twins) {
      if (seen.has(t.$dtId)) continue;
      seen.add(t.$dtId);
      const contents = contentsOf(t);
      const etag = etagOf(t.$metadata.$model, contents);
      const was = before.get(t.$dtId);
      if (was?.$etag === etag) continue;
      const after: DigitalTwin = { $dtId: t.$dtId, $etag: etag, $metadata: { $model: t.$metadata.$model, $lastUpdateTime: iso(now) }, ...contents };
      statements.push(run(`INSERT OR REPLACE INTO twins (dt_id, source, model, contents, etag, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, t.$dtId, source, t.$metadata.$model, JSON.stringify(contents), etag, now));
      if (!was) result.added.push(after);
      else {
        const old = contentsOf(was);
        const keys = [...new Set([...Object.keys(old), ...Object.keys(contents)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(contents[k])).sort();
        if (was.$metadata.$model !== t.$metadata.$model) keys.unshift("$model");
        result.changed.push({ before: was, after, changed: keys });
      }
    }
    for (const [id, was] of before) if (!seen.has(id)) {
      result.removed.push(was);
      statements.push(run(`DELETE FROM twins WHERE dt_id = ?`, id));
    }

    const relsBefore = new Map((await this.db.query<RelRow>(`SELECT source_id, relationship_id, name, target_id FROM relationships WHERE source = ?`, [source])).map((r) => [`${r.source_id}\u0000${r.relationship_id}`, relOf(r)]));
    const relsNow = new Set<string>();
    for (const r of snapshot.relationships.map(toRelationship)) {
      const key = `${r.$sourceId}\u0000${r.$relationshipId}`;
      if (relsNow.has(key)) continue;
      relsNow.add(key);
      if (relsBefore.has(key)) continue;
      result.relationshipsAdded.push(r);
      statements.push(run(`INSERT OR REPLACE INTO relationships (source_id, relationship_id, name, target_id, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, r.$sourceId, r.$relationshipId, r.$relationshipName, r.$targetId, source, now));
    }
    for (const [key, r] of relsBefore) if (!relsNow.has(key)) {
      result.relationshipsRemoved.push(r);
      statements.push(run(`DELETE FROM relationships WHERE source_id = ? AND relationship_id = ?`, r.$sourceId, r.$relationshipId));
    }
    await this.db.execute(statements);
    return result;
  }
}
