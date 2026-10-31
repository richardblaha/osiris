import type { TwinEvent } from "@osiris/shared";
import type { TwinStateStore } from "./state.ts";

/** OpenTelemetry's severity numbers (the collector writes them on the stream entries). */
export const SEVERITY_NUMBERS: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

export interface EventPushOptions {
  state: TwinStateStore;
  /** Osiris's gateway (OSIRIS_URL); the events go to its thread as runs of the project. */
  url: string;
  project: string;
  /** The thread whose runs the events become (EVENTS_PUSH_THREAD). */
  thread: string;
  /** The bearer token the gateway accepts for the push (a service account's; EVENTS_PUSH_TOKEN). */
  token: string;
  /** Only events at least this severe are pushed. */
  minSeverity: string;
  /** At most this many pushes per minute (the rest wait for the next events). */
  maxPerMinute: number;
  group?: string;
  consumer?: string;
  fetchFn?: typeof fetch;
  log?: (message: string, err?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

const messageOf = (e: TwinEvent): string => {
  const where = [e.cluster, e.namespace, e.pod ?? e.node, e.container].filter(Boolean).join(" / ");
  return `Událost z dvojčete (${e.severity.toLowerCase()}${where ? `, ${where}` : ""}): ${e.message}${e.traceId ? ` (trace ${e.traceId})` : ""}`;
};

/**
 * Watches the collector's warn/error events (the `otel:events` Redis stream) and pushes them to Osiris's agent: each
 * new event at least `minSeverity` becomes a run of the configured thread (`POST /api/threads/{id}/runs` on the
 * gateway, in the twin's project), at most `maxPerMinute`. Returns a stop function.
 */
export function startEventPush(options: EventPushOptions): () => void {
  const { state, url, project, thread, token, fetchFn, log } = options;
  const min = SEVERITY_NUMBERS[options.minSeverity] ?? SEVERITY_NUMBERS.error!;
  const group = options.group ?? "osiris-events";
  const consumer = options.consumer ?? `digital-twin-${process.pid}`;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchIt = fetchFn ?? fetch;
  let stopped = false;
  const pushed: number[] = [];

  const loop = async () => {
    while (!stopped) {
      let events: TwinEvent[];
      try {
        events = await state.readNewEvents(group, consumer, 50, 5_000);
      } catch (err) {
        log?.("Reading the twin's events failed", err);
        await sleep(5_000);
        continue;
      }
      if (!events.length) {
        await sleep(1_000);
        continue;
      }
      for (const e of events) {
        if (e.severityNumber < min) continue;
        const now = Date.now();
        while (pushed.length && pushed[0]! <= now - 60_000) pushed.shift();
        if (pushed.length >= options.maxPerMinute) continue;
        pushed.push(now);
        try {
          const res = await fetchIt(`${url}/api/threads/${encodeURIComponent(thread)}/runs`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-project-id": project },
            body: JSON.stringify({ message: messageOf(e) }),
          });
          if (!res.ok) log?.(`Pushing the event ${e.id} to Osiris failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
        } catch (err) {
          log?.(`Pushing the event ${e.id} to Osiris failed`, err);
        }
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
