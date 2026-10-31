import { dataProfilesOf, type DataBinding, type DigitalTwin, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import type { TwinStateStore } from "../state.ts";
import type { InstanceData, TwinStore } from "../store.ts";
import { CONNECTOR_TYPES, type BoundTask, type Connector, type ConnectorType, type DataValue } from "./connectors.ts";
import { varsOf } from "./template.ts";

/** One telemetry value of a twin as the data hub read it: the value, when, from which profile and connection. */
export interface DataPoint {
  value: DataValue;
  ts: number;
  profile: string;
  connection: string;
}

/** Where the hub's values go (Redis; the API reads them): per instance, per twin, per telemetry. */
export interface DataValueStore {
  write(instance: string, points: Map<string, Map<string, DataPoint>>): Promise<void>;
  /** One twin's values, or every twin's. */
  read(instance: string, twin?: string): Promise<Record<string, Record<string, DataPoint>>>;
  clear(instance: string): Promise<void>;
}

const SEP = "\u0000";

/** The values in memory (development, tests). */
export function memoryDataValues(): DataValueStore {
  const all = new Map<string, DataPoint>();
  return {
    async write(instance, points) {
      for (const [twin, values] of points) for (const [telemetry, p] of values) all.set(`${instance}${SEP}${twin}${SEP}${telemetry}`, p);
    },
    async read(instance, twin) {
      const out: Record<string, Record<string, DataPoint>> = {};
      for (const [k, p] of all) {
        const [i, t, telemetry] = k.split(SEP);
        if (i !== instance || (twin && t !== twin)) continue;
        (out[t!] ??= {})[telemetry!] = p;
      }
      return out;
    },
    async clear(instance) {
      for (const k of [...all.keys()]) if (k.startsWith(`${instance}${SEP}`)) all.delete(k);
    },
  };
}

/** The Redis commands the value store uses (node-redis v5). */
export interface DataRedis {
  hSet(key: string, field: Record<string, string>): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  del(key: string | string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/** The values in Redis: one hash per instance (`<prefix>:twin:<instance>:data`, field twin + telemetry), kept a day. */
export function redisDataValues(client: DataRedis, prefix: string): DataValueStore {
  const key = (instance: string) => `${prefix}:twin:${instance}:data`;
  return {
    async write(instance, points) {
      const fields: Record<string, string> = {};
      for (const [twin, values] of points) for (const [telemetry, p] of values) fields[`${twin}${SEP}${telemetry}`] = JSON.stringify(p);
      if (!Object.keys(fields).length) return;
      await client.hSet(key(instance), fields);
      await client.expire(key(instance), 86_400);
    },
    async read(instance, twin) {
      const out: Record<string, Record<string, DataPoint>> = {};
      for (const [field, raw] of Object.entries(await client.hGetAll(key(instance)))) {
        const [t, telemetry] = field.split(SEP);
        if (!t || !telemetry || (twin && t !== twin)) continue;
        (out[t] ??= {})[telemetry] = JSON.parse(raw) as DataPoint;
      }
      return out;
    },
    async clear(instance) {
      await client.del(key(instance));
    },
  };
}

interface PlannedTask extends BoundTask {
  twin: string;
  telemetry: string;
  connection: string;
  every: number;
  next: number;
}

export interface DataHubOptions {
  instance: string;
  store: TwinStore;
  data: InstanceData;
  state: TwinStateStore;
  values: DataValueStore;
  types?: Record<string, ConnectorType>;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** How often due bindings are asked and values written. */
  tickMs?: number;
  /** How often the plan is made again (twins come and go). */
  replanMs?: number;
  /** At most this many twin × telemetry bindings per instance. */
  maxTasks?: number;
  log?: (message: string, err?: unknown) => void;
}

/** What the hub does now, for the API: the profile, how many bindings, and each connection's last error. */
export interface DataHubStatus {
  profile: string;
  tasks: number;
  connections: Record<string, { tasks: number; error?: string; lastValueAt?: number }>;
}

/**
 * An instance's data hub: runs the active data profile of its models. For every twin whose model's profile of that
 * name binds telemetry, it asks the poll connectors when due (each binding's `every`, else 30 s, a few at a time) and
 * keeps one subscription per stream connection for all of its bindings, made again when they change; the values go
 * to the value store. Connectors are made from the stored connections (secrets opened only for them) and made again
 * when a connection changes. A binding or twin it can't serve is skipped and the connection's error kept for the API.
 */
export class DataHub {
  private timer?: ReturnType<typeof setInterval>;
  private tasks: PlannedTask[] = [];
  private profile = "live";
  private plannedAt = 0;
  private readonly connectors = new Map<string, { connector: Connector; updatedAt: number; type: ConnectorType }>();
  private readonly streams = new Map<string, { signature: string; stop: () => Promise<void> }>();
  private readonly errors = new Map<string, string>();
  private readonly lastValue = new Map<string, number>();
  private pending = new Map<string, Map<string, DataPoint>>();
  private busy = false;
  private readonly types: Record<string, ConnectorType>;
  private readonly now: () => number;

  constructor(private readonly o: DataHubOptions) {
    this.types = o.types ?? CONNECTOR_TYPES;
    this.now = o.now ?? Date.now;
  }

  start(): this {
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 5_000);
    void this.tick();
    return this;
  }

  /** Makes the plan again at the next tick (a model, a connection or the profile changed). */
  reload(): void {
    this.plannedAt = 0;
  }

  status(): DataHubStatus {
    const connections: DataHubStatus["connections"] = {};
    for (const t of this.tasks) {
      const c = (connections[t.connection] ??= { tasks: 0 });
      c.tasks++;
    }
    for (const [id, c] of Object.entries(connections)) {
      const error = this.errors.get(id);
      if (error) c.error = error;
      const at = this.lastValue.get(id);
      if (at) c.lastValueAt = at;
    }
    return { profile: this.profile, tasks: this.tasks.length, connections };
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled([...this.streams.values()].map((s) => s.stop()));
    this.streams.clear();
    await Promise.allSettled([...this.connectors.values()].map((c) => c.connector.close?.()));
    this.connectors.clear();
  }

  /** One round: the plan when due, the streams in step with it, the due polls, the values written. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.now() - this.plannedAt >= (this.o.replanMs ?? 60_000)) await this.plan();
      await this.syncStreams();
      await this.poll();
      await this.flush();
    } catch (err) {
      this.o.log?.(`The data hub of ${this.o.instance} failed a round`, err);
    } finally {
      this.busy = false;
    }
  }

  private connectionError(id: string, err: unknown) {
    this.errors.set(id, (err instanceof Error ? err.message : String(err)).slice(0, 300));
  }

  /** Which twin's telemetry comes from which connection, with which parameters, under the active profile. */
  private async plan(): Promise<void> {
    this.plannedAt = this.now();
    this.profile = await this.o.store.activeProfile(this.o.instance);
    const [models, twins, connections] = await Promise.all([this.o.data.models(), this.o.state.twins(this.o.instance), this.o.store.connections(this.o.instance)]);
    const modelMap = new Map(models.map((m) => [m.id, m.model] as [string, DtdlInterface]));
    const connectionType = new Map(connections.map((c) => [c.id, this.types[c.type]]));
    const bindingsOf = new Map<string, DataBinding[]>();
    const old = new Map(this.tasks.map((t) => [t.key, t.next]));
    const tasks: PlannedTask[] = [];
    const max = this.o.maxTasks ?? 1000;
    for (const twin of twins as DigitalTwin[]) {
      const model = twin.$metadata.$model;
      if (!bindingsOf.has(model)) bindingsOf.set(model, dataProfilesOf(model, modelMap).find((p) => p.name === this.profile)?.bindings ?? []);
      for (const raw of bindingsOf.get(model)!) {
        const type = connectionType.get(raw.connection);
        if (!type || type.mode === "simulator") continue;
        const parsed = type.binding.safeParse(raw);
        if (!parsed.success) continue;
        if (tasks.length >= max) break;
        const key = `${twin.$dtId}${SEP}${raw.telemetry}`;
        const every = Math.max(5, raw.every ?? 30) * 1000;
        tasks.push({ key, twin: twin.$dtId, telemetry: raw.telemetry, connection: raw.connection, binding: parsed.data as DataBinding, vars: varsOf(twin), every, next: old.get(key) ?? 0 });
      }
    }
    this.tasks = tasks;
    // Connections no binding uses any more, or changed since made: closed (made again when needed).
    const used = new Set(tasks.map((t) => t.connection));
    for (const [id, c] of this.connectors) {
      const now = connections.find((x) => x.id === id);
      if (used.has(id) && now && now.updatedAt === c.updatedAt) continue;
      await this.streams.get(id)?.stop().catch(() => {});
      this.streams.delete(id);
      await c.connector.close?.().catch(() => {});
      this.connectors.delete(id);
    }
  }

  private async connectorOf(id: string): Promise<{ connector: Connector; type: ConnectorType } | undefined> {
    const had = this.connectors.get(id);
    if (had) return had;
    const record = await this.o.store.connection(this.o.instance, id);
    const type = record && this.types[record.type];
    if (!record || !type) return undefined;
    const connector = type.create(record.settings as Record<string, string>, record.secrets, { fetchFn: this.o.fetchFn, now: this.now });
    const made = { connector, updatedAt: record.updatedAt, type };
    this.connectors.set(id, made);
    return made;
  }

  /** One subscription per stream connection, for all its bindings; made again when they change. */
  private async syncStreams(): Promise<void> {
    const byConnection = new Map<string, PlannedTask[]>();
    for (const t of this.tasks) byConnection.set(t.connection, [...(byConnection.get(t.connection) ?? []), t]);
    for (const [id, s] of this.streams)
      if (!byConnection.has(id)) {
        await s.stop().catch(() => {});
        this.streams.delete(id);
      }
    for (const [id, tasks] of byConnection) {
      const made = await this.connectorOf(id);
      if (!made?.connector.subscribe) continue;
      const signature = JSON.stringify(tasks.map((t) => [t.key, t.binding, t.vars]));
      if (this.streams.get(id)?.signature === signature) continue;
      await this.streams.get(id)?.stop().catch(() => {});
      this.streams.delete(id);
      try {
        const stop = await made.connector.subscribe(tasks, (key, value) => this.put(key, id, value));
        this.streams.set(id, { signature, stop });
        this.errors.delete(id);
      } catch (err) {
        this.connectionError(id, err);
      }
    }
  }

  /** The due polls, four at a time. */
  private async poll(): Promise<void> {
    const now = this.now();
    const due = this.tasks.filter((t) => t.next <= now);
    for (let i = 0; i < due.length; i += 4)
      await Promise.all(
        due.slice(i, i + 4).map(async (t) => {
          t.next = now + t.every;
          const made = await this.connectorOf(t.connection);
          if (!made?.connector.poll) return;
          try {
            const value = await made.connector.poll(t.binding, t.vars);
            if (value !== undefined) this.put(t.key, t.connection, value);
            this.errors.delete(t.connection);
          } catch (err) {
            if ((err as Error).constructor?.name !== "MissingVariable") this.connectionError(t.connection, err);
          }
        }),
      );
  }

  private put(key: string, connection: string, value: DataValue) {
    const [twin, telemetry] = key.split(SEP);
    const at = this.now();
    this.lastValue.set(connection, at);
    let values = this.pending.get(twin!);
    if (!values) this.pending.set(twin!, (values = new Map()));
    values.set(telemetry!, { value, ts: at, profile: this.profile, connection });
  }

  private async flush(): Promise<void> {
    if (!this.pending.size) return;
    const points = this.pending;
    this.pending = new Map();
    await this.o.values.write(this.o.instance, points);
  }
}
