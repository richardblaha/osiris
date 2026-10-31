import type { TwinEvent } from "@osiris/shared";

/**
 * An alert: one problem the collector's warn/error events tell of, however often they repeat. Similar events (the
 * same place and the same message but for numbers, ids and times) are one alert; each new alert gets a conversation
 * of its own with Osiris's agent, which investigates it and proposes a solution.
 */
export interface Alert {
  id: string;
  fingerprint: string;
  severity: string;
  severityNumber: number;
  /** The first event's message, and the newest one's. */
  message: string;
  lastMessage: string;
  cluster?: string;
  namespace?: string;
  /** The workload the pod belongs to, as its name tells (the pod's name without its generated suffixes). */
  workload?: string;
  pod?: string;
  node?: string;
  container?: string;
  service?: string;
  traceId?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  /** investigating: the agent works on it; answered: it has; failed: it couldn't; skipped: over the hourly limit. */
  state: "investigating" | "answered" | "failed" | "skipped";
  /** Resolved: no event of it for a while. */
  resolved: boolean;
  /** Osiris's conversation that investigates it. */
  thread?: string;
  /** The agent's answer, shortened, for the list. */
  summary?: string;
  error?: string;
}

/** Where alerts are kept. */
export interface AlertStore {
  /** The open alert of a fingerprint (seen within the reopen window), if any. */
  open(fingerprint: string): Promise<Alert | undefined>;
  save(alert: Alert, reopenMs: number): Promise<void>;
  get(id: string): Promise<Alert | undefined>;
  /** The newest alerts first (by their last event). */
  list(limit: number): Promise<Alert[]>;
}

/** What investigates a new alert: starts the conversation and answers its id, then works on it. */
export interface Investigator {
  start(alert: Alert): Promise<{ thread: string; done: Promise<{ summary?: string; error?: string }> }>;
}

export const SEVERITY_NUMBERS: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

/** A pod's workload by its name: a Deployment's pod `api-7d9f8c6b5-x2kqp` → `api`, a StatefulSet's `db-0` → `db`. */
export function workloadOf(pod?: string): string | undefined {
  if (!pod) return undefined;
  return pod.replace(/-[a-f0-9]{8,10}-[a-z0-9]{5}$/, "").replace(/-[a-z0-9]{5}$/, "").replace(/-\d+$/, "");
}

/** A message without what changes between repeats: numbers, hex ids, UUIDs, quoted values; trimmed. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** The same problem in the same place: cluster, namespace, workload, container and the message's shape. */
export const fingerprintOf = (e: TwinEvent) => [e.cluster ?? "", e.namespace ?? "", workloadOf(e.pod) ?? e.node ?? e.service ?? "", e.container ?? "", normalizeMessage(e.message)].join("|");

export interface EngineOptions {
  store: AlertStore;
  investigator: Investigator;
  /** Only events at least this severe make alerts. */
  minSeverity: string;
  /** An alert stays open this long after its last event: repeats join it, a later one is a new alert. */
  reopenMs: number;
  /** At most this many new conversations an hour; the rest are kept as skipped. */
  maxPerHour: number;
  now?: () => number;
  newId?: () => string;
  log?: (message: string, err?: unknown) => void;
}

/**
 * Turns events into alerts: a repeat updates its open alert (count, last seen, the worst severity), a new problem
 * becomes an alert whose investigation starts at once (up to the hourly limit), and its outcome is written back.
 */
export class AlertEngine {
  private readonly started: number[] = [];
  private readonly min: number;
  /** Investigations under way, so a test (or a stop) can wait for them. */
  readonly pending = new Set<Promise<void>>();

  constructor(private readonly o: EngineOptions) {
    this.min = SEVERITY_NUMBERS[o.minSeverity] ?? SEVERITY_NUMBERS.error!;
  }

