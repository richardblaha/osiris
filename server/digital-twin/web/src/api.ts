import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary, TwinChange } from "@osiris/shared";
import type { ThreadMessage, TwinEvent } from "@osiris/shared";

/** An alert as the twin shows it: one problem its events tell of, and Osiris's investigation of it. */
export interface TwinAlert {
  id: string;
  severity: string;
  message: string;
  lastMessage: string;
  cluster?: string;
  namespace?: string;
  workload?: string;
  pod?: string;
  node?: string;
  container?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  state: "investigating" | "answered" | "failed" | "skipped";
  resolved: boolean;
  thread?: string;
  summary?: string;
  error?: string;
}
import type { DigitalTwin, DigitalTwinRelationship, DtdlInterface, DtdlModelData } from "@osiris/shared/dtdl.ts";
import { autoSignIn, getAccessToken } from "./auth.ts";

/** The digital twin the app shows: every twin call goes to `/api/instances/<id>`. */
let instance = "";
export const setInstance = (id: string) => {
  instance = id;
};
export const currentInstance = () => instance;
const tw = () => `/api/instances/${encodeURIComponent(instance)}`;

/** A digital twin as its viewers see it; `error` says why its source isn't running. */
export interface InstanceSummary {
  id: string;
  name: string;
  sourceType: string;
  error: string | null;
}
/** A twin as admins manage it: its source's settings; of its secrets only the names of those set. */
export interface InstanceRecord extends InstanceSummary {
  settings: Record<string, string>;
  secretNames: string[];
  createdAt: number;
  updatedAt: number;
}
/** One field of a source type's settings form. */
export interface SourceField {
  name: string;
  kind: "text" | "url" | "textarea" | "list" | "select";
  secret?: boolean;
  required?: boolean;
  options?: string[];
  default?: string;
  when?: { field: string; value: string };
}
export interface SourceType {
  id: string;
  fields: SourceField[];
}

/** One API call with the signed-in user's token; the server's message goes to the UI as it is. */
async function call<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  // The session ended on the server's side: sign in again (once a minute at most).
  if (res.status === 401) autoSignIn();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string[] } | null;
    throw new Error(body?.detail?.length ? `${body.error}: ${body.detail.join("; ")}` : (body?.error ?? `${res.status}`));
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A change through the API: a JSON body, the server's message on failure. */
async function send<T>(method: "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as { error?: string; detail?: string[] } | null;
    throw new Error(answer?.detail?.length ? `${answer.error}: ${answer.detail.join("; ")}` : (answer?.error ?? `${res.status}`));
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** One panel of a dashboard: logs, their bar chart, a metric or traces, with the page's filter values. */
export interface DashboardPanel {
  id: string;
  kind: "logs" | "logBars" | "metric" | "traces";
  title: string;
  /** Columns of four it spans. */
  width: number;
  filter: Record<string, string>;
}
export interface DashboardSummary {
  id: string;
  name: string;
  updatedAt: number;
}
/** A named dashboard, shared by everyone who sees the twin. */
export interface Dashboard {
  id: string;
  name: string;
  /** The time range its panels show, ms back from now. */
  range: number;
  panels: DashboardPanel[];
  updatedAt: number;
  updatedBy: string;
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
  /** A PersistentVolumeClaim. */
  claim?: string;
}
/** A query string of the set values (no empty strings, no `false`). */
const query = (f: object) => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && v !== false).map(([k, v]) => [k, String(v)]));

