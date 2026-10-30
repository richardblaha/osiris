import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DigitalTwin, DigitalTwinRelationship, DtdlInterface, DtdlModelData } from "@osiris/shared/dtdl.ts";
import { LocalDb, run, type Statement } from "@osiris/platform/rqlite.ts";
import { toRelationship, type SourceSnapshot, type SourceTwin } from "./twin.ts";

/**
 * The schema, version 2: everything belongs to an instance (a digital twin of its own, `instance`). The structure
 * (models, twins, relationships) is the sources' and is rebuilt by the next sync, so version 1's is dropped; its
 * dashboards and saved filters are kept, for the first instance (`claimLegacy`).
 */
const SCHEMA_VERSION = "2";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_type TEXT NOT NULL, settings TEXT NOT NULL, secrets TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS models (instance TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL, upload_time INTEGER NOT NULL, PRIMARY KEY (instance, id))`,
  `CREATE TABLE IF NOT EXISTS twins (instance TEXT NOT NULL, dt_id TEXT NOT NULL, model TEXT NOT NULL, contents TEXT NOT NULL, etag TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (instance, dt_id))`,
  `CREATE TABLE IF NOT EXISTS relationships (instance TEXT NOT NULL, source_id TEXT NOT NULL, relationship_id TEXT NOT NULL, name TEXT NOT NULL, target_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (instance, source_id, relationship_id))`,
  `CREATE INDEX IF NOT EXISTS relationships_target ON relationships (instance, target_id)`,
  `CREATE TABLE IF NOT EXISTS dashboards (instance TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (instance, id))`,
  `CREATE TABLE IF NOT EXISTS saved_filters (instance TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, filter TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (instance, owner, id))`,
];

/** Version 1 (one twin): its structure goes, its dashboards and filters wait for the first instance (`claimLegacy`). */
const FROM_V1 = [
  `DROP TABLE IF EXISTS models`,
  `DROP TABLE IF EXISTS twins`,
  `DROP TABLE IF EXISTS relationships`,
  `ALTER TABLE dashboards RENAME TO dashboards_v1`,
  `ALTER TABLE saved_filters RENAME TO saved_filters_v1`,
];

/** An instance as stored: its source's type and settings; its secrets sealed (never handed out). */
export interface InstanceRecord {
  id: string;
  name: string;
  sourceType: string;
  settings: Record<string, unknown>;
  /** Which secrets are set (their names only). */
  secretNames: string[];
  createdAt: number;
  updatedAt: number;
}

/** Seals and opens an instance's secrets (@osiris/platform's SecretBox). */
export interface Sealer {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

/** One panel of a dashboard: what it shows (logs, their bar chart, a metric, traces), its filter and width. */
export interface DashboardPanel {
  id: string;
  kind: "logs" | "logBars" | "metric" | "traces";
  title: string;
  /** Columns of four it spans. */
  width: number;
  /** The page's own filter values (service, namespace, pod, severity, q; a metric's name, type and grouping…). */
  filter: Record<string, string>;
}
/** A named dashboard everyone who sees the twin shares: its time range and its panels in order. */
export interface Dashboard {
  id: string;
  name: string;
  /** The time range its panels show, ms back from now. */
  range: number;
  panels: DashboardPanel[];
  updatedAt: number;
  updatedBy: string;
}

/** A filter a user saved for a telemetry page (`kind`: logs), as the page's own query values. */
export interface SavedFilter {
  id: string;
  kind: string;
  name: string;
  filter: Record<string, string>;
  createdAt: number;
}

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
 * Osiris Digital Twin's data in one SQLite file (DATA_DIR/twin.db; one replica, one writer): the instances (each a
 * digital twin of its own, with its source's settings and sealed secrets) and, per instance (`of`), its DTDL models,
 * twins and relationships, dashboards and users' saved filters. Time series (telemetry and history) stay in
 * OpenTelemetry's ClickHouse.
 */
export class TwinStore {
  private constructor(
    private readonly db: LocalDb,
    private readonly sealer: Sealer,
  ) {}

  static async open(path: string, sealer: Sealer = { seal: (s) => s, open: (s) => s }): Promise<TwinStore> {
    if (!path.startsWith(":")) mkdirSync(dirname(path), { recursive: true });
    const db = new LocalDb(path);
    await db.execute([run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)]);
    const version = (await db.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`))[0]?.value;
    if (version !== SCHEMA_VERSION) {
      const tables = new Set((await db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name));
      // A version 1 file (it has twins without instances): moved aside as described above.
      if (tables.has("twins") && !version) await db.execute(FROM_V1.filter((sql) => !/RENAME/.test(sql) || tables.has(sql.split(" ")[2]!)).map((sql) => run(sql)));
    }
    await db.execute([...SCHEMA.map((sql) => run(sql)), run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`, SCHEMA_VERSION)]);
    return new TwinStore(db, sealer);
  }

  close() {
    return this.db.close();
  }

  /** One instance's data. */
  of(instance: string): InstanceData {
    return new InstanceData(this.db, instance);
  }

  async instances(): Promise<InstanceRecord[]> {
    const rows = await this.db.query<InstanceRow>(`SELECT * FROM instances ORDER BY name COLLATE NOCASE, id`);
    return rows.map((r) => this.recordOf(r));
  }

  async instance(id: string): Promise<InstanceRecord | undefined> {
    const [r] = await this.db.query<InstanceRow>(`SELECT * FROM instances WHERE id = ?`, [id]);
    return r && this.recordOf(r);
  }

  /** An instance's secrets, opened (for its source only). */
  async secrets(id: string): Promise<Record<string, string>> {
    const [r] = await this.db.query<{ secrets: string }>(`SELECT secrets FROM instances WHERE id = ?`, [id]);
    return r ? this.openSecrets(r.secrets) : {};
  }

  /**
   * Creates or changes an instance: its name, source type and settings; of its secrets, a string sets one, null
   * removes it, and one not named stays as it was.
   */
  async putInstance(input: { id: string; name: string; sourceType: string; settings: Record<string, unknown>; secrets?: Record<string, string | null> }, now: number): Promise<InstanceRecord> {
    const [had] = await this.db.query<InstanceRow>(`SELECT * FROM instances WHERE id = ?`, [input.id]);
    const secrets = had ? this.openSecrets(had.secrets) : {};
    for (const [k, v] of Object.entries(input.secrets ?? {})) {
      if (v === null) delete secrets[k];
      else secrets[k] = v;
    }
    await this.db.execute([
      run(
        `INSERT OR REPLACE INTO instances (id, name, source_type, settings, secrets, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        input.id,
        input.name,
        input.sourceType,
        JSON.stringify(input.settings),
        this.sealer.seal(JSON.stringify(secrets)),
        had?.created_at ?? now,
        now,
      ),
    ]);
    return (await this.instance(input.id))!;
  }

  /** Removes an instance and everything that is its own. */
  async deleteInstance(id: string): Promise<boolean> {
    const results = await this.db.execute([
      run(`DELETE FROM instances WHERE id = ?`, id),
      ...["models", "twins", "relationships", "dashboards", "saved_filters"].map((t) => run(`DELETE FROM ${t} WHERE instance = ?`, id)),
      run(`DELETE FROM meta WHERE key LIKE ?`, `${id}:%`),
    ]);
    return (results[0]?.rowsAffected ?? 0) > 0;
  }

  /** Version 1's dashboards and saved filters, given to `instance` (the first one); once. */
  async claimLegacy(instance: string): Promise<void> {
    const tables = new Set((await this.db.query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name));
    const statements: Statement[] = [];
    if (tables.has("dashboards_v1"))
      statements.push(
        run(`INSERT OR IGNORE INTO dashboards (instance, id, name, definition, updated_at, updated_by) SELECT ?, id, name, definition, updated_at, updated_by FROM dashboards_v1`, instance),
        run(`DROP TABLE dashboards_v1`),
      );
    if (tables.has("saved_filters_v1"))
      statements.push(
        run(`INSERT OR IGNORE INTO saved_filters (instance, owner, id, kind, name, filter, created_at) SELECT ?, owner, id, kind, name, filter, created_at FROM saved_filters_v1`, instance),
        run(`DROP TABLE saved_filters_v1`),
      );
    // Version 1's meta (the history's checkpoint, the seeded dashboards) was the one twin's.
    for (const key of ["history.checkpoint_at", "dashboard-seeded:osiris"])
      statements.push(run(`INSERT OR IGNORE INTO meta (key, value) SELECT ?, value FROM meta WHERE key = ?`, `${instance}:${key}`, key), run(`DELETE FROM meta WHERE key = ?`, key));
    if (statements.length) await this.db.execute(statements);
  }

  private openSecrets(sealed: string): Record<string, string> {
    try {
      return JSON.parse(this.sealer.open(sealed)) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private recordOf(r: InstanceRow): InstanceRecord {
    return {
      id: r.id,
      name: r.name,
      sourceType: r.source_type,
      settings: JSON.parse(r.settings) as Record<string, unknown>,
      secretNames: Object.keys(this.openSecrets(r.secrets)).sort(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

interface InstanceRow {
  id: string;
  name: string;
  source_type: string;
  settings: string;
  secrets: string;
  created_at: number;
  updated_at: number;
}

/**
 * One instance's data: its DTDL models, twins and relationships (its source's, kept in step by the sync), its meta,
 * dashboards and users' saved filters.
 */
export class InstanceData {
  constructor(
    private readonly db: LocalDb,
    readonly instance: string,
  ) {}

  /** Writes the source's models (new or changed ones get a new upload time); ones it no longer has go. */
  async putModels(docs: DtdlInterface[], now: number): Promise<void> {
    const have = new Map((await this.db.query<{ id: string; document: string }>(`SELECT id, document FROM models WHERE instance = ?`, [this.instance])).map((r) => [r.id, r.document]));
    const statements: Statement[] = [];
    for (const doc of docs) {
      const json = JSON.stringify(doc);
      if (have.get(doc["@id"]) !== json) statements.push(run(`INSERT OR REPLACE INTO models (instance, id, document, upload_time) VALUES (?, ?, ?, ?)`, this.instance, doc["@id"], json, now));
      have.delete(doc["@id"]);
    }
    for (const id of have.keys()) statements.push(run(`DELETE FROM models WHERE instance = ? AND id = ?`, this.instance, id));
    await this.db.execute(statements);
  }

  async models(): Promise<DtdlModelData[]> {
    const rows = await this.db.query<{ id: string; document: string; upload_time: number }>(`SELECT id, document, upload_time FROM models WHERE instance = ? ORDER BY id`, [this.instance]);
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
    return (await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins WHERE instance = ? ORDER BY dt_id`, [this.instance])).map(twinOf);
  }

  async twin(id: string): Promise<DigitalTwin | undefined> {
    const [row] = await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins WHERE instance = ? AND dt_id = ?`, [this.instance, id]);
    return row && twinOf(row);
  }

  async relationships(filter: { source?: string; target?: string } = {}): Promise<DigitalTwinRelationship[]> {
    const where = filter.source ? `AND source_id = ?` : filter.target ? `AND target_id = ?` : "";
    const args = filter.source ? [filter.source] : filter.target ? [filter.target] : [];
    return (await this.db.query<RelRow>(`SELECT source_id, relationship_id, name, target_id FROM relationships WHERE instance = ? ${where} ORDER BY source_id, relationship_id`, [this.instance, ...args])).map(relOf);
  }

  /** The instance's own meta values (keys are kept apart per instance). */
  async meta(key: string): Promise<string | undefined> {
    return (await this.db.query<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [`${this.instance}:${key}`]))[0]?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.execute([run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `${this.instance}:${key}`, value)]);
  }

  /** The dashboards by name, without their panels. */
  async dashboards(): Promise<{ id: string; name: string; updatedAt: number }[]> {
    const rows = await this.db.query<{ id: string; name: string; updated_at: number }>(`SELECT id, name, updated_at FROM dashboards WHERE instance = ? ORDER BY name COLLATE NOCASE, id`, [this.instance]);
    return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }));
  }

  async dashboard(id: string): Promise<Dashboard | undefined> {
    const [r] = await this.db.query<{ id: string; name: string; definition: string; updated_at: number; updated_by: string }>(
      `SELECT id, name, definition, updated_at, updated_by FROM dashboards WHERE instance = ? AND id = ?`,
      [this.instance, id],
    );
    if (!r) return undefined;
    const d = JSON.parse(r.definition) as { range: number; panels: DashboardPanel[] };
    return { id: r.id, name: r.name, range: d.range, panels: d.panels, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }

  async countDashboards(): Promise<number> {
    return Number((await this.db.query<{ n: number }>(`SELECT count(*) AS n FROM dashboards WHERE instance = ?`, [this.instance]))[0]?.n ?? 0);
  }

  async saveDashboard(d: Dashboard): Promise<void> {
    await this.db.execute([
      run(
        `INSERT OR REPLACE INTO dashboards (instance, id, name, definition, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)`,
        this.instance,
        d.id,
        d.name,
        JSON.stringify({ range: d.range, panels: d.panels }),
        d.updatedAt,
        d.updatedBy,
      ),
    ]);
  }

  async deleteDashboard(id: string): Promise<boolean> {
    const [r] = await this.db.execute([run(`DELETE FROM dashboards WHERE instance = ? AND id = ?`, this.instance, id)]);
    return (r?.rowsAffected ?? 0) > 0;
  }

  /** A user's saved filters of one page, oldest first. */
  async savedFilters(owner: string, kind: string): Promise<SavedFilter[]> {
    const rows = await this.db.query<{ id: string; kind: string; name: string; filter: string; created_at: number }>(
      `SELECT id, kind, name, filter, created_at FROM saved_filters WHERE instance = ? AND owner = ? AND kind = ? ORDER BY created_at, id`,
      [this.instance, owner, kind],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, filter: JSON.parse(r.filter) as Record<string, string>, createdAt: r.created_at }));
  }

  async countSavedFilters(owner: string): Promise<number> {
    return Number((await this.db.query<{ n: number }>(`SELECT count(*) AS n FROM saved_filters WHERE instance = ? AND owner = ?`, [this.instance, owner]))[0]?.n ?? 0);
  }

  async saveFilter(owner: string, f: SavedFilter): Promise<void> {
    await this.db.execute([
      run(
        `INSERT OR REPLACE INTO saved_filters (instance, owner, id, kind, name, filter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        this.instance,
        owner,
        f.id,
        f.kind,
        f.name,
        JSON.stringify(f.filter),
        f.createdAt,
      ),
    ]);
  }

  /** Removes one of the user's own filters; false when they have none of that id. */
  async deleteFilter(owner: string, id: string): Promise<boolean> {
    const [r] = await this.db.execute([run(`DELETE FROM saved_filters WHERE instance = ? AND owner = ? AND id = ?`, this.instance, owner, id)]);
    return (r?.rowsAffected ?? 0) > 0;
  }

  /**
   * Makes the instance's twins and relationships what its source's snapshot says, in one transaction, and tells what
   * changed. An unchanged twin keeps its etag and update time.
   */
  async sync(snapshot: SourceSnapshot, now: number): Promise<SyncResult> {
    const i = this.instance;
    const before = new Map((await this.db.query<TwinRow>(`SELECT dt_id, model, contents, etag, updated_at FROM twins WHERE instance = ?`, [i])).map((r) => [r.dt_id, twinOf(r)]));
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
      statements.push(run(`INSERT OR REPLACE INTO twins (instance, dt_id, model, contents, etag, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, i, t.$dtId, t.$metadata.$model, JSON.stringify(contents), etag, now));
      if (!was) result.added.push(after);
      else {
        const old = contentsOf(was);
        const keys = [...new Set([...Object.keys(old), ...Object.keys(contents)])].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(contents[k])).sort();
        if (was.$metadata.$model !== t.$metadata.$model) keys.unshift("$model");
        result.changed.push({ before: was, after, changed: keys });
      }
    }
    for (const [id, was] of before)
      if (!seen.has(id)) {
        result.removed.push(was);
        statements.push(run(`DELETE FROM twins WHERE instance = ? AND dt_id = ?`, i, id));
      }

    const relsBefore = new Map(
      (await this.db.query<RelRow>(`SELECT source_id, relationship_id, name, target_id FROM relationships WHERE instance = ?`, [i])).map((r) => [`${r.source_id}\u0000${r.relationship_id}`, relOf(r)]),
    );
    const relsNow = new Set<string>();
    for (const r of snapshot.relationships.map(toRelationship)) {
      const key = `${r.$sourceId}\u0000${r.$relationshipId}`;
      if (relsNow.has(key)) continue;
      relsNow.add(key);
      if (relsBefore.has(key)) continue;
      result.relationshipsAdded.push(r);
      statements.push(run(`INSERT OR REPLACE INTO relationships (instance, source_id, relationship_id, name, target_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, i, r.$sourceId, r.$relationshipId, r.$relationshipName, r.$targetId, now));
    }
    for (const [key, r] of relsBefore)
      if (!relsNow.has(key)) {
        result.relationshipsRemoved.push(r);
        statements.push(run(`DELETE FROM relationships WHERE instance = ? AND source_id = ? AND relationship_id = ?`, i, r.$sourceId, r.$relationshipId));
      }
    await this.db.execute(statements);
    return result;
  }
}
