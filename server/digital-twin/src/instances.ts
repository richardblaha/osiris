import type { Emit } from "./history.ts";
import { HistoryLog, HistoryReader } from "./history.ts";
import type { ClickHouse, Telemetry } from "./telemetry.ts";
import type { InstanceData, InstanceRecord, TwinStore } from "./store.ts";
import { startSync } from "./sync.ts";
import type { TwinSource } from "./twin.ts";
import { SOURCE_TYPES, type SourceDefaults, type SourceType } from "./sources/registry.ts";

/** A running instance: its record, data, adapter, telemetry and history; or why it could not start. */
export interface RunningInstance {
  record: InstanceRecord;
  data: InstanceData;
  source?: TwinSource;
  telemetry?: Telemetry;
  history?: HistoryReader;
  /** Why the source could not be made (a bad kubeconfig…): the instance has its stored data, nothing new. */
  error?: string;
  stop(): void;
}

export interface InstancesOptions {
  store: TwinStore;
  defaults: SourceDefaults;
  /** Where each instance's history goes (OpenTelemetry events); none: no history is written. */
  emit?: Emit;
  /** The ClickHouse the history is read back from (the service's own) and its records' ServiceName. */
  historyFrom?: { clickhouse: ClickHouse; service: string };
  intervalMs: number;
  types?: Record<string, SourceType>;
  log?: (message: string, err?: unknown) => void;
}

/**
 * The digital twins this service holds: each instance its own source, sync, history (OpenTelemetry events with
 * `twin.id` = the instance's id) and telemetry. Changing an instance restarts it; deleting stops it and drops its
 * data.
 */
export class Instances {
  private readonly running = new Map<string, RunningInstance>();
  private readonly types: Record<string, SourceType>;
  private readonly log: (message: string, err?: unknown) => void;

  constructor(private readonly options: InstancesOptions) {
    this.types = options.types ?? SOURCE_TYPES;
    this.log = options.log ?? ((m, e) => console.error(m, e ?? ""));
  }

  get store() {
    return this.options.store;
  }

  type(id: string): SourceType | undefined {
    return Object.hasOwn(this.types, id) ? this.types[id] : undefined;
  }

  typeList(): SourceType[] {
    return Object.values(this.types);
  }

  /** Starts every stored instance. */
  async start(): Promise<void> {
    for (const r of await this.options.store.instances()) await this.restart(r.id);
  }

  get(id: string): RunningInstance | undefined {
    return this.running.get(id);
  }

  list(): RunningInstance[] {
    return [...this.running.values()].sort((a, b) => a.record.name.localeCompare(b.record.name) || a.record.id.localeCompare(b.record.id));
  }

  /** (Re)starts an instance from its stored record; a stored instance that is gone is stopped. */
  async restart(id: string): Promise<RunningInstance | undefined> {
    this.running.get(id)?.stop();
    this.running.delete(id);
    const { store, defaults, emit, historyFrom, intervalMs } = this.options;
    const record = await store.instance(id);
    if (!record) return undefined;
    const data = store.of(id);
    const running: RunningInstance = { record, data, stop: () => {} };
    this.running.set(id, running);
    const type = this.type(record.sourceType);
    try {
      if (!type) throw new Error(`Unknown source type ${record.sourceType}`);
      const built = await type.create({ id, settings: record.settings as Record<string, string>, secrets: await store.secrets(id), defaults });
      running.source = built.source;
      running.telemetry = built.telemetry;
      running.history = historyFrom ? new HistoryReader(historyFrom.clickhouse, id, historyFrom.service) : undefined;
      const sync = await startSync({
        source: built.source,
        store: data,
        history: emit ? new HistoryLog(emit, id, built.source.name) : undefined,
        intervalMs,
        log: this.log,
        onRound: (err) => {
          running.error = err ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ""}`.slice(0, 500) : undefined;
        },
      });
      running.stop = sync.stop;
    } catch (err) {
      running.error = (err as Error).message.slice(0, 500);
      this.log(`The twin ${id} could not start`, err);
    }
    return running;
  }

  /** Stops an instance and deletes it with everything that is its own. */
  async delete(id: string): Promise<boolean> {
    this.running.get(id)?.stop();
    this.running.delete(id);
    return this.options.store.deleteInstance(id);
  }

  stopAll() {
    for (const r of this.running.values()) r.stop();
  }
}
