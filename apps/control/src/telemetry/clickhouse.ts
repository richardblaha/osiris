import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary, WebStats, WebSummary, WebTopRow } from "@osiris/shared";

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
const METRIC_TABLES = { gauge: "otel_metrics_gauge", sum: "otel_metrics_sum", histogram: "otel_metrics_histogram" } as const;
export type MetricType = keyof typeof METRIC_TABLES;

/** The cluster's telemetry as the OpenTelemetry Collector's ClickHouse exporter writes it (database otel). */
export class Telemetry {
  /** The web analytics (database web), over the same connection. */
  readonly web: WebAnalytics;

  constructor(readonly ch: ClickHouse) {
    this.web = new WebAnalytics(ch);
  }

  /** Services and namespaces seen in the range, for the filters. */
  async facets(r: Range): Promise<TelemetryFacets> {
    const p = range(r);
    const [services, namespaces] = await Promise.all([
      this.ch.query<{ s: string }>(
        `SELECT DISTINCT ServiceName AS s FROM (
           SELECT ServiceName FROM otel_logs WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)
           UNION ALL SELECT ServiceName FROM otel_traces WHERE Timestamp BETWEEN toDateTime({from:UInt32}) AND toDateTime({to:UInt32}))
         WHERE s <> '' ORDER BY s LIMIT 500`,
        p,
      ),
      this.ch.query<{ s: string }>(
        `SELECT DISTINCT ${NS} AS s FROM otel_logs WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9) AND s <> '' ORDER BY s LIMIT 500`,
        p,
      ),
    ]);
    return { services: services.map((x) => x.s), namespaces: namespaces.map((x) => x.s) };
  }

  /** The newest log records matching the filters (`before`: older than that, for the next page). */
  async logs(f: Range & { service?: string; namespace?: string; severity?: string; q?: string; traceId?: string; limit: number }): Promise<LogRecord[]> {
    const where = ["Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)", "Timestamp <= fromUnixTimestamp64Milli({toMs:Int64})"];
    const params: Record<string, string | number> = { ...range(f), toMs: f.to, limit: f.limit };
    if (f.service) (where.push("ServiceName = {service:String}"), (params.service = f.service));
    if (f.namespace) (where.push(`${NS} = {namespace:String}`), (params.namespace = f.namespace));
    if (f.severity) (where.push("SeverityNumber >= {severity:UInt8}"), (params.severity = SEVERITY[f.severity] ?? 0));
    if (f.q) (where.push("positionCaseInsensitiveUTF8(Body, {q:String}) > 0"), (params.q = f.q));
    if (f.traceId) (where.push("TraceId = {traceId:String}"), (params.traceId = f.traceId));
    const rows = await this.ch.query<Omit<LogRecord, "ts"> & { ts: string }>(
      `SELECT toUnixTimestamp64Milli(Timestamp) AS ts, SeverityText AS severity, SeverityNumber AS severityNumber, ServiceName AS service,
              ${NS} AS namespace, ResourceAttributes['k8s.pod.name'] AS pod, Body AS body, TraceId AS traceId, SpanId AS spanId,
              LogAttributes AS attributes, ResourceAttributes AS resource
       FROM otel_logs WHERE ${where.join(" AND ")} ORDER BY Timestamp DESC LIMIT {limit:UInt32}`,
      params,
    );
    return rows.map((r) => ({ ...r, ts: Number(r.ts), severityNumber: Number(r.severityNumber) }));
  }

  /** Log records at or above a severity per service (Dashboard). */
  async logCounts(f: Range & { severity?: string; namespace?: string }): Promise<{ service: string; count: number }[]> {
    const rows = await this.ch.query<{ service: string; count: string }>(
      `SELECT if(ServiceName = '', '(bez služby)', ServiceName) AS service, count() AS count FROM otel_logs
       WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9) AND SeverityNumber >= {severity:UInt8}
         AND ({namespace:String} = '' OR ${NS} = {namespace:String})
       GROUP BY service ORDER BY count DESC LIMIT 20`,
      { ...range(f), severity: SEVERITY[f.severity ?? "error"] ?? 0, namespace: f.namespace ?? "" },
    );
    return rows.map((r) => ({ service: r.service, count: Number(r.count) }));
  }

