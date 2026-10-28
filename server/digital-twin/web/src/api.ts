import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary, Twin } from "@osiris/shared";
import { getAccessToken } from "./auth.ts";

/** One API call with the signed-in user's token; the server's message goes to the UI as it is. */
async function call<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => call<{ sub: string; name: string | null; email: string | null } | null>("/api/me"),
  twin: () => call<Twin>("/api/twin"),
  facets: (range: { from: number; to: number }) => call<TelemetryFacets>(`/api/facets?from=${range.from}&to=${range.to}`),
  logs: (f: { from: number; to: number; service?: string; namespace?: string; pod?: string; severity?: string; q?: string; traceId?: string; limit: number }) =>
    call<LogRecord[]>(`/api/logs?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]))}`),
  traces: (f: { from: number; to: number; service?: string; namespace?: string; q?: string; minMs?: number; errors?: boolean; limit?: number }) =>
    call<TraceSummary[]>(`/api/traces?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && v !== false).map(([k, v]) => [k, String(v)]))}`),
  trace: (traceId: string) => call<SpanRecord[]>(`/api/trace/${traceId}`),
  metrics: (range: { from: number; to: number }, q?: string) =>
    call<MetricInfo[]>(`/api/metrics?from=${range.from}&to=${range.to}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  series: (f: { from: number; to: number; name: string; type: MetricInfo["type"]; groupBy?: string; service?: string; namespace?: string }) => {
    const p = new URLSearchParams({ from: String(f.from), to: String(f.to), name: f.name, type: f.type });
    if (f.groupBy) p.set("groupBy", f.groupBy);
    if (f.service) p.set("service", f.service);
    if (f.namespace) p.set("namespace", f.namespace);
    return call<{ step: number; series: MetricSeries[] }>(`/api/series?${p}`);
  },
};
