import { interfaceErrors } from "@osiris/shared/dtdl.ts";
import type { DigitalTwin, DigitalTwinRelationship } from "@osiris/shared/dtdl.ts";
import { CHECKPOINT_MS, type HistoryLog } from "./history.ts";
import type { InstanceData } from "./store.ts";
import { diffSnapshots, type TelemetryState, type TwinStateStore } from "./state.ts";
import { errorsByTwin, valuesByTwin, type SourceSnapshot, type TwinSource } from "./twin.ts";
import type { Telemetry } from "./telemetry.ts";

const CHECKPOINT_KEY = "history.checkpoint_at";

/**
 * The telemetry the view draws, computed from the telemetry store (ClickHouse) for the snapshot's twins: each twin's
 * error log count, network bytes/s and storage filesystem, by the source's attribute mappings.
 */
export async function telemetryState(source: TwinSource, telemetry: Telemetry | undefined, snapshot: SourceSnapshot, at?: number): Promise<TelemetryState> {
  const out: TelemetryState = { errorLogs: {}, network: {}, storage: {} };
  if (!telemetry) return out;
  const twins = snapshot.twins.map((t) => ({ $dtId: t.$dtId, otelResource: t.otelResource }));
  if (source.errorAttributes?.length) out.errorLogs = errorsByTwin(twins, source.errorAttributes, await telemetry.errorCounts(source.errorAttributes, at));
  if (source.networkMetrics?.length)
    for (const m of source.networkMetrics) valuesByTwin(twins, m.attributes, await telemetry.rates(m.metric, m.attributes, at), out.network);
  if (source.storageMetrics) {
    const m = source.storageMetrics;
    const [capacity, available] = await Promise.all([telemetry.latest(m.capacity, m.attributes, at), telemetry.latest(m.available, m.attributes, at)]);
    const fs = valuesByTwin(twins, m.attributes, capacity);
    const free = valuesByTwin(twins, m.attributes, available);
    for (const [id, size] of Object.entries(fs)) if (free[id] !== undefined) out.storage[id] = { used: Math.max(0, size - free[id]!), fsCapacity: size };
  }
  return out;
}

/**
 * Keeps the twin in step with its source: its models once into SQLite (refused when not valid DTDL; a model an admin
 * edited is left alone), then every `intervalMs` a snapshot diffed against the last one in memory, written to the
 * state cache (Redis) with the telemetry the view draws, and what changed sent to the history (with a checkpoint of
 * everything once a day). A failing source skips the round; the cache keeps the last good state.
 */
export async function startSync(options: {
  source: TwinSource;
  store: InstanceData;
  /** The cache the twins' current state and the view's telemetry go to (Redis; the API and the agent read it). */
  state: TwinStateStore;
  /** The telemetry store (ClickHouse) the view's telemetry is computed from; none: no telemetry. */
  telemetry?: Telemetry;
  history?: HistoryLog;
  intervalMs: number;
  /** How long the view's telemetry outlives a round in the cache. */
  telemetryTtlSeconds?: number;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
  /** After each round: nothing when it synced, else why it failed. */
  onRound?: (err?: Error) => void;
}): Promise<{ stop(): void; round(): Promise<number> }> {
  const { source, store, state, telemetry, history, intervalMs } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m, e) => console.error(m, e ?? ""));
  const models = source.models();
  const invalid = models.flatMap(interfaceErrors);
  if (invalid.length) throw new Error(`The ${source.name} source's DTDL models are not valid:\n${invalid.join("\n")}`);
  await store.putModels(models, now());

  let last: { twins: DigitalTwin[]; relationships: DigitalTwinRelationship[] } | undefined;
  let busy = false;
  /** One round; returns how many history events it sent. */
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      const snapshot = await source.snapshot();
      const result = diffSnapshots(last, snapshot, now());
      last = { twins: result.twins, relationships: result.relationships };
      await state.writeSnapshot(store.instance, result.twins, result.relationships, await telemetryState(source, telemetry, snapshot, result.ts), result.ts, options.telemetryTtlSeconds ?? intervalMs / 1000 * 3);
      options.onRound?.();
      if (!history) return 0;
      // The first round, and then one a day, writes a checkpoint.
      const lastCheckpoint = await store.meta(CHECKPOINT_KEY);
      const due = lastCheckpoint === undefined || result.ts - Number(lastCheckpoint) >= CHECKPOINT_MS;
      const sent = history.record(result, result.relationships, due ? { twins: result.twins } : undefined);
      if (due) await store.setMeta(CHECKPOINT_KEY, String(result.ts));
      return sent;
    } catch (err) {
      log(`Syncing the twin ${store.instance} with its source (${source.name}) failed`, err);
      options.onRound?.(err as Error);
      return 0;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void round(), intervalMs);
  timer.unref();
  await round();
  return { stop: () => clearInterval(timer), round };
}
