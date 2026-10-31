import { readFile } from "node:fs/promises";
import type { ThreadMessage } from "@osiris/shared";
import type { AlertView } from "./alerts/app.ts";

/** The alerts service as the twin's API asks it: the alerts of a cluster, one alert, its investigation's conversation. */
export interface AlertsClient {
  list(cluster: string, limit: number): Promise<AlertView[]>;
  get(id: string): Promise<AlertView | undefined>;
  messages(id: string): Promise<ThreadMessage[]>;
}

/**
 * Over HTTP to the alerts service (ALERTS_URL), with the twin's ServiceAccount token projected for the service's
 * audience (read fresh each call: the kubelet rotates it), or a development token.
 */
export function alertsClient(o: { url: string; tokenPath?: string; token?: string; fetchFn?: typeof fetch }): AlertsClient {
  const call = async <T>(path: string): Promise<T | undefined> => {
    const token = o.token ?? (await readFile(o.tokenPath!, "utf8")).trim();
    const res = await (o.fetchFn ?? fetch)(`${o.url.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`The alerts service answered ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    list: async (cluster, limit) => (await call<{ value: AlertView[] }>(`/alerts?${new URLSearchParams({ cluster, limit: String(limit) })}`))?.value ?? [],
    get: (id) => call<AlertView>(`/alerts/${encodeURIComponent(id)}`),
    messages: async (id) => (await call<ThreadMessage[]>(`/alerts/${encodeURIComponent(id)}/messages`)) ?? [],
  };
}
