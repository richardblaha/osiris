import type { LogRecord, MetricInfo, MetricSeries, TraceSummary } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type Dashboard as DashboardData, type DashboardPanel, type DashboardSummary } from "./api.ts";
import { LineChart } from "./Chart.tsx";
import { formatDateTime } from "./i18n.ts";
import { duration, LogBars, SEVERITY_CLASS, usePopupClose, type BarPick, type Buckets } from "./Telemetry.tsx";
import { ErrorNotice, Loading } from "./ui.tsx";

type Kind = DashboardPanel["kind"];
const KINDS: Kind[] = ["logBars", "logs", "metric", "traces"];
const RANGES = [
  { key: "m15", ms: 15 * 60_000 },
  { key: "h1", ms: 3_600_000 },
  { key: "h6", ms: 6 * 3_600_000 },
  { key: "h24", ms: 24 * 3_600_000 },
  { key: "d7", ms: 7 * 24 * 3_600_000 },
] as const;
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
/** The filter values a panel's query takes (the scope and the page's own), without the panel's own settings. */
const SCOPE_KEYS = ["service", "namespace", "pod", "node", "container", "claim"] as const;
const pick = (f: Record<string, string>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]!]));

/**
 * "Add to the overview": puts what a page shows (its filter, as a panel of one of `kinds`) on a dashboard — an
 * existing one or a new one named here.
 */
