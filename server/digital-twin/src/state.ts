import { createHash } from "node:crypto";
import type { TwinEvent } from "@osiris/shared";
import { TWIN_EVENTS_STREAM, twinEventOf } from "@osiris/shared";
import type { DigitalTwin, DigitalTwinRelationship } from "@osiris/shared/dtdl.ts";
import { toRelationship, type SourceSnapshot } from "./twin.ts";

/** The telemetry the view draws, by twin id: error log counts, network bytes/s, storage filesystems. */
export interface TelemetryState {
  errorLogs: Record<string, number>;
  network: Record<string, number>;
  storage: Record<string, { used: number; fsCapacity: number }>;
}

export type TelemetryKind = keyof TelemetryState;

/** What a sync changed: the history writes it (and a checkpoint writes everything). */
export interface SyncResult {
  ts: number;
  added: DigitalTwin[];
  changed: { before: DigitalTwin; after: DigitalTwin; changed: string[] }[];
  removed: DigitalTwin[];
  relationshipsAdded: DigitalTwinRelationship[];
  relationshipsRemoved: DigitalTwinRelationship[];
  /** The whole state after the sync: twins with their etags, relationships. */
  twins: DigitalTwin[];
  relationships: DigitalTwinRelationship[];
}

/** A twin's properties: everything but the `$` fields. */
export const contentsOf = (t: { [k: string]: unknown }): Record<string, unknown> =>
  Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith("$")).sort(([a], [b]) => a.localeCompare(b)));