export const api = {
  me: () => call<{ sub: string; name: string | null; email: string | null; picture: string | null; admin: boolean } | null>("/api/me"),
  // The user's own preferences, the same in every twin (the windows' layout).
  preference: async (key: "layout") => (await call<{ value: unknown }>(`/api/me/preferences/${key}`)).value,
  savePreference: (key: "layout", value: unknown) => send<void>("PUT", `/api/me/preferences/${key}`, { value }),
  // The digital twins the user may see; admins also manage them and the kinds of source they can have.
  instances: async () => (await call<{ value: InstanceSummary[] }>("/api/instances")).value,
  sourceTypes: async () => (await call<{ value: SourceType[] }>("/api/source-types")).value,
  adminInstances: async () => (await call<{ value: InstanceRecord[] }>("/api/admin/instances")).value,
  saveInstance: (id: string, body: { name: string; sourceType: string; settings: Record<string, string>; secrets: Record<string, string | null> }) =>
    send<InstanceRecord>("PUT", `/api/admin/instances/${encodeURIComponent(id)}`, body),
  deleteInstance: (id: string) => send<void>("DELETE", `/api/admin/instances/${encodeURIComponent(id)}`),
  // The twin, in the shape of the Azure Digital Twins API (`at`: a past time from the history).
  models: async () => (await call<{ value: DtdlModelData[] }>(`${tw()}/models`)).value,
  // Admins edit the DTDL: upsert one model (its `presentation` says how the views draw its twins), upload a batch,
  // or decommission one (refused while a twin instantiates it).
  model: (id: string) => call<DtdlModelData>(`${tw()}/models/${encodeURIComponent(id)}`),
  putModel: (id: string, doc: DtdlInterface) => send<DtdlModelData>("PUT", `${tw()}/models/${encodeURIComponent(id)}`, doc),
  uploadModels: (docs: DtdlInterface[]) => send<{ value: DtdlModelData[] }>("POST", `${tw()}/models`, docs),
  deleteModel: (id: string) => send<void>("DELETE", `${tw()}/models/${encodeURIComponent(id)}`),
  // The warn/error events the collector's twin/events processor caught (the Redis stream).
  // The twin's alerts (the alerts service's), and the conversation in which Osiris investigated one (read-only).
  alerts: async (limit = 30) => (await call<{ value: TwinAlert[] }>(`${tw()}/alerts?limit=${limit}`)).value,
  alertMessages: (id: string) => call<ThreadMessage[]>(`${tw()}/alerts/${encodeURIComponent(id)}/messages`),
  events: (q: { limit?: number; cluster?: string; severity?: "warn" | "error" | "fatal" } = {}) =>
    call<{ value: TwinEvent[] }>(`${tw()}/events?${query(q)}`),

  twins: async (at: number | null) => (await call<{ value: DigitalTwin[] }>(`${tw()}/digitaltwins${at === null ? "" : `?at=${at}`}`)).value,
  relationships: async (at: number | null) => (await call<{ value: DigitalTwinRelationship[] }>(`${tw()}/relationships${at === null ? "" : `?at=${at}`}`)).value,
  errorLogs: async (at: number | null) => (await call<{ value: Record<string, number> }>(`${tw()}/telemetry/errorLogs${at === null ? "" : `?at=${at}`}`)).value,
  storage: async (at: number | null) =>
    (await call<{ value: Record<string, { used: number; fsCapacity: number }> }>(`${tw()}/telemetry/storage${at === null ? "" : `?at=${at}`}`)).value,
  network: async (at: number | null) => (await call<{ value: Record<string, number> }>(`${tw()}/telemetry/network${at === null ? "" : `?at=${at}`}`)).value,
  range: () => call<{ from: number | null; to: number }>(`${tw()}/history/range`),
  history: async (dtId: string, f: { from: number; to: number; limit?: number }) =>
    (await call<{ value: TwinChange[] }>(`${tw()}/digitaltwins/${encodeURIComponent(dtId)}/history?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`)).value,
  facets: (f: { from: number; to: number; namespace?: string }) => call<TelemetryFacets>(`${tw()}/facets?${query(f)}`),
  dashboards: async () => (await call<{ value: DashboardSummary[] }>(`${tw()}/dashboards`)).value,
  dashboard: (id: string) => call<Dashboard>(`${tw()}/dashboards/${encodeURIComponent(id)}`),
  saveDashboard: (d: Omit<Dashboard, "updatedAt" | "updatedBy">) =>
    send<Dashboard>("PUT", `${tw()}/dashboards/${encodeURIComponent(d.id)}`, { name: d.name, range: d.range, panels: d.panels }),
  deleteDashboard: (id: string) => send<void>("DELETE", `${tw()}/dashboards/${encodeURIComponent(id)}`),
  logHistogram: (f: Scope & { from: number; to: number; service?: string; severity?: string; q?: string; traceId?: string }) =>
    call<{ step: number; buckets: { ts: number; error: number; warn: number; other: number }[] }>(`${tw()}/logs/histogram?${query(f)}`),
  savedFilters: async () => (await call<{ value: SavedFilter[] }>(`${tw()}/me/filters?kind=logs`)).value,
  saveFilter: (f: SavedFilter) => send<SavedFilter>("PUT", `${tw()}/me/filters/${encodeURIComponent(f.id)}`, { kind: "logs", name: f.name, filter: f.filter }),
  deleteFilter: (id: string) => send<void>("DELETE", `${tw()}/me/filters/${encodeURIComponent(id)}`),
  logs: (f: Scope & { from: number; to: number; service?: string; severity?: string; q?: string; traceId?: string; limit: number }) => call<LogRecord[]>(`${tw()}/logs?${query(f)}`),
  traces: (f: Scope & { from: number; to: number; service?: string; q?: string; minMs?: number; errors?: boolean; limit?: number }) => call<TraceSummary[]>(`${tw()}/traces?${query(f)}`),
  trace: (traceId: string) => call<SpanRecord[]>(`${tw()}/trace/${traceId}`),
  metrics: (range: { from: number; to: number }, q?: string) =>
    call<MetricInfo[]>(`${tw()}/metrics?from=${range.from}&to=${range.to}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  series: (f: Scope & { from: number; to: number; name: string; type: MetricInfo["type"]; groupBy?: string; service?: string }) =>
    call<{ step: number; series: MetricSeries[] }>(`${tw()}/series?${query(f)}`),
};