export function AddToDashboard({ kinds, title, filter, range }: { kinds: Kind[]; title: string; filter: Record<string, string>; range: number }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<DashboardSummary[]>();
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>(kinds[0]!);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  usePopupClose(open, box, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    setDone(undefined);
    void api.dashboards().then((l) => (setList(l), setTarget((cur) => cur || l[0]?.id || "")), (e: Error) => setError(e.message));
  }, [open]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const panel: DashboardPanel = { id: newId(), kind, title, width: kind === "logs" || kind === "traces" ? 2 : kind === "logBars" ? 4 : 2, filter };
      if (target) {
        const d = await api.dashboard(target);
        await api.saveDashboard({ ...d, panels: [...d.panels, panel] });
        setDone(d.name);
      } else {
        if (!name.trim()) return;
        await api.saveDashboard({ id: newId(), name: name.trim(), range, panels: [panel] });
        setDone(name.trim());
      }
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div ref={box} className="relative self-end">
      <button type="button" onClick={() => setOpen(!open)} data-active={open} className="btn-secondary py-1 text-sm" aria-expanded={open}>
        + {t("dashboard:addShort")}
      </button>
      {open && (
        <form onSubmit={(e) => void add(e)} className="menu-popup end-0 w-80 space-y-2 p-3" role="dialog" aria-label={t("dashboard:add")}>
          <p className="section-header">{t("dashboard:add")}</p>
          {kinds.length > 1 && (
            <label className="flex flex-col text-xs text-fg-secondary">
              {t("dashboard:kindLabel")}
              <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="field py-1 text-sm">
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {t(`dashboard:kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col text-xs text-fg-secondary">
            {t("dashboard:to")}
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="field py-1 text-sm">
              {list?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              <option value="">{t("dashboard:newOne")}</option>
            </select>
          </label>
          {!target && <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("dashboard:name")} aria-label={t("dashboard:name")} className="field py-1 text-sm" autoFocus />}
          <button className="btn-primary w-full py-1 text-sm" disabled={!target && !name.trim()}>
            {t("dashboard:addButton")}
          </button>
          {done && <p className="text-xs text-success">{t("dashboard:added", { name: done })}</p>}
          {error && <p className="text-xs text-error">{error}</p>}
        </form>
      )}
    </div>
  );
}

/**
 * Picks a dashboard when there are several: a menu under the Overview tab (the choice is required), plus a new one.
 */
export function DashboardMenu({ list, onPick, onClose }: { list: DashboardSummary[]; onPick: (id?: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  usePopupClose(true, box, onClose);
  return (
    <div ref={box} className="menu-popup start-1/2 w-64 -translate-x-1/2" role="menu" aria-label={t("dashboard:choose")}>
      <p className="section-header px-3 py-1">{t("dashboard:choose")}</p>
      {list.map((d) => (
        <button key={d.id} role="menuitem" type="button" className="list-row block w-full truncate px-3 py-1.5 text-start text-sm" onClick={() => onPick(d.id)}>
          {d.name}
        </button>
      ))}
      <button role="menuitem" type="button" className="list-row block w-full border-t border-line px-3 py-1.5 text-start text-sm text-primary" onClick={() => onPick(undefined)}>
        + {t("dashboard:newOne")}
      </button>
    </div>
  );
}

/**
 * A dashboard: its panels over the telemetry (log bar charts, log lists, metrics, traces) in a grid of four columns,
 * all over one time range. In edit mode the name, each panel's title, kind, width, filter and place change, panels come
 * and go, and the dashboard can be deleted; every change saves. Without `id` it starts a new one.
 */
export function Dashboard({
  id,
  list,
  onSwitch,
  onListChanged,
  onOpenLogs,
  onOpenTrace,
}: {
  id?: string;
  list: DashboardSummary[];
  onSwitch: (id?: string) => void;
  onListChanged: (selected?: string) => void;
  onOpenLogs: (filter: Record<string, string>) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const [data, setData] = useState<DashboardData>();
  const [editing, setEditing] = useState(!id);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string>();
  const [newName, setNewName] = useState("");

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    setEditing(!id);
    if (id) void api.dashboard(id).then(setData, (e: Error) => setError(e.message));
  }, [id]);

  /** Saves a changed dashboard (and shows it at once). */
  const save = async (next: DashboardData) => {
    setData(next);
    try {
      const saved = await api.saveDashboard(next);
      setData((cur) => (cur?.id === saved.id ? { ...cur, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy } : cur));
      if (next.name !== list.find((d) => d.id === next.id)?.name) onListChanged(next.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const d = await api.saveDashboard({ id: newId(), name: newName.trim(), range: 3_600_000, panels: [] });
      onListChanged(d.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!data || !confirm(t("dashboard:confirmDelete", { name: data.name }))) return;
    try {
      await api.deleteDashboard(data.id);
      onListChanged(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const panel = (pid: string, change: (p: DashboardPanel) => DashboardPanel | null) =>
    data && void save({ ...data, panels: data.panels.flatMap((p) => (p.id === pid ? [change(p)].filter((x): x is DashboardPanel => !!x) : [p])) });
  const move = (pid: string, by: number) => {
    if (!data) return;
    const i = data.panels.findIndex((p) => p.id === pid);
    const j = i + by;
    if (j < 0 || j >= data.panels.length) return;
    const panels = [...data.panels];
    [panels[i], panels[j]] = [panels[j]!, panels[i]!];
    void save({ ...data, panels });
  };

  if (!id)
    return (
      <div className="grid h-full place-items-center p-6">
        <form onSubmit={(e) => void create(e)} className="w-80 space-y-3">
          <h2 className="font-semibold">{list.length ? t("dashboard:newOne") : t("dashboard:empty")}</h2>
          <p className="text-sm text-fg-secondary">{t("dashboard:emptyHint")}</p>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder={t("dashboard:name")} aria-label={t("dashboard:name")} className="field" autoFocus />
          <button className="btn-primary w-full" disabled={!newName.trim()}>
            {t("dashboard:create")}
          </button>
          <ErrorNotice error={error} />
        </form>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3 text-sm">
        {editing && data ? (
          <input value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} onBlur={() => data.name.trim() && void save({ ...data, name: data.name.trim() })} maxLength={80} aria-label={t("dashboard:name")} className="field w-56 py-1 font-semibold" />
        ) : (
          <select value={id} onChange={(e) => onSwitch(e.target.value)} className="field w-auto max-w-64 py-1 font-semibold" aria-label={t("dashboard:choose")}>
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label={t("telemetry:range")}>
          {RANGES.map((r) => (
            <button key={r.ms} type="button" onClick={() => data && void save({ ...data, range: r.ms })} data-active={data?.range === r.ms} className="list-row border-e border-line px-2 py-1 last:border-e-0">
              {t(`telemetry:ranges.${r.key}`)}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {data && <span className="text-xs text-fg-muted">{t("dashboard:updated", { who: data.updatedBy, when: formatDateTime(data.updatedAt) })}</span>}
        <button type="button" className="btn-secondary py-1 text-sm" onClick={() => setTick((n) => n + 1)}>
          {t("telemetry:refresh")}
        </button>
        {editing && data && (
          <>
            <button type="button" className="btn-secondary py-1 text-sm" onClick={() => void save({ ...data, panels: [...data.panels, { id: newId(), kind: "logBars", title: t("dashboard:kind.logBars"), width: 4, filter: {} }] })}>
              + {t("dashboard:panel")}
            </button>
            <button type="button" className="btn-danger py-1 text-sm" onClick={() => void remove()}>
              {t("dashboard:delete")}
            </button>
          </>
        )}
        <button type="button" className={editing ? "btn-primary py-1 text-sm" : "btn-secondary py-1 text-sm"} onClick={() => setEditing(!editing)}>
          {editing ? t("dashboard:done") : t("dashboard:edit")}
        </button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto p-4">
        <Loading show={!data && !error} />
        <ErrorNotice error={error} />
        {data && data.panels.length === 0 && <p className="py-8 text-center text-sm text-fg-muted">{t("dashboard:noPanels")}</p>}
        {data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            {data.panels.map((p, i) => (
              <PanelCard key={p.id} panel={p} range={data.range} tick={tick} editing={editing} first={i === 0} last={i === data.panels.length - 1} onChange={(change) => panel(p.id, change)} onMove={(by) => move(p.id, by)} onOpenLogs={onOpenLogs} onOpenTrace={onOpenTrace} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One panel: its title (and in edit mode its controls and settings) over what it shows. */
function PanelCard({
  panel,
  range,
  tick,
  editing,
  first,
  last,
  onChange,
  onMove,
  onOpenLogs,
  onOpenTrace,
}: {
  panel: DashboardPanel;
  range: number;
  tick: number;
  editing: boolean;
  first: boolean;
  last: boolean;
  onChange: (change: (p: DashboardPanel) => DashboardPanel | null) => void;
  onMove: (by: number) => void;
  onOpenLogs: (filter: Record<string, string>) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const [settings, setSettings] = useState(false);
  const span = ["md:col-span-1", "md:col-span-2", "md:col-span-3", "md:col-span-4"][Math.min(4, Math.max(1, panel.width)) - 1];
  return (
    <section className={`flex min-h-56 flex-col rounded-md border border-line bg-sidebar ${span}`} aria-label={panel.title}>
      <header className="flex items-center gap-1 border-b border-line px-3 py-1.5">
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={panel.title}>
          {panel.title || t(`dashboard:kind.${panel.kind}`)}
        </h3>
        {editing && (
          <span className="flex items-center gap-0.5 text-xs">
            <IconButton label={t("dashboard:moveBack")} disabled={first} onClick={() => onMove(-1)}>
              ←
            </IconButton>
            <IconButton label={t("dashboard:moveOn")} disabled={last} onClick={() => onMove(1)}>
              →
            </IconButton>
            <IconButton label={t("dashboard:narrower")} disabled={panel.width <= 1} onClick={() => onChange((p) => ({ ...p, width: p.width - 1 }))}>
              −
            </IconButton>
            <IconButton label={t("dashboard:wider")} disabled={panel.width >= 4} onClick={() => onChange((p) => ({ ...p, width: p.width + 1 }))}>
              +
            </IconButton>
            <IconButton label={t("dashboard:settings")} onClick={() => setSettings(!settings)}>
              ⚙
            </IconButton>
            <IconButton label={t("dashboard:removePanel")} onClick={() => onChange(() => null)}>
              ×
            </IconButton>
          </span>
        )}
      </header>
      {editing && settings && <PanelSettings panel={panel} onSave={(p) => (onChange(() => p), setSettings(false))} />}
      <div className="relative min-h-0 flex-1">
        <PanelBody panel={panel} range={range} tick={tick} onOpenLogs={onOpenLogs} onOpenTrace={onOpenTrace} />
      </div>
    </section>
  );
}

const IconButton = ({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) => (
  <button type="button" className="rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-30" disabled={disabled} onClick={onClick} title={label} aria-label={label}>
    {children}
  </button>
);

/** The fields each kind of panel filters by (besides its title and kind). */
const FIELDS: Record<Kind, string[]> = {
  logBars: [...SCOPE_KEYS, "severity", "q"],
  logs: [...SCOPE_KEYS, "severity", "q"],
  traces: ["service", "namespace", "pod", "node", "q", "minMs", "errors"],
  metric: ["metric", "groupBy", ...SCOPE_KEYS.filter((k) => k !== "service")],
};

/** A panel's settings: title, kind and the filter of its kind (a metric chosen from those seen). */
function PanelSettings({ panel, onSave }: { panel: DashboardPanel; onSave: (p: DashboardPanel) => void }) {
  const [draft, setDraft] = useState(panel);
  const [metrics, setMetrics] = useState<MetricInfo[]>();
  useEffect(() => {
    if (draft.kind === "metric" && !metrics) void api.metrics({ from: Date.now() - 3 * 3_600_000, to: Date.now() }).then(setMetrics, () => setMetrics([]));
  }, [draft.kind]);
  const set = (key: string, value: string) => setDraft({ ...draft, filter: Object.fromEntries(Object.entries({ ...draft.filter, [key]: value }).filter(([, v]) => v)) });
  const field = (key: string) => {
    const value = draft.filter[key] ?? "";
    if (key === "severity")
      return (
        <select value={value} onChange={(e) => set(key, e.target.value)} className="field py-1 text-sm">
          <option value="">{t("telemetry:all")}</option>
          <option value="info">{t("telemetry:infoUp")}</option>
          <option value="warn">{t("telemetry:warnUp")}</option>
          <option value="error">{t("telemetry:errors")}</option>
        </select>
      );
    if (key === "errors") return <input type="checkbox" checked={value === "true"} onChange={(e) => set(key, e.target.checked ? "true" : "")} />;
    if (key === "metric")
      return (
        <select
          value={value}
          onChange={(e) => {
            const m = metrics?.find((x) => x.name === e.target.value);
            setDraft({ ...draft, title: draft.title || e.target.value, filter: { ...draft.filter, metric: e.target.value, type: m?.type ?? "gauge", unit: m?.unit ?? "" } });
          }}
          className="field py-1 text-sm"
        >
          <option value="">—</option>
          {value && !metrics?.some((m) => m.name === value) && <option value={value}>{value}</option>}
          {metrics?.map((m) => (
            <option key={`${m.type}:${m.name}`} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      );
    return <input value={value} onChange={(e) => set(key, e.target.value)} className="field py-1 text-sm" />;
  };
  return (
    <form
      onSubmit={(e) => (e.preventDefault(), onSave(draft))}
      className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1 border-b border-line bg-canvas px-3 py-2 text-xs text-fg-secondary"
    >
      <label htmlFor={`${panel.id}-title`}>{t("dashboard:title")}</label>
      <input id={`${panel.id}-title`} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} className="field py-1 text-sm" />
      <label htmlFor={`${panel.id}-kind`}>{t("dashboard:kindLabel")}</label>
      <select id={`${panel.id}-kind`} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })} className="field py-1 text-sm">
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {t(`dashboard:kind.${k}`)}
          </option>
        ))}
      </select>
      {FIELDS[draft.kind].map((key) => (
        <label key={key} className="contents">
          <span>{t(`dashboard:field.${key}` as "dashboard:field.service")}</span>
          {field(key)}
        </label>
      ))}
      <span />
      <button className="btn-primary justify-self-start px-3 py-1 text-sm">{t("dashboard:apply")}</button>
    </form>
  );
}

/** What a panel shows, over the dashboard's range, reloaded with `tick` and every minute. */
function PanelBody({ panel, range, tick, onOpenLogs, onOpenTrace }: { panel: DashboardPanel; range: number; tick: number; onOpenLogs: (filter: Record<string, string>) => void; onOpenTrace: (traceId: string) => void }) {
  const [data, setData] = useState<{ bars?: Buckets; logs?: LogRecord[]; traces?: TraceSummary[]; series?: MetricSeries[] }>();
  const [error, setError] = useState<string>();
  const f = panel.filter;
  const key = JSON.stringify([panel.kind, f, range, tick]);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const span = { from: Date.now() - range, to: Date.now() };
        const scope = pick(f, SCOPE_KEYS);
        const next =
          panel.kind === "logBars"
            ? { bars: await api.logHistogram({ ...span, ...scope, severity: f.severity, q: f.q }) }
            : panel.kind === "logs"
              ? { logs: await api.logs({ ...span, ...scope, severity: f.severity, q: f.q, limit: 50 }) }
              : panel.kind === "traces"
                ? { traces: await api.traces({ ...span, ...scope, q: f.q, minMs: Number(f.minMs) > 0 ? Number(f.minMs) : undefined, errors: f.errors === "true", limit: 30 }) }
                : f.metric
                  ? { series: (await api.series({ ...span, ...scope, name: f.metric, type: (f.type as MetricInfo["type"]) || "gauge", groupBy: f.groupBy })).series }
                  : {};
        if (current) (setData(next), setError(undefined));
      } catch (e) {
        if (current) setError((e as Error).message);
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [key]);

  if (error) return <div className="p-3"><ErrorNotice error={error} /></div>;
  if (!data) return <Loading show />;
  const logFilter = (extra: Record<string, string> = {}) => ({ ...pick(f, [...SCOPE_KEYS, "severity", "q"]), range: String(range), ...extra });
  if (panel.kind === "logBars" && data.bars)
    return (
      <div className="pb-2">
        <LogBars data={data.bars} height={120} onPick={(p: BarPick) => onOpenLogs(logFilter({ from: String(p.from), to: String(p.to), ...(p.severity ? { severity: p.severity } : {}) }))} />
      </div>
    );
  if (panel.kind === "logs")
    return (
      <div className="absolute inset-0 overflow-y-auto font-mono text-[11px]">
        {data.logs?.map((l, i) => (
          <button key={`${l.ts}:${i}`} type="button" className="list-row flex w-full gap-2 px-3 py-0.5 text-start" onClick={() => onOpenLogs(logFilter())} title={l.body}>
            <span className="shrink-0 text-fg-muted">{formatDateTime(l.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className={`w-9 shrink-0 ${SEVERITY_CLASS(l.severityNumber)}`}>{l.severity.slice(0, 5) || "—"}</span>
            <span className="min-w-0 flex-1 truncate">{l.body}</span>
          </button>
        ))}
        {data.logs && !data.logs.length && <p className="px-3 py-2 text-fg-muted">{t("telemetry:noLogs")}</p>}
      </div>
    );
  if (panel.kind === "traces")
    return (
      <div className="absolute inset-0 overflow-y-auto text-xs">
        {data.traces?.map((tr) => (
          <button key={tr.traceId} type="button" onClick={() => onOpenTrace(tr.traceId)} className="list-row flex w-full items-baseline gap-2 px-3 py-1 text-start">
            <span className="shrink-0 font-mono text-[11px] text-fg-muted">{formatDateTime(tr.ts, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="min-w-0 flex-1 truncate">
              {tr.error && <span className="me-1 text-error">●</span>}
              <span className="text-fg-muted">{tr.service}</span> {tr.name}
            </span>
            <span className="shrink-0 font-mono text-[11px]">{duration(tr.durationMs)}</span>
          </button>
        ))}
        {data.traces && !data.traces.length && <p className="px-3 py-2 text-fg-muted">{t("telemetry:noTraces")}</p>}
      </div>
    );
  if (panel.kind === "metric") {
    if (!f.metric) return <p className="p-3 text-xs text-fg-muted">{t("dashboard:pickMetric")}</p>;
    if (!data.series?.length) return <p className="p-3 text-xs text-fg-muted">{t("telemetry:noData")}</p>;
    return (
      <div className="p-2">
        <LineChart series={data.series} unit={f.unit ?? ""} />
      </div>
    );
  }
  return null;
}
