import type { TwinChange, TwinEntity, TwinGraph, TwinRelationship, TwinStatus } from "@osiris/shared";
import type { ClickHouse } from "./telemetry.ts";
import { CONTAINS, type SourceSnapshot } from "./twin.ts";

const ENTITIES = "twin.entity_events";
const RELATIONSHIPS = "twin.relationship_events";
/** A full checkpoint once a day: the state at any time is the newest checkpoint before it plus the changes after. */
export const CHECKPOINT_MS = 24 * 3_600_000;

/** ClickHouse's DateTime64(3) text form, in UTC. */
const chTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const relKey = (r: TwinRelationship) => `${r.name}\u0000${r.source}\u0000${r.target}`;
const sorted = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).sort(([a], [b]) => a.localeCompare(b)));

/** What an entity is, for telling whether it changed: everything but its error count, which is telemetry. */
const fingerprint = (e: TwinEntity) => JSON.stringify([e.model, e.kind, e.name, e.status, sorted(e.properties), sorted(e.telemetry)]);

/** The ids up the contains tree, nearest first: an entity's history includes its descendants' changes. */
function ancestorsOf(snapshot: { root: string; relationships: TwinRelationship[] }): Map<string, string[]> {
  const parent = new Map<string, string>();
  for (const r of snapshot.relationships) if (r.name === CONTAINS && !parent.has(r.target)) parent.set(r.target, r.source);
  const memo = new Map<string, string[]>();
  const up = (id: string): string[] => {
    const known = memo.get(id);
    if (known) return known;
    const chain: string[] = [];
    const seen = new Set([id]);
    for (let p = parent.get(id); p && !seen.has(p); p = parent.get(p)) {
      chain.push(p);
      seen.add(p);
    }
    memo.set(id, chain);
    return chain;
  };
  return new Map([...parent.keys()].map((id) => [id, up(id)]));
}

interface EntityRow {
  entity_id: string;
  change: string;
  model: string;
  kind: string;
  name: string;
  status: TwinStatus;
  properties: Record<string, string>;
  telemetry: Record<string, string>;
}

/** The recorded state of the twin: what the recorder compares the next snapshot with. */
export interface RecordedState {
  entities: Map<string, TwinEntity>;
  relationships: Map<string, TwinRelationship>;
  /** When the newest checkpoint was written; null before the first. */
  checkpoint: number | null;
}

/** The twin's history in ClickHouse (deploy/observability/twin/schema.sql): changes only, a checkpoint a day. */
export class HistoryStore {
  constructor(
    private readonly ch: ClickHouse,
    /** The twin's name (CLUSTER_NAME): one database holds the history of several twins. */
    readonly twin: string,
    readonly source: string,
  ) {}

  /** The newest checkpoint at or before `at` (epoch ms), or null when there's none yet. */
  async checkpointBefore(at: number): Promise<number | null> {
    // Aliases never reuse a column's name: ClickHouse would read the alias in WHERE.
    const [row] = await this.ch.query<{ last_ms: string; n: string }>(
      `SELECT toUnixTimestamp64Milli(max(ts)) AS last_ms, count() AS n FROM ${ENTITIES} WHERE twin = {twin:String} AND change = 'checkpoint' AND ts <= fromUnixTimestamp64Milli({at:Int64})`,
      { twin: this.twin, at },
    );
    // max() of nothing is the epoch, so a missing checkpoint shows as the count.
    return row && Number(row.n) > 0 ? Number(row.last_ms) : null;
  }