  /** One event: undefined when it is below the threshold, else its alert. */
  async handle(e: TwinEvent): Promise<Alert | undefined> {
    if (e.severityNumber < this.min) return undefined;
    const now = this.o.now?.() ?? Date.now();
    const fingerprint = fingerprintOf(e);
    const open = await this.o.store.open(fingerprint);
    if (open) {
      const worse = e.severityNumber > open.severityNumber;
      const alert: Alert = { ...open, count: open.count + 1, lastSeen: e.ts, lastMessage: e.message, resolved: false, ...(worse ? { severity: e.severity, severityNumber: e.severityNumber } : {}) };
      await this.o.store.save(alert, this.o.reopenMs);
      return alert;
    }
    const alert: Alert = {
      id: this.o.newId?.() ?? crypto.randomUUID(),
      fingerprint,
      severity: e.severity,
      severityNumber: e.severityNumber,
      message: e.message,
      lastMessage: e.message,
      cluster: e.cluster,
      namespace: e.namespace,
      workload: workloadOf(e.pod),
      pod: e.pod,
      node: e.node,
      container: e.container,
      service: e.service,
      traceId: e.traceId,
      firstSeen: e.ts,
      lastSeen: e.ts,
      count: 1,
      state: "investigating",
      resolved: false,
    };
    while (this.started.length && this.started[0]! <= now - 3_600_000) this.started.shift();
    if (this.started.length >= this.o.maxPerHour) {
      await this.o.store.save({ ...alert, state: "skipped" }, this.o.reopenMs);
      return { ...alert, state: "skipped" };
    }
    this.started.push(now);
    try {
      const { thread, done } = await this.o.investigator.start(alert);
      const withThread = { ...alert, thread };
      await this.o.store.save(withThread, this.o.reopenMs);
      const finish = done.then(
        async (outcome) => {
          const current = (await this.o.store.get(alert.id)) ?? withThread;
          await this.o.store.save({ ...current, state: outcome.error ? "failed" : "answered", summary: outcome.summary, error: outcome.error }, this.o.reopenMs);
        },
        (err: unknown) => this.o.log?.(`Alert ${alert.id}: writing its outcome failed`, err),
      );
      this.pending.add(finish);
      void finish.finally(() => this.pending.delete(finish));
      return withThread;
    } catch (err) {
      this.o.log?.(`Alert ${alert.id}: starting its investigation failed`, err);
      const failed = { ...alert, state: "failed" as const, error: err instanceof Error ? err.message : String(err) };
      await this.o.store.save(failed, this.o.reopenMs);
      return failed;
    }
  }
}

/** Whether an alert is resolved now: no event of it for `resolveMs`. */
export const withResolution = (a: Alert, now: number, resolveMs: number): Alert => ({ ...a, resolved: now - a.lastSeen >= resolveMs });

/** Alerts in memory (development, tests). */
export function memoryAlertStore(now: () => number = Date.now): AlertStore {
  const alerts = new Map<string, Alert>();
  const open = new Map<string, { id: string; until: number }>();
  return {
    async open(fingerprint) {
      const o = open.get(fingerprint);
      return o && o.until > now() ? alerts.get(o.id) : undefined;
    },
    async save(alert, reopenMs) {
      alerts.set(alert.id, alert);
      open.set(alert.fingerprint, { id: alert.id, until: alert.lastSeen + reopenMs });
    },
    async get(id) {
      return alerts.get(id);
    },
    async list(limit) {
      return [...alerts.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, limit);
    },
  };
}

/** The Redis commands the store uses (node-redis v5). */
export interface AlertRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  zAdd(key: string, members: { score: number; value: string }[]): Promise<unknown>;
  zRange(key: string, min: number, max: number, options?: { REV?: boolean }): Promise<string[]>;
  zRemRangeByRank(key: string, start: number, stop: number): Promise<unknown>;
  del(keys: string | string[]): Promise<unknown>;
  mGet(keys: string[]): Promise<(string | null)[]>;
}

/**
 * Alerts in Redis, under `<prefix>:alerts:`: each alert's JSON (kept 30 days), an index by last event (the newest
 * 1000), and each open fingerprint's alert id expiring with the reopen window.
 */
export function redisAlertStore(client: AlertRedis, prefix: string, keep = 1000): AlertStore {
  const base = `${prefix}:alerts`;
  const KEEP_MS = 30 * 24 * 3_600_000;
  const read = (raw: string | null) => (raw ? (JSON.parse(raw) as Alert) : undefined);
  return {
    async open(fingerprint) {
      const id = await client.get(`${base}:open:${fingerprint}`);
      return id ? read(await client.get(`${base}:alert:${id}`)) : undefined;
    },
    async save(alert, reopenMs) {
      await client.set(`${base}:alert:${alert.id}`, JSON.stringify(alert), { PX: KEEP_MS });
      await client.zAdd(`${base}:index`, [{ score: alert.lastSeen, value: alert.id }]);
      await client.zRemRangeByRank(`${base}:index`, 0, -keep - 1);
      const left = alert.lastSeen + reopenMs - Date.now();
      if (left > 0) await client.set(`${base}:open:${alert.fingerprint}`, alert.id, { PX: left });
    },
    async get(id) {
      return read(await client.get(`${base}:alert:${id}`));
    },
    async list(limit) {
      const ids = await client.zRange(`${base}:index`, 0, limit - 1, { REV: true });
      if (!ids.length) return [];
      return (await client.mGet(ids.map((id) => `${base}:alert:${id}`))).map(read).filter((a): a is Alert => !!a);
    },
  };
}
