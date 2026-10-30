import { interfaceErrors } from "@osiris/shared/dtdl.ts";
import { CHECKPOINT_MS, type HistoryLog } from "./history.ts";
import type { InstanceData } from "./store.ts";
import type { TwinSource } from "./twin.ts";

const CHECKPOINT_KEY = "history.checkpoint_at";

/**
 * Keeps the store in step with the source: its models once (refused when not valid DTDL), then every `intervalMs` a
 * snapshot written to SQLite, and what changed sent to the history (with a checkpoint of everything once a day). A
 * failing source skips the round; the store keeps the last good state.
 */
export async function startSync(options: {
  source: TwinSource;
  store: InstanceData;
  history?: HistoryLog;
  intervalMs: number;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
  /** After each round: nothing when it synced, else why it failed. */
  onRound?: (err?: Error) => void;
}): Promise<{ stop(): void; round(): Promise<number> }> {
  const { source, store, history, intervalMs } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m, e) => console.error(m, e ?? ""));
  const models = source.models();
  const invalid = models.flatMap(interfaceErrors);
  if (invalid.length) throw new Error(`The ${source.name} source's DTDL models are not valid:\n${invalid.join("\n")}`);
  await store.putModels(models, now());

  let busy = false;
  /** One round; returns how many history events it sent. */
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      const snapshot = await source.snapshot();
      const result = await store.sync(snapshot, now());
      options.onRound?.();
      if (!history) return 0;
      // The first round, and then one a day, writes a checkpoint.
      const last = await store.meta(CHECKPOINT_KEY);
      const due = last === undefined || result.ts - Number(last) >= CHECKPOINT_MS;
      const sent = history.record(result, await store.relationships(), due ? { twins: await store.twins() } : undefined);
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