  /** The twin as it was at `at`: the newest checkpoint before it and every change after, the latest per entity. */
  async stateAt(at: number): Promise<RecordedState> {
    const checkpoint = await this.checkpointBefore(at);
    if (checkpoint === null) return { entities: new Map(), relationships: new Map(), checkpoint };
    const params = { twin: this.twin, from: checkpoint, at };
    const window = `twin = {twin:String} AND ts BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({at:Int64})`;
    const [entities, relationships] = await Promise.all([
      this.ch.query<EntityRow>(
        `SELECT entity_id, argMax(change, ts) AS change, argMax(model, ts) AS model, argMax(kind, ts) AS kind, argMax(name, ts) AS name,
                argMax(status, ts) AS status, argMax(properties, ts) AS properties, argMax(telemetry, ts) AS telemetry
         FROM ${ENTITIES} WHERE ${window} GROUP BY entity_id HAVING change != 'removed'`,
        params,
      ),
      this.ch.query<{ name: string; source_id: string; target_id: string; change: string }>(
        `SELECT name, source_id, target_id, argMax(change, ts) AS change FROM ${RELATIONSHIPS} WHERE ${window}
         GROUP BY name, source_id, target_id HAVING change != 'removed'`,
        params,
      ),
    ]);
    return {
      checkpoint,
      entities: new Map(
        entities.map((r) => [
          r.entity_id,
          { id: r.entity_id, model: r.model, kind: r.kind, name: r.name, status: r.status, errors: 0, properties: r.properties ?? {}, ...(Object.keys(r.telemetry ?? {}).length ? { telemetry: r.telemetry } : {}) },
        ]),
      ),
      relationships: new Map(
        relationships.map((r) => {
          const rel = { name: r.name, source: r.source_id, target: r.target_id };
          return [relKey(rel), rel];
        }),
      ),
    };
  }

  /** The graph at `at`, without error counts (the caller adds them for that time). */
  async graphAt(at: number, root: string): Promise<SourceSnapshot | null> {
    const state = await this.stateAt(at);
    if (!state.entities.has(root)) return null;
    return { root, entities: [...state.entities.values()], relationships: [...state.relationships.values()] };
  }

  /** How far back the history goes: the first checkpoint, or null before any. */
  async range(): Promise<{ from: number | null; to: number }> {
    const [row] = await this.ch.query<{ first_ms: string; n: string }>(
      `SELECT toUnixTimestamp64Milli(min(ts)) AS first_ms, count() AS n FROM ${ENTITIES} WHERE twin = {twin:String} AND change = 'checkpoint'`,
      { twin: this.twin },
    );
    return { from: row && Number(row.n) > 0 ? Number(row.first_ms) : null, to: Date.now() };
  }

