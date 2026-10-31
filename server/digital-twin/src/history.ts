import type { TwinChange, TwinStatus } from "@osiris/shared";
import type { DigitalTwin, DigitalTwinRelationship } from "@osiris/shared/dtdl.ts";
import type { SyncResult } from "./state.ts";
import type { ClickHouse } from "./telemetry.ts";
import { CONTAINS } from "./twin.ts";

/** A full checkpoint once a day: the state at any time is the newest checkpoint before it plus the changes after. */
export const CHECKPOINT_MS = 24 * 3_600_000;
export const ENTITY_EVENT = "twin.entity";
export const RELATIONSHIP_EVENT = "twin.relationship";

/** Emits one OpenTelemetry log record (`eventEmitter` of @osiris/platform/telemetry.ts). */
export type Emit = (name: string, attributes: Record<string, string>, timestampMs: number) => void;

const contentsOf = (t: DigitalTwin) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("$")));

/** The ids up the contains tree, nearest first: a twin's history includes its descendants' changes. */
function ancestorsOf(relationships: DigitalTwinRelationship[]): (id: string) => string[] {
  const parent = new Map<string, string>();
  for (const r of relationships) if (r.$relationshipName === CONTAINS && !parent.has(r.$targetId)) parent.set(r.$targetId, r.$sourceId);
  return (id) => {
    const chain: string[] = [];
    const seen = new Set([id]);
    for (let p = parent.get(id); p && !seen.has(p); p = parent.get(p)) {
      chain.push(p);
      seen.add(p);
    }
    return chain;
  };
}

/**
 * The twin's history as OpenTelemetry events: every change a sync makes (and a checkpoint of everything once a day)
 * goes out as a log record through the collector into ClickHouse's `otel_logs`, next to the rest of the telemetry.
 * The twin keeps no history of its own.
 */
export class HistoryLog {
  constructor(
    private readonly emit: Emit,
    /** The twin's name (CLUSTER_NAME), so one otel_logs holds the history of several twins. */
    private readonly twin: string,
    private readonly source: string,
  ) {}

  private entity(change: string, t: DigitalTwin, ancestors: string[], ts: number, extra: Record<string, string> = {}) {
    this.emit(
      ENTITY_EVENT,
      {
        "twin.id": this.twin,
        "twin.source": this.source,
        "twin.change": change,
        "dt.id": t.$dtId,
        "dt.model": t.$metadata.$model,
        "dt.name": String(t.name ?? ""),
        "dt.status": String(t.status ?? ""),
        "dt.contents": JSON.stringify(contentsOf(t)),
        "dt.ancestors": JSON.stringify(ancestors),
        ...extra,
      },
      ts,
    );
  }

  private relationship(change: string, r: DigitalTwinRelationship, ts: number) {
    this.emit(
      RELATIONSHIP_EVENT,
      { "twin.id": this.twin, "twin.source": this.source, "twin.change": change, "rel.id": r.$relationshipId, "rel.name": r.$relationshipName, "rel.source": r.$sourceId, "rel.target": r.$targetId },
      ts,
    );
  }

  /**
   * Writes a sync's changes, and with `all` (a checkpoint) every twin and relationship as they are now. `current` are
   * the relationships after the sync (for the ancestors). Returns the events sent.
   */
  record(result: SyncResult, current: DigitalTwinRelationship[], all?: { twins: DigitalTwin[] }): number {
    const ts = result.ts;
    // Ancestors from the relationships as they are now, and for removed twins as they were.
    const up = ancestorsOf([...current, ...result.relationshipsRemoved]);
    let n = 0;
    const count = () => void n++;
    for (const r of result.relationshipsAdded) (this.relationship("added", r, ts), count());
    for (const r of result.relationshipsRemoved) (this.relationship("removed", r, ts), count());
    for (const t of result.added) (this.entity("added", t, up(t.$dtId), ts), count());
    for (const { before, after, changed } of result.changed)
      (this.entity("changed", after, up(after.$dtId), ts, { "dt.previous_status": String(before.status ?? ""), "dt.changed": JSON.stringify(changed) }), count());
    for (const t of result.removed) (this.entity("removed", t, up(t.$dtId), ts), count());
    if (all) {
      for (const r of current) (this.relationship("checkpoint", r, ts), count());
      for (const t of all.twins) (this.entity("checkpoint", t, up(t.$dtId), ts), count());
    }
    return n;
  }
}

/** The twin as it was at a time: its twins and relationships (from the newest checkpoint and the changes after). */
export interface RecordedState {
  twins: DigitalTwin[];
  relationships: DigitalTwinRelationship[];
}

const attr = (key: string) => `LogAttributes['${key}']`;

/** Reads the history back from ClickHouse's `otel_logs` (read-only, values always as parameters). */
export class HistoryReader {
  constructor(
    private readonly ch: ClickHouse,
    private readonly twin: string,
    /** The twin's OpenTelemetry service name (its records' ServiceName). */
    private readonly service: string,
  ) {}

  private where(event: string) {
    return `ServiceName = {service:String} AND ${attr("event.name")} = '${event}' AND ${attr("twin.id")} = {twin:String}`;
  }