  /**
   * Pods that aren't well now (Dashboard): their latest phase (k8s_cluster's k8s.pod.phase: 1 pending, 2 running,
   * 3 succeeded, 4 failed, 5 unknown) in the last 15 minutes isn't running or done, or their containers restarted in the range.
   */
  async podProblems(r: Range): Promise<{ namespace: string; pod: string; phase: number | null; restarts: number }[]> {
    const pod = `ResourceAttributes['k8s.pod.name']`;
    const [phases, restarts] = await Promise.all([
      this.ch.query<{ namespace: string; pod: string; phase: number }>(
        `SELECT ${NS} AS namespace, ${pod} AS pod, argMax(Value, TimeUnix) AS phase FROM otel_metrics_gauge
         WHERE MetricName = 'k8s.pod.phase' AND TimeUnix >= now() - INTERVAL 15 MINUTE GROUP BY namespace, pod HAVING phase NOT IN (2, 3)`,
      ),
      this.ch.query<{ namespace: string; pod: string; restarts: number }>(
        `SELECT ${NS} AS namespace, ${pod} AS pod, sum(d) AS restarts FROM (
           SELECT ${NS}, ${pod}, ResourceAttributes['k8s.container.name'], max(Value) - min(Value) AS d FROM otel_metrics_gauge
           WHERE MetricName = 'k8s.container.restarts' AND TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)
           GROUP BY 1, 2, 3)
         GROUP BY namespace, pod HAVING restarts > 0`,
        range(r),
      ),
    ]);
    const by = new Map<string, { namespace: string; pod: string; phase: number | null; restarts: number }>();
    for (const p of phases) by.set(`${p.namespace}/${p.pod}`, { namespace: p.namespace, pod: p.pod, phase: Number(p.phase), restarts: 0 });
    for (const x of restarts) {
      const key = `${x.namespace}/${x.pod}`;
      by.set(key, { ...(by.get(key) ?? { namespace: x.namespace, pod: x.pod, phase: null }), restarts: Number(x.restarts) });
    }
    return [...by.values()].sort((a, b) => b.restarts - a.restarts || a.pod.localeCompare(b.pod)).slice(0, 50);
  }

  /** Kubernetes events of type Warning (k8sobjects, watch mode: the body is {type, object}), newest first. */
  async warningEvents(r: Range): Promise<{ ts: number; namespace: string; object: string; reason: string; note: string; count: number }[]> {
    const rows = await this.ch.query<{ ts: string; namespace: string; object: string; reason: string; note: string; count: string }>(
      `SELECT toUnixTimestamp64Milli(max(Timestamp)) AS ts, JSONExtractString(Body, 'object', 'regarding', 'namespace') AS namespace,
              concat(JSONExtractString(Body, 'object', 'regarding', 'kind'), '/', JSONExtractString(Body, 'object', 'regarding', 'name')) AS object,
              JSONExtractString(Body, 'object', 'reason') AS reason, any(JSONExtractString(Body, 'object', 'note')) AS note, count() AS count
       FROM otel_logs
       WHERE Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9) AND ServiceName = ''
         AND JSONExtractString(Body, 'object', 'type') = 'Warning'
       GROUP BY namespace, object, reason ORDER BY ts DESC LIMIT 50`,
      range(r),
    );
    return rows.map((x) => ({ ...x, ts: Number(x.ts), count: Number(x.count) }));
  }