export const etagOf = (model: string, contents: Record<string, unknown>) => `W/"${createHash("sha256").update(JSON.stringify([model, contents])).digest("hex").slice(0, 20)}"`;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The twins' and relationships' current state, and the telemetry the view draws, and the warn/error events — the
 * cache everyone reads: the API serves the view from it, the collector's events land in it, Osiris's agent reads
 * it. SQLite keeps only the definitions (DTDL models and the instances' settings), never this data.
 */
export interface TwinStateStore {
  /** Replaces the instance's twins, relationships and telemetry atomically; telemetry expires when the source stops. */
  writeSnapshot(instance: string, twins: DigitalTwin[], relationships: DigitalTwinRelationship[], telemetry: TelemetryState, at: number, telemetryTtlSeconds: number): Promise<void>;
  twins(instance: string): Promise<DigitalTwin[]>;
  twin(instance: string, id: string): Promise<DigitalTwin | undefined>;
  relationships(instance: string, filter?: { source?: string; target?: string }): Promise<DigitalTwinRelationship[]>;
  telemetry(instance: string, kind: TelemetryKind): Promise<TelemetryState[TelemetryKind]>;
  /** When the instance's source last synced (epoch ms). */
  syncedAt(instance: string): Promise<number | undefined>;
  /** The newest warn/error events from the collector's stream (newest first), optionally of one cluster or severity. */
  events(query?: { limit?: number; cluster?: string; severity?: string }): Promise<TwinEvent[]>;
  /** The events no consumer of `group` has read yet (for a push to Osiris's agent); empty on a timeout. */
  readNewEvents(group: string, consumer: string, count: number, blockMs: number): Promise<TwinEvent[]>;
  /** Drops everything of the instance. */
  deleteInstance(instance: string): Promise<void>;
}

/** The key the collector's `twin/events` processor writes warn/error log records to. */
export const eventsStreamKey = (prefix: string) => `${prefix}:${TWIN_EVENTS_STREAM}`;
const twinKey = (prefix: string, instance: string, what: string) => `${prefix}:twin:${instance}:${what}`;

/** A Redis transaction (pipeline): commands queue, `exec` runs them. */
export interface RedisMulti {
  hSet(key: string, field: Record<string, string>): RedisMulti;
  del(key: string | string[]): RedisMulti;
  set(key: string, value: string): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  rename(key: string, newKey: string): RedisMulti;
  exec(): Promise<unknown>;
}

/** The minimal Redis client the state store needs (node-redis's client satisfies it; tests can fake it). */
export interface RedisClient {
  hSet(key: string, field: Record<string, string>): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  del(key: string | string[]): Promise<unknown>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  rename(key: string, newKey: string): Promise<unknown>;
  multi(): RedisMulti;
  xRevRange(key: string, start: string, end: string, options?: { COUNT?: number }): Promise<{ id: string; message: Record<string, string> }[]>;
  /** node-redis types the reply as a wide union; the store narrows it itself. */
  xReadGroup(group: string, consumer: string, streams: { key: string; id: string }[], options?: { COUNT?: number; BLOCK?: number }): Promise<unknown>;
  xGroupCreate(key: string, group: string, id: string, options?: { MKSTREAM?: boolean }): Promise<unknown>;
}

/** The state in Redis: hashes per instance under `<prefix>:twin:<instance>:…`, the events in one stream. */
export function redisStateStore(client: RedisClient, prefix: string): TwinStateStore {
  const key = (instance: string, what: string) => twinKey(prefix, instance, what);
  return {
    async writeSnapshot(instance, twins, relationships, telemetry, at, telemetryTtlSeconds) {
      // The twins and relationships swap atomically (staging hash, then RENAME); the telemetry hashes expire, so a
      // stopped source's last values go away on their own.
      const twinsTmp = `${key(instance, "twins")}:tmp`;
      const relsTmp = `${key(instance, "relationships")}:tmp`;
      const swap = client.multi().del([twinsTmp, relsTmp]);
      if (twins.length) swap.hSet(twinsTmp, Object.fromEntries(twins.map((t) => [t.$dtId, JSON.stringify(t)])));
      if (relationships.length) swap.hSet(relsTmp, Object.fromEntries(relationships.map((r) => [r.$relationshipId, JSON.stringify(r)])));
      await swap.rename(twinsTmp, key(instance, "twins")).rename(relsTmp, key(instance, "relationships")).set(key(instance, "synced_at"), String(at)).exec();
      for (const kind of ["errorLogs", "network", "storage"] as const) {
        const k = key(instance, `telemetry:${kind}`);
        const values = telemetry[kind] as Record<string, unknown>;
        const fields = Object.fromEntries(Object.entries(values).map(([id, v]) => [id, typeof v === "number" ? String(v) : JSON.stringify(v)]));
        const m = client.multi().del(k);
        if (Object.keys(fields).length) m.hSet(k, fields);
        await m.expire(k, telemetryTtlSeconds).exec();
      }
    },
    async twins(instance) {
      const all = await client.hGetAll(key(instance, "twins"));
      return Object.values(all).map((json) => JSON.parse(json) as DigitalTwin).sort((a, b) => a.$dtId.localeCompare(b.$dtId));
    },
    async twin(instance, id) {
      const json = await client.hGet(key(instance, "twins"), id);
      return json ? (JSON.parse(json) as DigitalTwin) : undefined;
    },
    async relationships(instance, filter = {}) {
      const all = await client.hGetAll(key(instance, "relationships"));
      return Object.values(all)
        .map((json) => JSON.parse(json) as DigitalTwinRelationship)
        .filter((r) => (filter.source ? r.$sourceId === filter.source : true) && (filter.target ? r.$targetId === filter.target : true))
        .sort((a, b) => a.$relationshipId.localeCompare(b.$relationshipId));
    },
    async telemetry(instance, kind) {
      const all = await client.hGetAll(key(instance, `telemetry:${kind}`));
      return Object.fromEntries(
        Object.entries(all).map(([id, v]) => [id, kind === "storage" ? (JSON.parse(v) as { used: number; fsCapacity: number }) : Number(v)]),
      ) as TelemetryState[TelemetryKind];
    },
    async syncedAt(instance) {
      const v = await client.get(key(instance, "synced_at"));
      return v === null ? undefined : Number(v);
    },
    async events(query = {}) {
      const limit = Math.min(query.limit ?? 100, 500);
      const entries = await client.xRevRange(eventsStreamKey(prefix), "+", "-", { COUNT: limit * 4 });
      return entries
        .map((e) => twinEventOf(e.id, e.message))
        .filter((e) => (!query.cluster || e.cluster === query.cluster) && (!query.severity || e.severity.toLowerCase() === query.severity.toLowerCase()))
        .slice(0, limit);
    },
    async readNewEvents(group, consumer, count, blockMs) {
      const stream = eventsStreamKey(prefix);
      try {
        await client.xGroupCreate(stream, group, "$", { MKSTREAM: true });
      } catch {
        // BUSYGROUP: the group exists.
      }
      const reply = (await client.xReadGroup(group, consumer, [{ key: stream, id: ">" }], { COUNT: count, BLOCK: blockMs })) as
        | { name: string; messages: { id: string; message: Record<string, string> }[] }[]
        | null;
      return (reply ?? []).flatMap((s) => s.messages.map((m) => twinEventOf(m.id, m.message)));
    },
    async deleteInstance(instance) {
      await client.del([key(instance, "twins"), key(instance, "relationships"), key(instance, "synced_at"), ...(["errorLogs", "network", "storage"] as const).map((k) => key(instance, `telemetry:${k}`))]);
    },
  };
}

/** The state in the process: development and tests without a Redis. */
export function memoryStateStore(now: () => number = Date.now): TwinStateStore & { addEvent(fields: Record<string, string>): TwinEvent } {
  const twins = new Map<string, Map<string, string>>();
  const rels = new Map<string, Map<string, string>>();
  const telemetry = new Map<string, Map<string, Map<string, string>>>();
  const synced = new Map<string, number>();
  const events: { id: string; fields: Record<string, string> }[] = [];
  const cursors = new Map<string, number>();
  let seq = 0;
  const parse = (json: string) => JSON.parse(json) as never;
  return {
    async writeSnapshot(instance, ts, rs, tel, at) {
      twins.set(instance, new Map(ts.map((t) => [t.$dtId, JSON.stringify(t)])));
      rels.set(instance, new Map(rs.map((r) => [r.$relationshipId, JSON.stringify(r)])));
      telemetry.set(instance, new Map(Object.entries(tel).map(([k, v]) => [k, new Map(Object.entries(v).map(([id, val]) => [id, typeof val === "number" ? String(val) : JSON.stringify(val)]))])));
      synced.set(instance, at);
    },
    async twins(instance) {
      const rows = twins.get(instance);
      return (rows ? [...rows.values()] : []).map(parse).sort((a: DigitalTwin, b: DigitalTwin) => a.$dtId.localeCompare(b.$dtId));
    },
    async twin(instance, id) {
      const json = twins.get(instance)?.get(id);
      return json ? parse(json) : undefined;
    },
    async relationships(instance, filter = {}) {
      const rows = rels.get(instance);
      return (rows ? [...rows.values()] : [])
        .map(parse)
        .filter((r: DigitalTwinRelationship) => (filter.source ? r.$sourceId === filter.source : true) && (filter.target ? r.$targetId === filter.target : true))
        .sort((a: DigitalTwinRelationship, b: DigitalTwinRelationship) => a.$relationshipId.localeCompare(b.$relationshipId));
    },
    async telemetry(instance, kind) {
      const all = telemetry.get(instance)?.get(kind) ?? new Map<string, string>();
      return Object.fromEntries([...all.entries()].map(([id, v]) => [id, kind === "storage" ? JSON.parse(v) : Number(v)])) as never;
    },
    async syncedAt(instance) {
      return synced.get(instance);
    },
    async events(query = {}) {
      const limit = Math.min(query.limit ?? 100, 500);
      return [...events]
        .reverse()
        .map((e) => twinEventOf(e.id, e.fields))
        .filter((e) => (!query.cluster || e.cluster === query.cluster) && (!query.severity || e.severity.toLowerCase() === query.severity.toLowerCase()))
        .slice(0, limit);
    },
    async readNewEvents(group, consumer, count) {
      const at = cursors.get(`${group}/${consumer}`) ?? 0;
      const fresh = events.slice(at, at + count);
      cursors.set(`${group}/${consumer}`, at + fresh.length);
      return fresh.map((e) => twinEventOf(e.id, e.fields));
    },
    async deleteInstance(instance) {
      twins.delete(instance);
      rels.delete(instance);
      telemetry.delete(instance);
      synced.delete(instance);
    },
    addEvent(fields) {
      const e = { id: `${now()}-${seq++}`, fields };
      events.push(e);
      if (events.length > 10_000) events.shift();
      return twinEventOf(e.id, e.fields);
    },
  };
}

/**
 * What a sync changed: the diff of the source's new snapshot against the state the last sync wrote (twins with
 * their etags, relationships), with the after state's twins (etags included) and relationships. An unchanged twin
 * keeps its etag and update time.
 */
export function diffSnapshots(before: { twins: DigitalTwin[]; relationships: DigitalTwinRelationship[] } | undefined, after: SourceSnapshot, now: number): SyncResult {
  const beforeTwins = new Map((before?.twins ?? []).map((t) => [t.$dtId, t]));
  const result: SyncResult = { ts: now, added: [], changed: [], removed: [], relationshipsAdded: [], relationshipsRemoved: [], twins: [], relationships: [] };
  const seen = new Set<string>();
  for (const t of after.twins) {
    if (seen.has(t.$dtId)) continue;
    seen.add(t.$dtId);
    const contents = contentsOf(t);
    const etag = etagOf(t.$metadata.$model, contents);
    const was = beforeTwins.get(t.$dtId);
    if (was && was.$etag === etag) {
      result.twins.push(was);
      continue;
    }
    const afterTwin: DigitalTwin = { $dtId: t.$dtId, $etag: etag, $metadata: { $model: t.$metadata.$model, $lastUpdateTime: iso(now) }, ...contents };
    result.twins.push(afterTwin);
    if (!was) result.added.push(afterTwin);
    else {
      const wasContents = contentsOf(was);
      const keys = [...new Set([...Object.keys(wasContents), ...Object.keys(contents)])].filter((k) => JSON.stringify(wasContents[k]) !== JSON.stringify(contents[k])).sort();
      if (was.$metadata.$model !== t.$metadata.$model) keys.unshift("$model");
      result.changed.push({ before: was, after: afterTwin, changed: keys });
    }
  }
  for (const was of before?.twins ?? []) if (!seen.has(was.$dtId)) result.removed.push(was);

  const keyOf = (r: { $sourceId: string; $relationshipName: string; $targetId: string }) => `${r.$sourceId}\u0000${r.$relationshipName}\u0000${r.$targetId}`;
  const beforeRels = new Map((before?.relationships ?? []).map((r) => [keyOf(r), r]));
  const seenRels = new Set<string>();
  for (const r of after.relationships) {
    const rel = toRelationship(r);
    const key = keyOf(rel);
    if (seenRels.has(key)) continue;
    seenRels.add(key);
    result.relationships.push(rel);
    if (!beforeRels.has(key)) result.relationshipsAdded.push(rel);
  }
  for (const [key, r] of beforeRels) if (!seenRels.has(key)) result.relationshipsRemoved.push(r);
  return result;
}