  private params(extra: Record<string, string | number> = {}) {
    return { service: this.service, twin: this.twin, ...extra };
  }

  /** The newest checkpoint at or before `at` (epoch ms), or null when there's none yet. */
  async checkpointBefore(at: number): Promise<number | null> {
    // Aliases never reuse a column's name: ClickHouse would read the alias in WHERE.
    const [row] = await this.ch.query<{ last_ms: string; n: string }>(
      `SELECT toUnixTimestamp64Milli(max(Timestamp)) AS last_ms, count() AS n FROM otel_logs
       WHERE ${this.where(ENTITY_EVENT)} AND ${attr("twin.change")} = 'checkpoint' AND Timestamp <= fromUnixTimestamp64Milli({at:Int64})`,
      this.params({ at }),
    );
    return row && Number(row.n) > 0 ? Number(row.last_ms) : null;
  }

  /** How far back the history goes: the first checkpoint, or null before any. */
  async range(): Promise<{ from: number | null; to: number }> {
    const [row] = await this.ch.query<{ first_ms: string; n: string }>(
      `SELECT toUnixTimestamp64Milli(min(Timestamp)) AS first_ms, count() AS n FROM otel_logs WHERE ${this.where(ENTITY_EVENT)} AND ${attr("twin.change")} = 'checkpoint'`,
      this.params(),
    );
    return { from: row && Number(row.n) > 0 ? Number(row.first_ms) : null, to: Date.now() };
  }

  /** The twin at `at`: the newest checkpoint before it and every change after, the latest per twin; null before any. */
  async stateAt(at: number): Promise<RecordedState | null> {
    const checkpoint = await this.checkpointBefore(at);
    if (checkpoint === null) return null;
    const window = `Timestamp BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({at:Int64})`;
    const params = this.params({ from: checkpoint, at });
    const [twins, relationships] = await Promise.all([
      this.ch.query<{ id: string; change: string; model: string; contents: string; updated_ms: string }>(
        `SELECT ${attr("dt.id")} AS id, argMax(${attr("twin.change")}, Timestamp) AS change, argMax(${attr("dt.model")}, Timestamp) AS model,
                argMax(${attr("dt.contents")}, Timestamp) AS contents, toUnixTimestamp64Milli(max(Timestamp)) AS updated_ms
         FROM otel_logs WHERE ${this.where(ENTITY_EVENT)} AND ${window} GROUP BY id HAVING change != 'removed'`,
        params,
      ),
      this.ch.query<{ source: string; id: string; change: string; name: string; target: string }>(
        `SELECT ${attr("rel.source")} AS source, ${attr("rel.id")} AS id, argMax(${attr("twin.change")}, Timestamp) AS change,
                any(${attr("rel.name")}) AS name, any(${attr("rel.target")}) AS target
         FROM otel_logs WHERE ${this.where(RELATIONSHIP_EVENT)} AND ${window} GROUP BY source, id HAVING change != 'removed'`,
        params,
      ),
    ]);
    return {
      twins: twins.map((r) => ({
        $dtId: r.id,
        $metadata: { $model: r.model, $lastUpdateTime: new Date(Number(r.updated_ms)).toISOString() },
        ...(JSON.parse(r.contents || "{}") as Record<string, unknown>),
      })),
      relationships: relationships.map((r) => ({ $relationshipId: r.id, $sourceId: r.source, $relationshipName: r.name, $targetId: r.target })),
    };
  }

  /** The changes of a twin and its descendants, newest first, never the checkpoints. */
  async changes(f: { dtId: string; from: number; to: number; limit: number }): Promise<TwinChange[]> {
    const rows = await this.ch.query<{ at_ms: string; id: string; change: string; model: string; name: string; status: string; previous: string; changed: string }>(
      `SELECT toUnixTimestamp64Milli(Timestamp) AS at_ms, ${attr("dt.id")} AS id, ${attr("twin.change")} AS change, ${attr("dt.model")} AS model,
              ${attr("dt.name")} AS name, ${attr("dt.status")} AS status, ${attr("dt.previous_status")} AS previous, ${attr("dt.changed")} AS changed
       FROM otel_logs
       WHERE ${this.where(ENTITY_EVENT)} AND ${attr("twin.change")} != 'checkpoint'
         AND Timestamp BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({to:Int64})
         AND (${attr("dt.id")} = {dt:String} OR has(JSONExtract(${attr("dt.ancestors")}, 'Array(String)'), {dt:String}))
       ORDER BY Timestamp DESC, id LIMIT {limit:UInt32}`,
      this.params({ dt: f.dtId, from: f.from, to: f.to, limit: f.limit }),
    );
    return rows.map((r) => ({
      ts: Number(r.at_ms),
      dtId: r.id,
      model: r.model,
      name: r.name,
      change: r.change as TwinChange["change"],
      status: r.status as TwinStatus,
      previousStatus: (r.previous || null) as TwinStatus | null,
      changed: r.changed ? (JSON.parse(r.changed) as string[]) : [],
    }));
  }
}
