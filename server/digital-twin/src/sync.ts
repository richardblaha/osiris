import { interfaceErrors } from "@osiris/shared/dtdl.ts";
import { CHECKPOINT_MS, type HistoryLog } from "./history.ts";
import type { TwinStore } from "./store.ts";
import type { TwinSource } from "./twin.ts";

const CHECKPOINT_KEY = "history.checkpoint_at";

/**
 * Keeps the store in step with the source: its models once (refused when not valid DTDL), then every `intervalMs` a
 * snapshot written to SQLite, and what changed sent to the history (with a checkpoint of everything once a day). A
 * failing source skips the round; the store keeps the last good state.
 */
export async function startSync(options: {
  source: TwinSource;
  store: TwinStore;
  history?: HistoryLog;
  intervalMs: number;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}): Promise<{ stop(): void; round(): Promise<number> }> {
  const { source, store, history, intervalMs } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((m, e) => console.error(m, e ?? ""));
  const models = source.models();
  const invalid = models.flatMap(interfaceErrors);
  if (invalid.length) throw new Error(`The ${source.name} source's DTDL models are not valid:\n${invalid.join("\n")}`);
  await store.putModels(source.name, models, now());

  let busy = false;
  /** One round; returns how many history events it sent. */
  const round = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      const snapshot = await source.snapshot();
      const result = await store.sync(source.name, snapshot, now());
      if (!history) return 0;
      // The first round, and then one a day, writes a checkpoint.
      const last = await store.meta(CHECKPOINT_KEY);
      const due = last === undefined || result.ts - Number(last) >= CHECKPOINT_MS;
      const sent = history.record(result, await store.relationships(), due ? { twins: await store.twins() } : undefined);
      if (due) await store.setMeta(CHECKPOINT_KEY, String(result.ts));
      return sent;
    } catch (err) {
      log(`Syncing the twin with its source (${source.name}) failed`, err);
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
