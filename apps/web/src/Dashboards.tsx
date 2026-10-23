import type { Dashboard, DashboardDefinition, DashboardPanel, DashboardRange, MetricSeries, PanelData, PanelFormat, PanelSource, TenantUsage, WebSummary } from "@osiris/shared";
import { DASHBOARD_RANGES } from "@osiris/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { fileSize } from "./Files.tsx";
import { LazyCodeEditor } from "./LazyCodeEditor.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { attempt, ErrorNotice, Field, Loading } from "./Scope.tsx";
import { LineChart } from "./Telemetry.tsx";
import { t } from "i18next";
import { formatDateTime, formatNumber } from "./i18n.ts";

const HOUR = 3_600_000;
const RANGE_MS: Record<DashboardRange, number> = { "1h": HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR, "90d": 90 * 24 * HOUR };
const rangeLabel = (r: DashboardRange) => t(`dashboards:ranges.${r}`);

/** Dashboards shipped with Osiris: the system's (system admins) and every tenant's. Built per render, in the current language. */
const systemBuiltins = (): Dashboard[] => [
  {
    id: "builtin:system",
    name: t("dashboards:builtin.system"),
    builtin: true,
    definition: {
      range: "24h",
      panels: [
        { title: t("dashboards:panels.tenants"), kind: "stat", width: 4, source: { type: "cluster", view: "summary" } },
        { title: t("dashboards:panels.nodeCpu"), kind: "line", source: { type: "metric", name: "k8s.node.cpu.usage", metricType: "gauge", groupBy: "k8s.node.name" } },
        { title: t("dashboards:panels.nodeMemory"), kind: "line", source: { type: "metric", name: "k8s.node.memory.working_set", metricType: "gauge", groupBy: "k8s.node.name" } },
        { title: t("dashboards:panels.latency"), kind: "line", source: { type: "metric", name: "http.server.request.duration", metricType: "histogram", groupBy: "service.name" } },
        { title: t("dashboards:panels.logErrors"), kind: "bar", source: { type: "logs", view: "by_service", severity: "error" } },
        { title: t("dashboards:panels.pods"), kind: "table", source: { type: "cluster", view: "pods" } },
        { title: t("dashboards:panels.events"), kind: "table", source: { type: "cluster", view: "events" } },
        { title: t("dashboards:panels.tenantState"), kind: "table", width: 4, source: { type: "cluster", view: "tenants" } },
      ],
    },
  },
  webBuiltin(t("dashboards:panels.allTraffic")),
  {
    id: "builtin:usage",
    name: t("dashboards:builtin.usage"),
    builtin: true,
    definition: { range: "30d", panels: [{ title: t("dashboards:panels.tenantQuotas"), kind: "table", width: 4, source: { type: "usage", view: "tenants" } }] },
  },
];

const webBuiltin = (totals: string): Dashboard => ({
  id: "builtin:web",
  name: t("dashboards:builtin.web"),
  builtin: true,
  definition: {
    range: "30d",
    panels: [
      { title: totals, kind: "stat", width: 4, source: { type: "web", view: "totals" } },
      { title: t("dashboards:panels.overTime"), kind: "line", width: 4, source: { type: "web", view: "series" } },
      { title: t("dashboards:builtin.web"), kind: "table", source: { type: "web", view: "sites" } },
      { title: t("dashboards:panels.topPages"), kind: "bar", source: { type: "web", view: "pages" } },
      { title: t("dashboards:panels.referrers"), kind: "bar", source: { type: "web", view: "referrers" } },
      { title: t("dashboards:panels.countries"), kind: "bar", source: { type: "web", view: "countries" } },
    ],
  },
});

const tenantBuiltins = (): Dashboard[] => [
  {
    id: "builtin:usage",
    name: t("dashboards:builtin.usage"),
    builtin: true,
    definition: {
      range: "30d",
      panels: [
        { title: t("dashboards:panels.quotas"), kind: "meters", source: { type: "usage", view: "quotas" } },
        { title: t("dashboards:panels.tokensByUser"), kind: "bar", source: { type: "usage", view: "users" } },
        { title: t("dashboards:panels.tokensByMonth"), kind: "bar", source: { type: "usage", view: "months" } },
        { title: t("dashboards:panels.tokensByAssistant"), kind: "bar", source: { type: "usage", view: "assistants" } },
      ],
    },
  },
  webBuiltin(t("dashboards:panels.traffic")),
];

