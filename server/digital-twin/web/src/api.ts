import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary, TwinChange } from "@osiris/shared";
import type { DigitalTwin, DigitalTwinRelationship, DtdlModelData } from "@osiris/shared/dtdl.ts";
import { autoSignIn, getAccessToken } from "./auth.ts";

/** One API call with the signed-in user's token; the server's message goes to the UI as it is. */
async function call<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  // The session ended on the server's side: sign in again (once a minute at most).
  if (res.status === 401) autoSignIn();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A change through the API: a JSON body, the server's message on failure. */
async function send<T>(method: "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(answer?.error ?? `${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A filter the user saved for the logs page: the page's own filter values. */
export interface SavedFilter {
  id: string;
  name: string;
  filter: Record<string, string>;
}

/** Whose telemetry: OpenTelemetry's k8s namespace, pod, node or container. */
export interface Scope {
  namespace?: string;
  pod?: string;
  node?: string;
  container?: string;
}
/** A query string of the set values (no empty strings, no `false`). */
const query = (f: object) => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && v !== false).map(([k, v]) => [k, String(v)]));

export const api = {
  me: () => call<{ sub: string; name: string | null; email: string | null } | null>("/api/me"),
  // The twin, in the shape of the Azure Digital Twins API (`at`: a past time from the history).
  models: async () => (await call<{ value: DtdlModelData[] }>("/api/models")).value,
  twins: async (at: number | null) => (await call<{ value: DigitalTwin[] }>(`/api/digitaltwins${at === null ? "" : `?at=${at}`}`)).value,
  relationships: async (at: number | null) => (await call<{ value: DigitalTwinRelationship[] }>(`/api/relationships${at === null ? "" : `?at=${at}`}`)).value,
  errorLogs: async (at: number | null) => (await call<{ value: Record<string, number> }>(`/api/telemetry/errorLogs${at === null ? "" : `?at=${at}`}`)).value,
  network: async (at: number | null) => (await call<{ value: Record<string, number> }>(`/api/telemetry/network${at === null ? "" : `?at=${at}`}`)).value,
  range: () => call<{ from: number | null; to: number }>("/api/history/range"),
  history: async (dtId: string, f: { from: number; to: number; limit?: number }) =>
    (await call<{ value: TwinChange[] }>(`/api/digitaltwins/${encodeURIComponent(dtId)}/history?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`)).value,
  facets: (range: { from: number; to: number }) => call<TelemetryFacets>(`/api/facets?from=${range.from}&to=${range.to}`),
  logHistogram: (f: Scope & { from: number; to: number; service?: string; severity?: string; q?: string; traceId?: string }) =>
    call<{ step: number; buckets: { ts: number; error: number; warn: number; other: number }[] }>(`/api/logs/histogram?${query(f)}`),
  savedFilters: async () => (await call<{ value: SavedFilter[] }>("/api/me/filters?kind=logs")).value,
  saveFilter: (f: SavedFilter) => send<SavedFilter>("PUT", `/api/me/filters/${encodeURIComponent(f.id)}`, { kind: "logs", name: f.name, filter: f.filter }),
  deleteFilter: (id: string) => send<void>("DELETE", `/api/me/filters/${encodeURIComponent(id)}`),
  logs: (f: Scope & { from: number; to: number; service?: string; severity?: string; q?: string; traceId?: string; limit: number }) => call<LogRecord[]>(`/api/logs?${query(f)}`),
  traces: (f: Scope & { from: number; to: number; service?: string; q?: string; minMs?: number; errors?: boolean; limit?: number }) => call<TraceSummary[]>(`/api/traces?${query(f)}`),
  trace: (traceId: string) => call<SpanRecord[]>(`/api/trace/${traceId}`),
  metrics: (range: { from: number; to: number }, q?: string) =>
    call<MetricInfo[]>(`/api/metrics?from=${range.from}&to=${range.to}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  series: (f: Scope & { from: number; to: number; name: string; type: MetricInfo["type"]; groupBy?: string; service?: string }) =>
    call<{ step: number; series: MetricSeries[] }>(`/api/series?${query(f)}`),
};