  /** Root spans (one per trace) matching the filters, newest first, with how many spans their trace has. */
  async traces(f: Range & { service?: string; q?: string; minMs?: number; errors?: boolean; limit: number }): Promise<TraceSummary[]> {
    const where = ["Timestamp BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)", "ParentSpanId = ''"];
    const params: Record<string, string | number> = { ...range(f), limit: f.limit };
    if (f.service) (where.push("ServiceName = {service:String}"), (params.service = f.service));
    if (f.q) (where.push("positionCaseInsensitiveUTF8(SpanName, {q:String}) > 0"), (params.q = f.q));
    if (f.minMs) (where.push("Duration >= {minNs:UInt64}"), (params.minNs = Math.round(f.minMs * 1e6)));
    if (f.errors) where.push("StatusCode = 'Error'");
    const rows = await this.ch.query<{ ts: string; traceId: string; service: string; name: string; durationNs: string; status: string; spans: string }>(
      `SELECT toUnixTimestamp64Milli(r.Timestamp) AS ts, r.TraceId AS traceId, r.ServiceName AS service, r.SpanName AS name,
              r.Duration AS durationNs, r.StatusCode AS status,
              (SELECT count() FROM otel_traces t WHERE t.TraceId = r.TraceId) AS spans
       FROM (SELECT * FROM otel_traces WHERE ${where.join(" AND ")} ORDER BY Timestamp DESC LIMIT {limit:UInt32}) AS r
       ORDER BY r.Timestamp DESC`,
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
      `SELECT toUnixTimestamp64Nano(Timestamp) AS ts, SpanId AS spanId, ParentSpanId AS parentSpanId, ServiceName AS service, SpanName AS name,
              SpanKind AS kind, Duration AS durationNs, StatusCode AS status, StatusMessage AS statusMessage, SpanAttributes AS attributes,
              ResourceAttributes AS resource
       FROM otel_traces WHERE TraceId = {traceId:String} ORDER BY Timestamp LIMIT 2000`,
      { traceId },
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
    const params: Record<string, string | number> = { ...range(r), q: q ?? "" };
    const parts = Object.entries(METRIC_TABLES).map(
      ([type, table]) =>
        `SELECT MetricName AS name, '${type}' AS type, any(MetricUnit) AS unit, any(MetricDescription) AS description, uniqExact(ServiceName) AS services
         FROM ${table} WHERE TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)
           AND positionCaseInsensitiveUTF8(MetricName, {q:String}) > 0 GROUP BY MetricName`,
    );
    const rows = await this.ch.query<MetricInfo & { services: string }>(`${parts.join(" UNION ALL ")} ORDER BY name LIMIT 1000`, params);
    return rows.map(({ services: _, ...m }) => m);
  }

  /**
   * One metric over time in `step`-second buckets, a series per value of `groupBy` (an attribute or resource
   * attribute; the 8 with most points). Gauges average; monotonic sums give their rate per second; histograms the
   * mean of what they measured in each bucket.
   */
  async series(f: Range & { name: string; type: MetricType; groupBy?: string; service?: string; step: number }): Promise<MetricSeries[]> {
    const table = METRIC_TABLES[f.type];
    const params: Record<string, string | number> = { ...range(f), name: f.name, step: f.step, g: f.groupBy ?? "", service: f.service ?? "" };
    const group = "if({g:String} = '', '', if(mapContains(Attributes, {g:String}), Attributes[{g:String}], ResourceAttributes[{g:String}]))";
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
      `WITH top AS (
         SELECT ${group} AS series FROM ${table}
         WHERE MetricName = {name:String} AND TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)
           AND ({service:String} = '' OR ServiceName = {service:String})
         GROUP BY series ORDER BY count() DESC LIMIT 8)
       SELECT series, t, ${combine} AS v FROM (
         SELECT ${group} AS series, toUnixTimestamp(toStartOfInterval(TimeUnix, toIntervalSecond({step:UInt32}))) AS t, ${source} AS src, ${value} AS v
         FROM ${table}
         WHERE MetricName = {name:String} AND TimeUnix BETWEEN toDateTime64({from:UInt32}, 9) AND toDateTime64({to:UInt32}, 9)
           AND ({service:String} = '' OR ServiceName = {service:String}) AND series IN (SELECT series FROM top)
         GROUP BY series, t, src)
       GROUP BY series, t ORDER BY series, t`,
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

/** Lowest SeverityNumber of each level (OpenTelemetry log data model). */
const SEVERITY: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

/** A breakdown of the web analytics: an aggregate table of database web, what its key is, and its own filter. */
const BREAKDOWNS: Record<Exclude<keyof WebStats, "sites" | "totals" | "step" | "series">, { table: string; key: string; detail?: string; where?: string; count?: string }> = {
  pages: { table: "pages_daily", key: "path" },
  referrers: { table: "referrers_daily", key: "referrer_domain", detail: "referrer_source", where: "referrer_domain != ''" },
  campaigns: { table: "campaigns_daily", key: "utm_campaign", detail: "concat(utm_source, ' / ', utm_medium)" },
  countries: { table: "countries_daily", key: "country" },
  regions: { table: "locations_daily", key: "region", detail: "country", where: "region != ''" },
  cities: { table: "locations_daily", key: "city", detail: "concat(region, ', ', country)", where: "city != ''" },
  networks: { table: "networks_daily", key: "network", detail: "asn", where: "network != ''" },
  browsers: { table: "devices_daily", key: "browser" },
  systems: { table: "devices_daily", key: "os" },
  devices: { table: "devices_daily", key: "device" },
  events: { table: "events_daily", key: "event", count: "count" },
};

/**
 * Web analytics of several sites together (null: all of them): each site's totals, the sum over time, and the top
 * pages (with their site), referrers and countries.
 */
export async function webSummary(ch: ClickHouse, sites: string[] | null, r: Range, owner: (site: string) => string | null = () => null): Promise<WebSummary> {
  // An Array(String) parameter goes in as ClickHouse's literal.
  const list = `[${(sites ?? []).map((x) => `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}]`;
  const p = { sites: list, all: sites === null ? 1 : 0, ...range(r) };
  const these = "({all:UInt8} = 1 OR has({sites:Array(String)}, site))";
  const days = "day BETWEEN toDate(toDateTime({from:UInt32}, 'UTC')) AND toDate(toDateTime({to:UInt32}, 'UTC'))";
  const hourly = r.to - r.from <= 2 * 86_400_000;
  const n = (v: unknown) => Number(v ?? 0);
  const top = (table: string, key: string, where = "") =>
    ch.query<{ key: string; detail: string; pageviews: string; visitors: string }>(
      `SELECT ${key} AS key, '' AS detail, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors
       FROM web.${table} WHERE ${these} AND ${days}${where} GROUP BY key ORDER BY pageviews DESC LIMIT 15`,
      p,
    );
  const [perSite, totals, series, pages, referrers, countries] = await Promise.all([
    ch.query<{ site: string; pageviews: string; visitors: string }>(
      `SELECT site, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors FROM web.stats_daily WHERE ${these} AND ${days} GROUP BY site ORDER BY pageviews DESC`,
      p,
    ),
    ch.query<{ pageviews: string; visitors: string; events: string }>(
      `SELECT sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors, sum(events) AS events FROM web.stats_daily WHERE ${these} AND ${days}`,
      p,
    ),
    hourly
      ? ch.query<{ t: string; pageviews: string; visitors: string }>(
          `SELECT toUnixTimestamp(hour) * 1000 AS t, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors FROM web.stats_hourly
           WHERE ${these} AND hour BETWEEN toStartOfHour(toDateTime({from:UInt32}, 'UTC')) AND toDateTime({to:UInt32}, 'UTC') GROUP BY hour ORDER BY hour`,
          p,
        )
      : ch.query<{ t: string; pageviews: string; visitors: string }>(
          `SELECT toUnixTimestamp(toDateTime(day, 'UTC')) * 1000 AS t, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors FROM web.stats_daily
           WHERE ${these} AND ${days} GROUP BY day ORDER BY day`,
          p,
        ),
    top("pages_daily", "concat(site, path)"),
    top("referrers_daily", "referrer_domain", " AND referrer_domain != ''"),
    top("countries_daily", "country"),
  ]);
  const row = (x: { key: string; detail: string; pageviews: string; visitors: string }): WebTopRow => ({ key: x.key, detail: x.detail, pageviews: n(x.pageviews), visitors: n(x.visitors) });
  const t = totals[0];
  return {
    sites: perSite.map((x) => ({ site: x.site, tenant: owner(x.site), pageviews: n(x.pageviews), visitors: n(x.visitors) })),
    totals: { pageviews: n(t?.pageviews), visitors: n(t?.visitors), events: n(t?.events) },
    step: hourly ? "hour" : "day",
    series: series.map((x) => ({ t: n(x.t), pageviews: n(x.pageviews), visitors: n(x.visitors) })),
    pages: pages.map(row),
    referrers: referrers.map(row),
    countries: countries.map(row),
  };
}

/**
 * Web analytics of one site, from the aggregate tables web/schema.sql keeps (database web): totals, pageviews and
 * visitors over time, and the top pages, referrers, campaigns, countries, browsers, systems, devices and events.
 * Visitors are a keyed hash that changes daily, so over several days a visitor counts once per day.
 */
export class WebAnalytics {
  constructor(private readonly ch: ClickHouse) {}

  /** One site's stats; `allowed` limits which sites there are to choose from (a tenant's own). */
  async stats(site: string | undefined, r: Range, allowed?: string[]): Promise<WebStats> {
    const known = (await this.ch.query<{ site: string }>("SELECT DISTINCT site FROM web.stats_daily ORDER BY site")).map((x) => x.site);
    const sites = allowed ? known.filter((s) => allowed.includes(s)) : known;
    const chosen = site && sites.includes(site) ? site : (sites[0] ?? "");
    const p = { site: chosen, ...range(r) };
    const hourly = r.to - r.from <= 2 * 86_400_000;
    const days = "day BETWEEN toDate(toDateTime({from:UInt32}, 'UTC')) AND toDate(toDateTime({to:UInt32}, 'UTC'))";
    const n = (v: unknown) => Number(v ?? 0);
    const [totals, series, ...tops] = await Promise.all([
      this.ch.query<{ pageviews: string; visitors: string; events: string }>(
        `SELECT sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors, sum(events) AS events FROM web.stats_daily WHERE site = {site:String} AND ${days}`,
        p,
      ),
      hourly
        ? this.ch.query<{ t: string; pageviews: string; visitors: string }>(
            `SELECT toUnixTimestamp(hour) * 1000 AS t, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors FROM web.stats_hourly
             WHERE site = {site:String} AND hour BETWEEN toStartOfHour(toDateTime({from:UInt32}, 'UTC')) AND toDateTime({to:UInt32}, 'UTC') GROUP BY hour ORDER BY hour`,
            p,
          )
        : this.ch.query<{ t: string; pageviews: string; visitors: string }>(
            `SELECT toUnixTimestamp(toDateTime(day, 'UTC')) * 1000 AS t, sum(pageviews) AS pageviews, uniqMerge(visitors) AS visitors FROM web.stats_daily
             WHERE site = {site:String} AND ${days} GROUP BY day ORDER BY day`,
            p,
          ),
      ...Object.values(BREAKDOWNS).map((b) =>
        this.ch.query<{ key: string; detail: string; pageviews: string; visitors: string }>(
          `SELECT ${b.key} AS key, ${b.detail ?? "''"} AS detail, sum(${b.count ?? "pageviews"}) AS pageviews, uniqMerge(visitors) AS visitors
           FROM web.${b.table} WHERE site = {site:String} AND ${days}${b.where ? ` AND ${b.where}` : ""}
           GROUP BY key, detail ORDER BY pageviews DESC LIMIT 20`,
          p,
        ),
      ),
    ]);
    const row = (x: { key: string; detail: string; pageviews: string; visitors: string }): WebTopRow => ({ key: x.key, detail: x.detail, pageviews: n(x.pageviews), visitors: n(x.visitors) });
    const t = totals[0];
    return {
      sites,
      totals: { pageviews: n(t?.pageviews), visitors: n(t?.visitors), events: n(t?.events) },
      step: hourly ? "hour" : "day",
      series: series.map((x) => ({ t: n(x.t), pageviews: n(x.pageviews), visitors: n(x.visitors) })),
      ...(Object.fromEntries(Object.keys(BREAKDOWNS).map((k, i) => [k, tops[i]!.map(row)])) as Pick<WebStats, keyof typeof BREAKDOWNS>),
    };
  }
}