const NEW_DEFINITION = (system: boolean): DashboardDefinition =>
  system
    ? { range: "24h", panels: [{ title: t("dashboards:panels.logErrorsShort"), kind: "bar", source: { type: "logs", view: "by_service", severity: "error" } }] }
    : { range: "30d", panels: [{ title: t("database:tables"), kind: "table", source: { type: "database", sql: "SELECT name FROM sqlite_master WHERE type = 'table'" } }] };

const SOURCES_HELP = {
  system: `metric: { "type": "metric", "name": "k8s.node.cpu.usage", "metricType": "gauge" | "sum" | "histogram", "groupBy"?: "k8s.node.name" }
logs: { "type": "logs", "view": "by_service" | "list", "severity"?: "warn" | "error" | "fatal", "namespace"?, "service"?, "q"? }
cluster: { "type": "cluster", "view": "summary" | "tenants" | "pods" | "events" }
web: { "type": "web", "view": "totals" | "series" | "sites" | "pages" | "referrers" | "countries" }
usage: { "type": "usage", "view": "tenants" }`,
  tenant: `database: { "type": "database", "sql": "SELECT stage, SUM(value) FROM deals GROUP BY stage" }
web: { "type": "web", "view": "totals" | "series" | "sites" | "pages" | "referrers" | "countries" }
usage: { "type": "usage", "view": "quotas" | "users" | "assistants" | "months" }`,
};

const compact = { format: (n: number) => formatNumber(n, { notation: "compact", maximumFractionDigits: 1 }) };
const whole = { format: (n: number) => formatNumber(n, { maximumFractionDigits: 2 }) };
/** A quota's use; `bytes` when its numbers are sizes (a row's own, as rows of one column can differ). */
type Meter = { used: number; limit: number | null; bytes?: boolean };
const isMeter = (v: unknown): v is Meter => typeof v === "object" && v !== null && "used" in v;

