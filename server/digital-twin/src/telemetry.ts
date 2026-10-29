import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary } from "@osiris/shared";
import { errorKey, type ErrorCounts } from "./twin.ts";

/** ClickHouse's HTTP interface with a read-only user; values go in as query parameters (`{name:Type}`), never as SQL. */
export class ClickHouse {
  constructor(
    private readonly url: string,
    private readonly user: string,
    private readonly password: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async query<T>(sql: string, params: Record<string, string | number> = {}): Promise<T[]> {
    const qs = new URLSearchParams({ default_format: "JSON", database: "otel" });
    for (const [k, v] of Object.entries(params)) qs.set(`param_${k}`, String(v));
    const res = await this.fetchFn(`${this.url.replace(/\/$/, "")}/?${qs}`, {
      method: "POST",
      headers: { "x-clickhouse-user": this.user, "x-clickhouse-key": this.password },
      body: sql,
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return ((await res.json()) as { data: T[] }).data;
  }
}

export interface Range {
  /** Epoch ms. */
  from: number;
  to: number;
}

const range = (r: Range) => ({ from: Math.floor(r.from / 1000), to: Math.ceil(r.to / 1000) });
/** Where a pod's namespace is: the resource attribute OTel's Kubernetes processors set. */
const NS = "ResourceAttributes['k8s.namespace.name']";
const POD = "ResourceAttributes['k8s.pod.name']";
/** Which cluster a record belongs to (the collector's resource/cluster processor sets it). */
const CLUSTER = "ResourceAttributes['k8s.cluster.name']";
const METRIC_TABLES = { gauge: "otel_metrics_gauge", sum: "otel_metrics_sum", histogram: "otel_metrics_histogram" } as const;
export type MetricType = keyof typeof METRIC_TABLES;

/** Lowest SeverityNumber of each level (OpenTelemetry log data model). */
export const SEVERITY: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

/**
 * The cluster's telemetry as the OpenTelemetry Collector's ClickHouse exporter writes it (database otel) — the same
 * queries Osiris's Dashboards and the dashboard app read it with, plus the per-pod error counts the twin's status
 * colours are made of. With `cluster`, only that cluster's records (`k8s.cluster.name`, set by the collector's
 * resource/cluster processor): several clusters can share one ClickHouse without their telemetry mixing.
 */
export class Telemetry {
  constructor(
    readonly ch: ClickHouse,
    private readonly cluster?: string,
  ) {}

  /** The cluster filter's bare condition (`k8s.cluster.name = …`), '' without a cluster. */
  private clusterCond(): string {
    return this.cluster ? `${CLUSTER} = {cluster:String}` : "";
  }

  /** The cluster filter: its WHERE fragment with a leading ` AND `, and its parameter; empty without a cluster. */
  private of(): { where: string; params: Record<string, string | number> } {
    return this.cluster ? { where: ` AND ${this.clusterCond()}`, params: { cluster: this.cluster } } : { where: "", params: {} };
  }

  /** Services and namespaces seen in the range, for the filters. */
  async facets(r: Range): Promise<TelemetryFacets> {
    const p = { ...this.of().params, ...range(r) };
    const cluster = this.of().where;
    const [services, namespaces] = await Promise.all([
      this.ch.query<{ s: string }>(
        `SELECT DISTINCT ServiceName AS s FROM (\n           SELECT ServiceName FROM otel_logs WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)${cluster}\n           UNION ALL SELECT ServiceName FROM otel_traces WHERE Timestamp BETWEEN toDateTime({from:UInt32}) AND toDateTime({to:UInt32})${cluster})\n         WHERE s <> '' ORDER BY s LIMIT 500`,
        p,
      ),
      this.ch.query<{ s: string }>(
        `SELECT DISTINCT ${NS} AS s FROM otel_logs WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)${cluster} AND s <> '' ORDER BY s LIMIT 500`,
        p,
      ),
    ]);
    return { services: services.map((x) => x.s), namespaces: namespaces.map((x) => x.s) };
  }

  /** Error log records of the last 15 minutes per pod, the twin's status overlay (a pod logs for itself, 0 with none). */
  /**
   * Error log records of the last 15 minutes by the values of the given resource attributes (an adapter's error
   * attributes, e.g. namespace and pod), keyed with `errorKey`. Records missing any of them don't count. The
   * attribute names go in as parameters, never as SQL.
   */
  async errorCounts(attributes: string[]): Promise<ErrorCounts> {
    if (!attributes.length) return new Map();
    const columns = attributes.map((_, i) => `ResourceAttributes[{a${i}:String}] AS k${i}`);
    const present = attributes.map((_, i) => `k${i} <> ''`).join(" AND ");
    const params: Record<string, string | number> = { ...this.of().params, severity: SEVERITY.error ?? 17 };
    attributes.forEach((a, i) => (params[`a${i}`] = a));
    const rows = await this.ch.query<Record<string, string>>(
      `SELECT ${columns.join(", ")}, count() AS count FROM otel_logs\n       WHERE Timestamp >= now() - INTERVAL 15 MINUTE AND SeverityNumber >= {severity:UInt8} AND ${present}${this.of().where}\n       GROUP BY ${attributes.map((_, i) => `k${i}`).join(", ")}`,
      params,
    );
    return new Map(rows.map((r) => [errorKey(attributes.map((_, i) => r[`k${i}`] ?? "")), Number(r.count)]));
  }

  /** The newest log records matching the filters (`to`: older than that, for the next page). */
  async logs(f: Range & { service?: string; namespace?: string; pod?: string; severity?: string; q?: string; traceId?: string; limit: number }): Promise<LogRecord[]> {
    const where = ["Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)", "Timestamp <= fromUnixTimestamp64Milli({toMs:Int64})" + this.of().where];
    const params: Record<string, string | number> = { ...this.of().params, ...range(f), toMs: f.to, limit: f.limit };
    if (f.service) (where.push("ServiceName = {service:String}"), (params.service = f.service));
    if (f.namespace) (where.push(`${NS} = {namespace:String}`), (params.namespace = f.namespace));
    if (f.pod) (where.push(`${POD} = {pod:String}`), (params.pod = f.pod));
    if (f.severity) (where.push("SeverityNumber >= {severity:UInt8}"), (params.severity = SEVERITY[f.severity] ?? 0));
    if (f.q) (where.push("positionCaseInsensitiveUTF8(Body, {q:String}) > 0"), (params.q = f.q));
    if (f.traceId) (where.push("TraceId = {traceId:String}"), (params.traceId = f.traceId));
    const rows = await this.ch.query<Omit<LogRecord, "ts"> & { ts: string }>(
      `SELECT toUnixTimestamp64Milli(Timestamp) AS ts, SeverityText AS severity, SeverityNumber AS severityNumber, ServiceName AS service,\n              ${NS} AS namespace, ${POD} AS pod, Body AS body, TraceId AS traceId, SpanId AS spanId,\n              LogAttributes AS attributes, ResourceAttributes AS resource\n       FROM otel_logs WHERE ${where.join(" AND ")} ORDER BY Timestamp DESC LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map((r) => ({ ...r, ts: Number(r.ts), severityNumber: Number(r.severityNumber) }));
  }

  /** Root spans (one per trace) matching the filters, newest first, with how many spans their trace has. */
  async traces(f: Range & { service?: string; namespace?: string; q?: string; minMs?: number; errors?: boolean; limit: number }): Promise<TraceSummary[]> {
    const where = ["Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)", "ParentSpanId = ''" + this.of().where];
    const params: Record<string, string | number> = { ...this.of().params, ...range(f), limit: f.limit };
    if (f.service) (where.push("ServiceName = {service:String}"), (params.service = f.service));
    if (f.namespace) (where.push(`${NS} = {namespace:String}`), (params.namespace = f.namespace));
    if (f.q) (where.push("positionCaseInsensitiveUTF8(SpanName, {q:String}) > 0"), (params.q = f.q));
    if (f.minMs) (where.push("Duration >= {minNs:UInt64}"), (params.minNs = Math.round(f.minMs * 1e6)));
    if (f.errors) where.push("StatusCode = 'Error'");
    const rows = await this.ch.query<{ ts: string; traceId: string; service: string; name: string; durationNs: string; status: string; spans: string }>(
      `SELECT toUnixTimestamp64Milli(r.Timestamp) AS ts, r.TraceId AS traceId, r.ServiceName AS service, r.SpanName AS name,\n              r.Duration AS durationNs, r.StatusCode AS status,\n              (SELECT count() FROM otel_traces t WHERE t.TraceId = r.TraceId${this.clusterCond() ? ` AND t.${this.clusterCond()}` : ""}) AS spans\n       FROM (SELECT * FROM otel_traces WHERE ${where.join(" AND ")} ORDER BY Timestamp DESC LIMIT {limit:UInt32}) AS r\n       ORDER BY r.Timestamp DESC`,
      params,
    );
    return rows.map((r) => ({ ts: Number(r.ts), traceId: r.traceId, service: r.service, name: r.name, durationMs: Number(r.durationNs) / 1e6, error: r.status === "Error", spans: Number(r.spans) }));
  }

  /** Every span of a trace, in start order. */
  async trace(traceId: string): Promise<SpanRecord[]> {
    const rows = await this.ch.query<{
      ts: string;
      spanId: string;
      parentSpanId: string;
      service: string;
      name: string;
      kind: string;
      durationNs: string;
      status: string;
      statusMessage: string;
      attributes: Record<string, string>;
      resource: Record<string, string>;
    }>(
      `SELECT toUnixTimestamp64Nano(Timestamp) AS ts, SpanId AS spanId, ParentSpanId AS parentSpanId, ServiceName AS service, SpanName AS name,\n              SpanKind AS kind, Duration AS durationNs, StatusCode AS status, StatusMessage AS statusMessage, SpanAttributes AS attributes,\n              ResourceAttributes AS resource\n       FROM otel_traces WHERE TraceId = {traceId:String}${this.of().where} ORDER BY Timestamp LIMIT 2000`,
      { ...this.of().params, traceId },
    );
    return rows.map((r) => ({
      ...r,
      startMs: Number(BigInt(r.ts) / 1000n) / 1000,
      durationMs: Number(r.durationNs) / 1e6,
      error: r.status === "Error",
    }));
  }

  /** Metrics seen in the range, by name (and type), with their unit and description. */
  async metrics(r: Range, q?: string): Promise<MetricInfo[]> {
    const params: Record<string, string | number> = { ...this.of().params, ...range(r), q: q ?? "" };
    const parts = Object.entries(METRIC_TABLES).map(
      ([type, table]) =>
        `SELECT MetricName AS name, '${type}' AS type, any(MetricUnit) AS unit, any(MetricDescription) AS description\n         FROM ${table} WHERE TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)${this.of().where}\n           AND positionCaseInsensitiveUTF8(MetricName, {q:String}) > 0 GROUP BY MetricName`,
    );
    return this.ch.query<MetricInfo>(`${parts.join(" UNION ALL ")} ORDER BY name LIMIT 1000`, params);
  }

  /**
   * One metric over time in `step`-second buckets, a series per value of `groupBy` (an attribute or resource
   * attribute; the 8 with most points). Gauges average; monotonic sums give their rate per second; histograms the
   * mean of what they measured in each bucket.
   */
  async series(f: Range & { name: string; type: MetricType; groupBy?: string; service?: string; namespace?: string; step: number }): Promise<MetricSeries[]> {
    const table = METRIC_TABLES[f.type];
    const params: Record<string, string | number> = { ...this.of().params, ...range(f), name: f.name, step: f.step, g: f.groupBy ?? "", service: f.service ?? "", namespace: f.namespace ?? "" };
    const group = "if({g:String} = '', '', if(mapContains(Attributes, {g:String}), Attributes[{g:String}], ResourceAttributes[{g:String}]))";
    const where = [
      "MetricName = {name:String}",
      "TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)",
      "({service:String} = '' OR ServiceName = {service:String})",
      "({namespace:String} = '' OR " + NS + " = {namespace:String})",
      "(1 = 1" + this.of().where + ")",
    ];
    // A series is one source within a group (a pod, a container…), so counters are differenced per source first.
    const source = "cityHash64(ServiceName, Attributes, ResourceAttributes['k8s.pod.uid'], ResourceAttributes['k8s.node.name'], ResourceAttributes['service.instance.id'])";
    const value =
      f.type === "gauge"
        ? "avg(Value)"
        : f.type === "sum"
          ? "if(any(IsMonotonic), (max(Value) - min(Value)) / {step:UInt32}, avg(Value))"
          : "if(max(Count) > min(Count), (max(Sum) - min(Sum)) / (max(Count) - min(Count)), if(sum(Count) > 0, sum(Sum) / sum(Count), 0))";
    const combine = f.type === "gauge" ? "avg(v)" : "sum(v)";
    const rows = await this.ch.query<{ series: string; t: string; v: number }>(
      `WITH top AS (\n         SELECT ${group} AS series FROM ${table}\n         WHERE ${where.join(" AND ")}\n         GROUP BY series ORDER BY count() DESC LIMIT 8)\n       SELECT series, t, ${combine} AS v FROM (\n         SELECT ${group} AS series, toUnixTimestamp(toStartOfInterval(TimeUnix, toIntervalSecond({step:UInt32}))) AS t, ${source} AS src, ${value} AS v\n         FROM ${table}\n         WHERE ${where.join(" AND ")} AND series IN (SELECT series FROM top)\n         GROUP BY series, t, src)\n       GROUP BY series, t ORDER BY series, t`,
      params,
    );
    const by = new Map<string, MetricSeries>();
    for (const r of rows) {
      const s = by.get(r.series) ?? by.set(r.series, { name: r.series, points: [] }).get(r.series)!;
      s.points.push([Number(r.t) * 1000, Number(r.v)]);
    }
    return [...by.values()];
  }
}