  /** The changes of an entity and its descendants (or of the whole twin), newest first. */
  async changes(f: { entity?: string; from: number; to: number; limit: number }): Promise<TwinChange[]> {
    const params: Record<string, string | number> = { twin: this.twin, from: f.from, to: f.to, limit: f.limit };
    const where = [
      "twin = {twin:String}",
      "change != 'checkpoint'",
      "ts BETWEEN fromUnixTimestamp64Milli({from:Int64}) AND fromUnixTimestamp64Milli({to:Int64})",
    ];
    if (f.entity) {
      where.push("(entity_id = {entity:String} OR has(ancestors, {entity:String}))");
      params.entity = f.entity;
    }
    const rows = await this.ch.query<EntityRow & { at_ms: string; previous_status: string; changed: string[] }>(
      `SELECT toUnixTimestamp64Milli(ts) AS at_ms, entity_id, change, kind, name, status, previous_status, changed, properties
       FROM ${ENTITIES} WHERE ${where.join(" AND ")} ORDER BY ts DESC, entity_id LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map((r) => ({
      ts: Number(r.at_ms),
      entityId: r.entity_id,
      kind: r.kind,
      name: r.name,
      change: r.change as TwinChange["change"],
      status: r.status,
      previousStatus: (r.previous_status || null) as TwinStatus | null,
      changed: r.changed ?? [],
      properties: r.properties ?? {},
    }));
  }

  /**
   * Writes what changed between `before` and the graph: added, changed and removed entities and relationships, or
   * every one of them as a checkpoint. Returns how many rows went in.
   */
  async write(graph: TwinGraph, before: RecordedState, checkpoint: boolean): Promise<number> {
    const ts = chTime(graph.ts);
    const ancestors = ancestorsOf(graph);
    const entityRows: object[] = [];
    const row = (e: TwinEntity, change: string, previous?: TwinEntity, changed: string[] = []) => ({
      ts,
      twin: this.twin,
      source: this.source,
      entity_id: e.id,
      change,
      model: e.model,
      kind: e.kind,
      name: e.name,
      status: e.status,
      previous_status: previous?.status ?? "",
      changed,
      properties: e.properties,
      telemetry: e.telemetry ?? {},
      ancestors: ancestors.get(e.id) ?? [],
    });
    const now = new Map(graph.entities.map((e) => [e.id, e]));
    for (const e of graph.entities) {
      const was = before.entities.get(e.id);
      // A checkpoint carries every entity; a change in the same round is still written, for the list of changes.
      if (checkpoint) entityRows.push(row(e, "checkpoint", was));
      if (!was) entityRows.push(row(e, "added"));
      else if (fingerprint(was) !== fingerprint(e)) {
        const keys = new Set([...Object.keys(was.properties), ...Object.keys(e.properties)]);
        const changed = [...keys].filter((k) => was.properties[k] !== e.properties[k]).sort();
        if (was.status !== e.status) changed.unshift("status");
        entityRows.push(row(e, "changed", was, changed));
      }
    }
    // A removed entity is written as it was last seen, with the ancestors it had then.
    const oldAncestors = ancestorsOf({ root: "", relationships: [...before.relationships.values()] });
    for (const [id, was] of before.entities)
      if (!now.has(id)) entityRows.push({ ...row(was, "removed", was), ancestors: oldAncestors.get(id) ?? [] });

    const relRows: object[] = [];
    const rel = (r: TwinRelationship, change: string) => ({ ts, twin: this.twin, source: this.source, name: r.name, source_id: r.source, target_id: r.target, change });
    const rels = new Map(graph.relationships.map((r) => [relKey(r), r]));
    for (const [key, r] of rels) {
      if (checkpoint) relRows.push(rel(r, "checkpoint"));
      if (!before.relationships.has(key)) relRows.push(rel(r, "added"));
    }
    for (const [key, r] of before.relationships) if (!rels.has(key)) relRows.push(rel(r, "removed"));

    // Relationships first: a reader between the two inserts sees no entity without its place in the tree.
    await this.ch.insert(RELATIONSHIPS, relRows);
    await this.ch.insert(ENTITIES, entityRows);
    return entityRows.length + relRows.length;
  }
}

/** The graph as the state the next comparison starts from (error counts left out). */
export const stateOf = (graph: TwinGraph, checkpoint: number | null): RecordedState => ({
  entities: new Map(graph.entities.map((e) => [e.id, { ...e, errors: 0 }])),
  relationships: new Map(graph.relationships.map((r) => [relKey(r), r])),
  checkpoint,
});

/** Who records: with several replicas, the one holding the lease (Redis); alone, always. */
export interface Lease {
  hold(ttlSeconds: number): Promise<boolean>;
}

/**
 * Records the twin's changes: every `intervalMs` the replica holding the lease reads the graph, compares it with the
 * recorded state (from ClickHouse when it takes over) and writes the difference, and a checkpoint once a day. A
 * failing source or ClickHouse skips the round; the next one compares with what was last written.
 */
export function startRecorder(options: {
  history: HistoryStore;
  graph: () => Promise<TwinGraph>;
  lease: Lease;
  intervalMs: number;
  log?: (message: string, err?: unknown) => void;
}): { stop(): void; round(): Promise<number> } {
  const { history, graph, lease, intervalMs } = options;
  const log = options.log ?? ((m, e) => console.error(m, e ?? ""));
  let state: RecordedState | undefined;
  let busy = false;

  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      // Another replica may have written meanwhile: whoever takes the lease starts from what's in ClickHouse.
      if (!(await lease.hold(Math.ceil((intervalMs * 3) / 1000)))) {
        state = undefined;
        return 0;
      }
      const current = await graph();
      state ??= await history.stateAt(current.ts);
      const checkpoint = state.checkpoint === null || current.ts - state.checkpoint >= CHECKPOINT_MS;
      const written = await history.write(current, state, checkpoint);
      state = stateOf(current, checkpoint ? current.ts : state.checkpoint);
      return written;
    } catch (err) {
      log("Recording the twin's history failed", err);
      state = undefined;
      return 0;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  void round();
  return { stop: () => clearInterval(timer), round };
}