/** A value as text; a quota without a limit is just its use, unless `long` (the meters say "no limit"). */
function format(v: unknown, f: PanelFormat | null | undefined, long = false): string {
  if (v === null || v === undefined || v === "") return "—";
  if (isMeter(v)) {
    const one = (n: number) => (f === "meterBytes" || v.bytes ? fileSize(n) : compact.format(n));
    if (v.limit === null) return long ? `${one(v.used)} / ${t("quotas:noLimit")}` : one(v.used);
    return `${one(v.used)} / ${one(v.limit)}`;
  }
  if (typeof v === "number") {
    if (f === "bytes") return fileSize(v);
    if (f === "time") return formatDateTime(v, { dateStyle: "short", timeStyle: "short" });
    if (f === "percent") return formatNumber(v / 100, { style: "percent", maximumFractionDigits: 2 });
    return Math.abs(v) >= 10_000 ? compact.format(v) : whole.format(v);
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
const share = (m: Meter) => (m.limit === null ? 0 : m.limit > 0 ? m.used / m.limit : 1);
/** Status of a quota, as a word beside its colour (never colour alone). */
const tone = (s: number) => (s >= 1 ? { bar: "bg-error", text: "text-error", word: t("quotas:exhausted") } : s >= 0.8 ? { bar: "bg-warning", text: "text-warning", word: t("quotas:runningOut") } : null);

/** What a panel's data loading shares within one dashboard view: the range, and one web summary for all its panels. */
interface Loader {
  system: boolean;
  from: number;
  to: number;
  web: () => Promise<WebSummary>;
  usage: () => Promise<TenantUsage>;
  /** User id → name (admins: all members; members: themselves). */
  names: () => Promise<Map<string, string>>;
}

const USAGE_METERS: { key: keyof TenantUsage; bytes?: boolean }[] = [
  { key: "tokens" },
  { key: "userTokens" },
  { key: "storage", bytes: true },
  { key: "members" },
  { key: "schedules" },
  { key: "tables" },
  { key: "database", bytes: true },
  { key: "dashboards" },
];

const top = (rows: { key: string; pageviews: number; visitors: number }[], label: string): PanelData => ({
  columns: [label, t("dashboards:columns.pageviews"), t("dashboards:columns.visitors")],
  rows: rows.map((r) => [r.key || "—", r.pageviews, r.visitors]),
  formats: ["text", "number", "number"],
});

/** A panel's data as a table, from whichever API holds it. */
async function load(source: PanelSource, l: Loader): Promise<PanelData> {
  const range = { from: l.from, to: l.to };
  const d = api.dashboards(l.system);
  switch (source.type) {
    case "metric": {
      const { series } = await api.admin.telemetry.series({ ...range, name: source.name, type: source.metricType, groupBy: source.groupBy, service: source.service });
      const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
      return {
        columns: [t("dashboards:columns.time"), ...series.map((s) => s.name || t("dashboards:columns.value"))],
        rows: times.map((time) => [time, ...series.map((s) => s.points.find((p) => p[0] === time)?.[1] ?? null)]),
        formats: ["time", ...series.map(() => "number" as const)],
      };
    }
    case "logs": {
      if (source.view === "by_service") return d.logs({ ...range, severity: source.severity, namespace: source.namespace });
      const logs = await api.admin.telemetry.logs({ ...range, severity: source.severity, service: source.service, namespace: source.namespace, q: source.q, limit: 50 });
      return { columns: [t("dashboards:columns.time"), t("dashboards:columns.service"), t("dashboards:columns.level"), t("dashboards:columns.message")], rows: logs.map((x) => [x.ts, x.service, x.severity, x.body]), formats: ["time", "text", "text", "text"] };
    }
    case "cluster":
      return d.cluster(source.view, range);
    case "web": {
      const w = await l.web();
      if (source.view === "totals") return { columns: [t("dashboards:columns.pageviews"), t("dashboards:columns.visitors"), t("dashboards:columns.events")], rows: [[w.totals.pageviews, w.totals.visitors, w.totals.events]], formats: ["number", "number", "number"] };
      if (source.view === "series") return { columns: [t("dashboards:columns.time"), t("dashboards:columns.pageviews"), t("dashboards:columns.visitors")], rows: w.series.map((x) => [x.t, x.pageviews, x.visitors]), formats: ["time", "number", "number"] };
      if (source.view === "sites") {
        return l.system
          ? { columns: [t("dashboards:columns.site"), t("app:nav.tenant"), t("dashboards:columns.pageviews"), t("dashboards:columns.visitors")], rows: w.sites.map((s) => [s.site, s.tenant ?? "—", s.pageviews, s.visitors]), formats: ["text", "text", "number", "number"] }
          : { columns: [t("dashboards:columns.site"), t("dashboards:columns.pageviews"), t("dashboards:columns.visitors")], rows: w.sites.map((s) => [s.site, s.pageviews, s.visitors]), formats: ["text", "number", "number"] };
      }
      return top(w[source.view], { pages: t("dashboards:columns.page"), referrers: t("dashboards:columns.referrer"), countries: t("dashboards:columns.country") }[source.view]);
    }
    case "usage": {
      if (source.view === "tenants") return d.usage();
      if (source.view === "quotas") {
        const u = await l.usage();
        return { columns: [t("dashboards:columns.quota"), t("dashboards:columns.usage")], rows: USAGE_METERS.map((m) => [t(`dashboards:meters.${m.key}`), { ...u[m.key], bytes: m.bytes }]), formats: ["text", "meter"] };
      }
      const b = await api.usageBreakdown();
      if (source.view === "users") {
        const names = await l.names();
        return { columns: [t("dashboards:columns.user"), t("dashboards:columns.tokens")], rows: b.users.map((u) => [names.get(u.userId) ?? u.userId, u.tokens]), formats: ["text", "number"] };
      }
      if (source.view === "assistants") return { columns: [t("dashboards:columns.assistant"), t("dashboards:columns.tokens")], rows: b.assistants.map((a) => [a.name, a.tokens]), formats: ["text", "number"] };
      return { columns: [t("dashboards:columns.month"), t("dashboards:columns.tokens")], rows: b.months.map((m) => [m.month, m.tokens]), formats: ["text", "number"] };
    }
    case "database": {
      const r = await api.db.query(source.sql);
      return { columns: r.columns, rows: r.rows };
    }
  }
}

/** System > Dashboard (system admins) or Tenant > Dashboard (members see, admins edit): the built-in ones and own ones. */
export function Dashboards({ system, canEdit, me }: { system: boolean; canEdit: boolean; me: { id: string; name: string | null } }) {
  const builtins = system ? systemBuiltins() : tenantBuiltins();
  const [own, setOwn] = useState<Dashboard[]>();
  const [selected, setSelected] = useState<string | null>(builtins[0]!.id);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  const reload = () => api.dashboards(system).list().then(setOwn, (e: Error) => setError(e.message));
  useEffect(() => void reload(), [system]);
  const all = [...builtins, ...(own ?? [])];
  const open = all.find((d) => d.id === selected);

  return (
    <MasterDetail
      title={t("app:nav.dashboard")}
      loading={!own && !error}
      groups={[
        { title: t("dashboards:builtins"), items: builtins.map((d) => ({ key: d.id, label: d.name })) },
        { title: t("dashboards:own"), items: (own ?? []).map((d) => ({ key: d.id, label: d.name })), empty: canEdit ? t("noneYet") : t("guards:none") },
      ]}
      selected={selected}
      onSelect={(id) => (setEditing(false), setSelected(id))}
      add={canEdit ? { label: t("dashboards:new"), onClick: () => (setEditing(true), setSelected(null)) } : undefined}
    >
      {error ? (
        <div className="detail">
          <ErrorNotice error={error} />
        </div>
      ) : editing && (selected === null || (open && !open.builtin)) ? (
        <DashboardEditor
          key={selected ?? "new"}
          system={system}
          dashboard={open}
          onSaved={(d) => (setEditing(false), void reload().then(() => setSelected(d.id)))}
          onDeleted={() => (setEditing(false), void reload().then(() => setSelected(builtins[0]!.id)))}
          onCancel={() => (setEditing(false), selected === null && setSelected(builtins[0]!.id))}
        />
      ) : open ? (
        <DashboardView
          key={`${open.id}:${open.updatedAt}`}
          dashboard={open}
          system={system}
          me={me}
          isAdmin={canEdit}
          onEdit={canEdit && !open.builtin ? () => setEditing(true) : undefined}
          onCopy={canEdit ? () => void api.dashboards(system).create({ name: t("dashboards:copyName", { name: open.name }), definition: open.definition }).then((d) => reload().then(() => (setSelected(d.id), setEditing(true))), (e: Error) => setError(e.message)) : undefined}
        />
      ) : undefined}
    </MasterDetail>
  );
}

function DashboardView({
  dashboard,
  system,
  me,
  isAdmin,
  onEdit,
  onCopy,
}: {
  dashboard: Dashboard;
  system: boolean;
  me: { id: string; name: string | null };
  isAdmin: boolean;
  onEdit?: () => void;
  onCopy?: () => void;
}) {
  const [range, setRange] = useState<DashboardRange>(dashboard.definition.range);
  const [round, setRound] = useState(0);
  const loader = useMemo<Loader>(() => {
    const to = Date.now();
    const from = to - RANGE_MS[range];
    let web: Promise<WebSummary> | undefined;
    let usage: Promise<TenantUsage> | undefined;
    let names: Promise<Map<string, string>> | undefined;
    return {
      system,
      from,
      to,
      web: () => (web ??= api.dashboards(system).web({ from, to })),
      usage: () => (usage ??= api.usage()),
      names: () =>
        (names ??= (isAdmin ? api.members() : Promise.resolve([])).then(
          (ms) => new Map([[me.id, me.name ?? t("dashboards:me")], ...ms.map((m): [string, string] => [m.userId, m.name ?? m.email ?? m.userId])]),
          () => new Map([[me.id, me.name ?? t("dashboards:me")]]),
        )),
    };
  }, [range, round]);

  return (
    <div className="detail max-w-none space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-lg font-semibold">{dashboard.name}</h1>
        <select value={range} onChange={(e) => setRange(e.target.value as DashboardRange)} className="field w-32 text-sm" aria-label={t("dashboards:range")}>
          {DASHBOARD_RANGES.map((r) => (
            <option key={r} value={r}>
              {rangeLabel(r)}
            </option>
          ))}
        </select>
        <button onClick={() => setRound(round + 1)} className="btn-secondary text-sm">
          {t("dashboards:refresh")}
        </button>
        {onCopy && (
          <button onClick={onCopy} className="btn-secondary text-sm">
            {t("copy")}
          </button>
        )}
        {onEdit && (
          <button onClick={onEdit} className="btn-primary text-sm">
            {t("dashboards:edit")}
          </button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {dashboard.definition.panels.map((p, i) => (
          <Panel key={`${i}:${round}:${range}`} panel={p} loader={loader} />
        ))}
      </div>
      {!dashboard.definition.panels.length && <p className="text-sm text-fg-muted">{t("dashboards:noPanels")}</p>}
    </div>
  );
}

const SPAN: Record<number, string> = { 1: "md:col-span-1", 2: "md:col-span-2", 3: "md:col-span-3", 4: "md:col-span-4" };

function Panel({ panel, loader }: { panel: DashboardPanel; loader: Loader }) {
  const [data, setData] = useState<PanelData>();
  const [error, setError] = useState<string>();
  useEffect(() => void load(panel.source, loader).then(setData, (e: Error) => setError(e.message)), []);
  return (
    <section className={`relative min-h-32 rounded-md border border-line p-4 ${SPAN[panel.width ?? 2]}`}>
      <h2 className="section-header mb-2">{panel.title}</h2>
      <Loading show={!data && !error} />
      {error ? <p className="text-sm text-fg-muted">{error}</p> : data && <PanelBody kind={panel.kind} data={data} />}
    </section>
  );
}

function PanelBody({ kind, data }: { kind: DashboardPanel["kind"]; data: PanelData }) {
  const f = (i: number) => data.formats?.[i];
  if (!data.rows.length) return <p className="text-sm text-fg-muted">{t("dashboards:noData")}</p>;

  if (kind === "stat") {
    const row = data.rows[0]!;
    return (
      <div className="flex flex-wrap gap-3">
        {data.columns.map((c, i) => (
          <div key={c} className="min-w-36 flex-1 rounded-md bg-sidebar px-4 py-3">
            <p className="text-xs text-fg-secondary">{c}</p>
            <p className="mt-1 text-2xl font-semibold">{format(row[i], f(i))}</p>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "line" && typeof data.rows[0]![0] === "number") {
    const series: MetricSeries[] = data.columns.slice(1).map((name, j) => ({
      name,
      points: data.rows.flatMap((r) => (typeof r[j + 1] === "number" ? [[r[0] as number, r[j + 1] as number] as [number, number]] : [])),
    }));
    return <LineChart series={series} unit="" />;
  }

  if (kind === "bar" || kind === "line") {
    const values = data.rows.map((r) => Number(r[1]) || 0);
    const max = Math.max(1, ...values);
    return (
      <table className="w-full text-sm">
        <tbody>
          {data.rows.slice(0, 20).map((r, i) => (
            <tr key={i} className="border-t border-line first:border-t-0" title={data.columns.map((c, j) => `${c}: ${format(r[j], f(j))}`).join("\n")}>
              <td className="relative max-w-0 py-1 pe-2">
                <span className="absolute inset-y-0.5 start-0 rounded-sm bg-primary-soft" style={{ width: `${(values[i]! / max) * 100}%` }} aria-hidden="true" />
                <span className="relative block truncate px-1">{format(r[0], f(0))}</span>
              </td>
              {r.slice(1, 3).map((v, j) => (
                <td key={j} className="w-24 py-1 text-end font-mono text-xs">
                  {format(v, f(j + 1))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (kind === "meters") {
    return (
      <div className="space-y-3">
        {data.rows.map((r, i) => {
          const m = r[1];
          if (!isMeter(m)) return null;
          const s = share(m);
          const state = tone(s);
          return (
            <div key={i}>
              <div className="flex justify-between gap-3 text-sm">
                <span>{String(r[0])}</span>
                <span className={`font-mono text-xs ${state?.text ?? "text-fg-secondary"}`}>
                  {format(m, f(1), true)}
                  {state && ` · ${state.word}`}
                </span>
              </div>
              {m.limit !== null && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover" role="meter" aria-label={String(r[0])} aria-valuemin={0} aria-valuemax={m.limit} aria-valuenow={m.used}>
                  <div className={`h-full rounded-full ${state?.bar ?? "bg-primary"}`} style={{ width: `${Math.min(1, s) * 100}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="max-h-96 overflow-auto">
      <table className="w-full text-start text-sm">
        <thead className="sticky top-0 bg-canvas text-xs text-fg-secondary">
          <tr>
            {data.columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap py-1 pe-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((v, j) => {
                const state = isMeter(v) ? tone(share(v)) : null;
                return (
                  <td key={j} className={`max-w-xs truncate py-1 pe-3 ${typeof v === "number" || isMeter(v) ? "font-mono text-xs" : ""} ${state?.text ?? ""}`} title={format(v, f(j))}>
                    {format(v, f(j))}
                    {state && ` · ${state.word}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An own dashboard's name and its definition as JSON (the panels and their sources), with what sources there are. */
function DashboardEditor({
  system,
  dashboard,
  onSaved,
  onDeleted,
  onCancel,
}: {
  system: boolean;
  dashboard?: Dashboard;
  onSaved: (d: Dashboard) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(dashboard?.name ?? "");
  const [json, setJson] = useState(() => JSON.stringify(dashboard?.definition ?? NEW_DEFINITION(system), null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const d = api.dashboards(system);
  const save = () =>
    attempt(setBusy, setError, async () => {
      let definition: DashboardDefinition;
      try {
        definition = JSON.parse(json) as DashboardDefinition;
      } catch (e) {
        throw new Error(t("dashboards:invalidJson", { detail: (e as Error).message }));
      }
      onSaved(dashboard ? await d.update(dashboard.id, { name, definition }) : await d.create({ name, definition }));
    });
  const remove = () => dashboard && window.confirm(t("dashboards:confirmDelete", { name: dashboard.name })) && void attempt(setBusy, setError, async () => (await d.remove(dashboard.id), onDeleted()));

  return (
    <div className="detail max-w-4xl space-y-4">
      <h1 className="text-lg font-semibold">{dashboard ? t("dashboards:editTitle") : t("dashboards:new")}</h1>
      <Field label={t("name")}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="field w-full max-w-sm" />
      </Field>
      <div className="space-y-1">
        <span className="section-header block">{t("dashboards:definition")}</span>
        <p className="text-xs text-fg-muted">
          {t("dashboards:definitionHelp", { ranges: DASHBOARD_RANGES.join(", ") })}
        </p>
        <pre className="overflow-x-auto rounded-md bg-sidebar p-2 text-xs text-fg-secondary">{SOURCES_HELP[system ? "system" : "tenant"]}</pre>
        <LazyCodeEditor path="dashboard.json" value={json} onChange={setJson} height="45vh" />
      </div>
      <ErrorNotice error={error} />
      <div className="flex gap-3">
        <button disabled={busy || !name.trim()} onClick={() => void save()} className="btn-primary">
          {t("save")}
        </button>
        <button onClick={onCancel} className="btn-secondary">
          {t("cancel")}
        </button>
        {dashboard && (
          <button disabled={busy} onClick={remove} className="btn-danger ms-auto">
            {t("delete")}
          </button>
        )}
      </div>
    </div>
  );
}
