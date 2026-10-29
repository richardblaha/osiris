import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary } from "@osiris/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type SavedFilter, type Scope } from "./api.ts";
import { LineChart } from "./Chart.tsx";
import { attempt, ErrorNotice, Loading } from "./ui.tsx";
import { AddToDashboard } from "./Dashboard.tsx";
import { t } from "i18next";
import { formatDateTime, formatNumber } from "./i18n.ts";

/** What a page opens filtered by: the selected twin's telemetry (its namespace, pod, node or container). */
export type Preset = Scope;

const RANGES = [
  { key: "m15", ms: 15 * 60_000 },
  { key: "h1", ms: 3_600_000 },
  { key: "h6", ms: 6 * 3_600_000 },
  { key: "h24", ms: 24 * 3_600_000 },
  { key: "d7", ms: 7 * 24 * 3_600_000 },
] as const;

const time = (ms: number, withDate = false) =>
  formatDateTime(ms, withDate ? { dateStyle: "short", timeStyle: "medium" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const duration = (ms: number) =>
  ms < 1
    ? formatNumber(ms * 1000, { style: "unit", unit: "microsecond", maximumFractionDigits: 0 })
    : ms < 1000
      ? formatNumber(ms, { style: "unit", unit: "millisecond", maximumFractionDigits: ms < 10 ? 1 : 0 })
      : formatNumber(ms / 1000, { style: "unit", unit: "second", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The range to query: the last `ms` up to now, recomputed on every load. */
const lastMs = (ms: number) => ({ from: Date.now() - ms, to: Date.now() });

/** Range and filters in one row above the results; `onRefresh` reloads (also every 30 s with auto). */
export function Toolbar({
  range,
  setRange,
  children,
  onRefresh,
  busy,
  window,
}: {
  range: number;
  setRange: (ms: number) => void;
  children?: ReactNode;
  onRefresh: () => void;
  busy: boolean;
  /** A chosen absolute window: no relative range is active while it is. */
  window?: { from: number; to: number };
}) {
  const [auto, setAuto] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => refresh.current(), 30_000);
    return () => clearInterval(id);
  }, [auto]);
  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-line px-6 py-3 text-sm">
      <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label={t("telemetry:range")}>
        {RANGES.map((r) => (
          <button key={r.ms} type="button" onClick={() => setRange(r.ms)} data-active={!window && range === r.ms} className="list-row border-e border-line px-2 py-1 last:border-e-0">
            {t(`telemetry:ranges.${r.key}`)}
          </button>
        ))}
      </div>
      {children}
      <span className="flex-1" />
      <label className="flex items-center gap-1 text-xs text-fg-secondary">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t("telemetry:autoRefresh")}
      </label>
      <button type="button" onClick={onRefresh} disabled={busy} className="btn-secondary py-1 text-sm">
        {busy ? t("telemetry:loading") : t("telemetry:refresh")}
      </button>
    </div>
  );
}

/** What the filters offer: values seen in the range (at least a day), the pods and containers of `namespace`. */
export function useFacets(range: number, namespace = "") {
  const [facets, setFacets] = useState<TelemetryFacets>({ services: [], namespaces: [] });
  useEffect(() => void api.facets({ ...lastMs(Math.max(range, 24 * 3_600_000)), namespace }).then(setFacets, () => {}), [range, namespace]);
  return facets;
}

/** A value that follows `value` once it has rested for `ms` (typing doesn't query on every key). */
export function useDebounced<T>(value: T, ms = 400): T {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return rested;
}

/** A filter's select: "all" and the values seen; the current value is offered even when the range hasn't seen it. */
export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label className="flex flex-col text-xs text-fg-secondary">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} data-set={!!value} className="field filter-select w-auto max-w-48 py-1 text-sm">
        <option value="">{t("telemetry:all")}</option>
        {all.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Attributes({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return null;
  return (
    <div className="mt-2">
      <span className="text-xs font-medium text-fg-secondary">{title}</span>
      <dl className="mt-1 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 font-mono text-xs">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const SEVERITY_CLASS = (n: number) => (n >= 17 ? "text-error" : n >= 13 ? "text-warning" : n >= 9 ? "text-fg" : "text-fg-muted");

/** Removable chips for the scope's pod, node, container and claim. */
export function ScopeChips({ scope, onClear }: { scope: Scope; onClear: (key: "pod" | "node" | "container" | "claim") => void }) {
  return (
    <>
      {(["node", "pod", "container", "claim"] as const).map((key) =>
        scope[key] ? (
          <button key={key} type="button" onClick={() => onClear(key)} className="badge self-center" title={t("telemetry:all")}>
            {t(`telemetry:${key}`)}: {scope[key]} ×
          </button>
        ) : null,
      )}
    </>
  );
}

/** The logs page's filters, as the URL, a saved filter and a dashboard panel keep them (all strings but the range). */
export interface LogFilter {
  range: number;
  service: string;
  namespace: string;
  pod: string;
  node: string;
  container: string;
  severity: string;
  q: string;
}
const LOG_KEYS = ["service", "namespace", "pod", "node", "container", "severity", "q"] as const;
/** A filter from stored values (missing ones empty; the range only when valid). */
export const filterOf = (f: Record<string, string | undefined>): Partial<LogFilter> => ({
  ...(f.range && Number(f.range) > 0 ? { range: Number(f.range) } : {}),
  ...Object.fromEntries(LOG_KEYS.map((k) => [k, f[k] ?? ""])),
});
/** A filter as stored values: only the set ones. */
export const valuesOf = (f: object): Record<string, string> =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== "" && v !== 0).map(([k, v]) => [k, String(v)]));

/**
 * The user's saved filters (on the server, their own): applying one sets the page's filters, the star saves the
 * current ones under a name, × deletes one.
 */
function SavedFilters({ current, onApply }: { current: LogFilter; onApply: (f: Partial<LogFilter>) => void }) {
  const [list, setList] = useState<SavedFilter[]>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void api.savedFilters().then(setList, (e: Error) => setError(e.message)), []);
  usePopupClose(open, box, () => setOpen(false));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const saved = await api.saveFilter({ id: crypto.randomUUID().slice(0, 12), name: name.trim(), filter: valuesOf(current) });
      setList((l) => [...(l ?? []), saved]);
      setName("");
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteFilter(id);
      setList((l) => l?.filter((f) => f.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div ref={box} className="relative self-end">
      <button type="button" onClick={() => setOpen(!open)} data-active={open} className="btn-secondary py-1 text-sm" aria-expanded={open}>
        ★ {t("telemetry:saved.title")}
        {list && list.length > 0 && <span className="ms-1 text-fg-muted">{formatNumber(list.length)}</span>}
      </button>
      {open && (
        <div className="menu-popup end-0 w-72" role="dialog" aria-label={t("telemetry:saved.title")}>
          {list && list.length === 0 && <p className="px-3 py-2 text-xs text-fg-muted">{t("telemetry:saved.empty")}</p>}
          <ul>
            {list?.map((f) => (
              <li key={f.id} className="flex items-center">
                <button type="button" className="list-row min-w-0 flex-1 truncate px-3 py-1.5 text-start text-sm" onClick={() => (onApply(filterOf(f.filter)), setOpen(false))} title={Object.entries(f.filter).map(([k, v]) => `${k}: ${v}`).join(", ")}>
                  {f.name}
                </button>
                <button type="button" className="px-2 text-fg-muted hover:text-error" onClick={() => void remove(f.id)} aria-label={t("telemetry:saved.delete", { name: f.name })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void save(e)} className="flex gap-2 border-t border-line p-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={t("telemetry:saved.name")} className="field min-w-0 flex-1 py-1 text-sm" aria-label={t("telemetry:saved.name")} />
            <button className="btn-primary px-2 py-1 text-sm" disabled={!name.trim()}>
              {t("telemetry:saved.save")}
            </button>
          </form>
          {error && <p className="px-3 pb-2 text-xs text-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Closes a pop-up on a click outside `box` or on Escape (taken before the page's own Escape). */
export function usePopupClose(open: boolean, box: { current: HTMLElement | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), close());
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

export type Buckets = Awaited<ReturnType<typeof api.logHistogram>>;
/** What a click or a drag on the bar chart picks: a window, and the level of the segment clicked. */
export interface BarPick {
  from: number;
  to: number;
  severity?: "error" | "warn";
}
const SEGMENTS = [
  { key: "other", fill: "var(--accent-primary)", opacity: 0.55 },
  { key: "warn", fill: "var(--state-warning)", opacity: 0.9 },
  { key: "error", fill: "var(--state-error)", opacity: 0.9 },
] as const;

/**
 * How many records came when, as stacked bars (errors, warnings, the rest). Hovering a bar shows its time and counts;
 * a click picks its window (on the error or warning part: that level too), a drag picks the window across bars.
 */
export function LogBars({ data, onPick, height = 72 }: { data: Buckets; onPick?: (pick: BarPick) => void; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number>();
  const [drag, setDrag] = useState<{ start: number; end: number }>();
  const W = 1000;
  const H = height;
  const n = data.buckets.length;
  if (!n) return <div style={{ height }} className="grid place-items-center text-xs text-fg-muted">{t("telemetry:noLogs")}</div>;
  const step = data.step * 1000;
  const t0 = data.buckets[0]!.ts;
  const t1 = data.buckets.at(-1)!.ts + step;
  const max = Math.max(1, ...data.buckets.map((b) => b.error + b.warn + b.other));
  const x = (ts: number) => ((ts - t0) / (t1 - t0)) * W;
  const bw = Math.max(1, (step / (t1 - t0)) * W - 1.5);
  const y = (v: number) => (v / max) * (H - 4);
  /** The bucket under a pointer, by its x on the chart. */
  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    const ts = t0 + ((clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    data.buckets.forEach((b, i) => Math.abs(b.ts + step / 2 - ts) < Math.abs(data.buckets[best]!.ts + step / 2 - ts) && (best = i));
    return best;
  };
  const label = (ts: number) => formatDateTime(ts, t1 - t0 > 2 * 86_400_000 ? { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const shown = hover !== undefined ? data.buckets[hover] : undefined;
  const sel = drag && { lo: Math.min(drag.start, drag.end), hi: Math.max(drag.start, drag.end) };
  const pickable = !!onPick;

  return (
    <figure className="relative px-6 pt-2" aria-label={t("telemetry:histogram")}>
      <div
        ref={box}
        className={`relative ${pickable ? "cursor-pointer select-none" : ""}`}
        onPointerMove={(e) => {
          const i = at(e.clientX);
          setHover(i);
          if (drag) setDrag({ ...drag, end: i });
        }}
        onPointerLeave={() => (setHover(undefined), setDrag(undefined))}
        onPointerDown={(e) => pickable && (e.currentTarget.setPointerCapture(e.pointerId), setDrag({ start: at(e.clientX), end: at(e.clientX) }))}
        onPointerUp={(e) => {
          if (!drag || !onPick) return;
          const lo = Math.min(drag.start, drag.end);
          const hi = Math.max(drag.start, drag.end);
          setDrag(undefined);
          if (lo !== hi) return onPick({ from: data.buckets[lo]!.ts, to: data.buckets[hi]!.ts + step });
          // A click: the bar's window, and the level of the part under the pointer.
          const b = data.buckets[lo]!;
          const r = box.current!.getBoundingClientRect();
          const fromBottom = ((r.bottom - e.clientY) / r.height) * H;
          const severity = fromBottom <= y(b.other) ? undefined : fromBottom <= y(b.other + b.warn) ? "warn" : b.error ? "error" : undefined;
          onPick({ from: b.ts, to: b.ts + step, severity });
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height }} role="img" aria-label={t("telemetry:histogram")}>
          {sel && <rect x={x(data.buckets[sel.lo]!.ts)} y={0} width={x(data.buckets[sel.hi]!.ts + step) - x(data.buckets[sel.lo]!.ts)} height={H} fill="var(--accent-secondary-soft)" />}
          {data.buckets.map((b, i) => {
            let base = H;
            return (
              <g key={b.ts} opacity={hover === undefined || hover === i || (sel && i >= sel.lo && i <= sel.hi) ? 1 : 0.55}>
                {hover === i && <rect x={x(b.ts) - 0.75} y={0} width={bw + 1.5} height={H} fill="var(--bg-hover)" />}
                {SEGMENTS.map(({ key, fill, opacity }) => {
                  const v = b[key];
                  if (!v) return null;
                  base -= y(v);
                  return <rect key={key} x={x(b.ts)} y={base} width={bw} height={y(v)} fill={fill} opacity={opacity} />;
                })}
              </g>
            );
          })}
        </svg>
        {shown && (
          <div className="bar-tip" style={{ left: `${(x(shown.ts + step / 2) / W) * 100}%` }}>
            <strong>
              {label(shown.ts)} – {label(shown.ts + step)}
            </strong>
            <span className="text-error">{t("telemetry:bars.error", { n: formatNumber(shown.error) })}</span>
            <span className="text-warning">{t("telemetry:bars.warn", { n: formatNumber(shown.warn) })}</span>
            <span>{t("telemetry:bars.other", { n: formatNumber(shown.other) })}</span>
            {pickable && <span className="text-fg-muted">{t("telemetry:bars.hint")}</span>}
          </div>
        )}
      </div>
      <figcaption className="flex justify-between text-[10px] text-fg-muted">
        <span>{label(t0)}</span>
        <span>{t("telemetry:histogramMax", { value: formatNumber(max) })}</span>
        <span>{label(t1)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The cluster's log records, newest first, with filters: the range or a window picked on the bar chart, service,
 * namespace, node, pod, container (each offered from what the range has seen), level and text (searched as it's
 * typed); saved favourites; above them the bar chart of how many came when. The filters live in the URL (`onFilters`).
 * A record opens with its attributes and trace.
 */
export function Logs({
  preset,
  initial,
  traceId: initialTrace,
  onOpenTrace,
  onFilters,
}: {
  preset: Preset;
  /** Filter values from the URL or a dashboard (service, severity, q, range, from, to). */
  initial?: Record<string, string>;
  traceId?: string;
  onOpenTrace: (id: string) => void;
  onFilters?: (values: Record<string, string>) => void;
}) {
  const start = filterOf({ ...initial, ...preset });
  const [range, setRange] = useState(start.range ?? 3_600_000);
  const [picked, setPicked] = useState<{ from: number; to: number } | undefined>(
    initial?.from && initial.to && Number(initial.to) > Number(initial.from) ? { from: Number(initial.from), to: Number(initial.to) } : undefined,
  );
  const [service, setService] = useState(start.service ?? "");
  const [namespace, setNamespace] = useState(start.namespace ?? "");
  const [pod, setPod] = useState(start.pod ?? "");
  const [node, setNode] = useState(start.node ?? "");
  const [container, setContainer] = useState(start.container ?? "");
  const [severity, setSeverity] = useState(start.severity ?? "");
  const [q, setQ] = useState(start.q ?? "");
  const text = useDebounced(q.trim());
  const [traceId, setTraceId] = useState(initialTrace ?? "");
  const [logs, setLogs] = useState<LogRecord[]>();
  const [bars, setBars] = useState<Buckets>();
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const facets = useFacets(range, namespace);
  const current: LogFilter = { range, service, namespace, pod, node, container, severity, q: text };
  const span = () => picked ?? lastMs(range);
  const filters = () => ({ ...span(), service, namespace, pod, node, container, severity, q: text, traceId: traceId || undefined });

  const load = () =>
    attempt(setBusy, setError, async () => {
      const f = filters();
      const [list, histogram] = await Promise.all([api.logs({ ...f, limit: 200 }), api.logHistogram(f).catch(() => undefined)]);
      setLogs(list);
      setBars(histogram);
      setMore(list.length === 200);
      setOpen(undefined);
    });
  const older = () =>
    attempt(setBusy, setError, async () => {
      const last = logs?.at(-1);
      if (!last) return;
      const list = await api.logs({ ...filters(), to: last.ts - 1, limit: 200 });
      setLogs([...(logs ?? []), ...list]);
      setMore(list.length === 200);
    });
  useEffect(() => {
    void load();
    onFilters?.(valuesOf({ ...current, range: range === 3_600_000 ? 0 : range, from: picked?.from, to: picked?.to }));
  }, [range, picked, service, namespace, pod, node, container, severity, text, traceId]);
  const apply = (f: Partial<LogFilter>) => {
    if (f.range) setRange(f.range);
    setPicked(undefined);
    setService(f.service ?? "");
    setNamespace(f.namespace ?? "");
    setPod(f.pod ?? "");
    setNode(f.node ?? "");
    setContainer(f.container ?? "");
    setSeverity(f.severity ?? "");
    setQ(f.q ?? "");
    setTraceId("");
  };
  const active = [picked, service, namespace, pod, node, container, severity, text, traceId].filter(Boolean).length;
  const windowLabel = (ms: number) => formatDateTime(ms, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex h-full flex-col">
      <Toolbar range={range} setRange={(ms) => (setPicked(undefined), setRange(ms))} onRefresh={() => void load()} busy={busy} window={picked}>
        <Select label={t("telemetry:service")} value={service} onChange={setService} options={facets.services} />
        <Select label={t("telemetry:namespace")} value={namespace} onChange={(v) => (setNamespace(v), setPod(""), setContainer(""))} options={facets.namespaces} />
        <Select label={t("telemetry:node")} value={node} onChange={setNode} options={facets.nodes ?? []} />
        <Select label={t("telemetry:pod")} value={pod} onChange={setPod} options={facets.pods ?? []} />
        <Select label={t("telemetry:container")} value={container} onChange={setContainer} options={facets.containers ?? []} />
        <label className="flex flex-col text-xs text-fg-secondary">
          {t("telemetry:severity")}
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} data-set={!!severity} className="field filter-select w-auto py-1 text-sm">
            <option value="">{t("telemetry:all")}</option>
            <option value="debug">{t("telemetry:debugUp")}</option>
            <option value="info">{t("telemetry:infoUp")}</option>
            <option value="warn">{t("telemetry:warnUp")}</option>
            <option value="error">{t("telemetry:errors")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs text-fg-secondary">
          {t("telemetry:searchText")}
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("telemetry:searchPlaceholder")} data-set={!!q} className="field filter-select w-56 py-1 text-sm" />
        </label>
        {picked && (
          <button type="button" onClick={() => setPicked(undefined)} className="badge self-center" title={t("telemetry:clearWindow")}>
            {windowLabel(picked.from)} – {windowLabel(picked.to)} ×
          </button>
        )}
        {traceId && (
          <button type="button" onClick={() => setTraceId("")} className="badge self-center" title={t("telemetry:clearTrace")}>
            {t("telemetry:traceFilter", { id: traceId.slice(0, 8) })} ×
          </button>
        )}
        {active > 0 && (
          <button type="button" onClick={() => apply({ range })} className="btn-link self-center text-xs">
            {t("telemetry:clearFilters", { n: active })}
          </button>
        )}
        <SavedFilters current={current} onApply={apply} />
        <AddToDashboard kinds={["logBars", "logs"]} title={[service, pod || namespace, severity].filter(Boolean).join(" · ") || t("common:nav.logs")} filter={valuesOf(current)} range={range} />
      </Toolbar>
      {bars && <LogBars data={bars} onPick={(p) => (setPicked({ from: p.from, to: p.to }), p.severity && setSeverity(p.severity))} />}
      <div className="relative min-h-0 flex-1">
        <Loading show={busy} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <ul className="font-mono text-xs">
            {logs?.map((l, i) => (
              <li key={`${l.ts}:${i}`} className="border-b border-line">
                <button onClick={() => setOpen(open === i ? undefined : i)} data-active={open === i} className="list-row flex w-full gap-3 px-1 py-1 text-start">
                  <span className="shrink-0 text-fg-muted">{time(l.ts, !!picked || range > 24 * 3_600_000)}</span>
                  <span className={`w-12 shrink-0 ${SEVERITY_CLASS(l.severityNumber)}`}>{l.severity || "—"}</span>
                  <span className="w-36 shrink-0 truncate text-fg-secondary" title={l.service}>
                    {l.service || l.pod}
                  </span>
                  <span className={`min-w-0 flex-1 ${open === i ? "break-all whitespace-pre-wrap" : "truncate"}`}>{l.body}</span>
                </button>
                {open === i && (
                  <div className="px-1 pb-2 font-sans">
                    {l.traceId && (
                      <button onClick={() => onOpenTrace(l.traceId)} className="btn-link text-xs">
                        {t("telemetry:openTrace", { id: l.traceId })}
                      </button>
                    )}
                    <Attributes title={t("telemetry:attributes")} values={l.attributes} />
                    <Attributes title={t("telemetry:resource")} values={l.resource} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {logs && !logs.length && <p className="py-4 text-sm text-fg-muted">{t("telemetry:noLogs")}</p>}
          {more && (
            <button onClick={() => void older()} disabled={busy} className="btn-secondary mt-3 text-sm">
              {t("telemetry:older")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Traces by their root span; one opens as a waterfall of its spans, with its logs. */
export function Traces({ preset, traceId, onOpenTrace, onOpenLogs }: { preset: Preset; traceId?: string; onOpenTrace: (id?: string) => void; onOpenLogs: (traceId: string) => void }) {
  const [range, setRange] = useState(3_600_000);
  const [service, setService] = useState("");
  const [namespace, setNamespace] = useState(preset.namespace ?? "");
  const [pod, setPod] = useState(preset.pod ?? "");
  const [node, setNode] = useState(preset.node ?? "");
  const [q, setQ] = useState("");
  const [minMs, setMinMs] = useState("");
  const [errors, setErrors] = useState(false);
  const [list, setList] = useState<TraceSummary[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const facets = useFacets(range, namespace);
  // Name and duration apply as they're typed, once typing rests.
  const name = useDebounced(q.trim());
  const longer = useDebounced(minMs);

  const load = () =>
    attempt(setBusy, setError, async () =>
      setList(await api.traces({ ...lastMs(range), service, namespace, pod, node, q: name, minMs: Number(longer) > 0 ? Number(longer) : undefined, errors })),
    );
  useEffect(() => void load(), [range, service, namespace, pod, node, name, longer, errors]);
  const active = [service, namespace, pod, node, name, Number(longer) > 0, errors].filter(Boolean).length;
  const clear = () => (setService(""), setNamespace(""), setPod(""), setNode(""), setQ(""), setMinMs(""), setErrors(false));

  if (traceId) return <TraceView traceId={traceId} onBack={() => onOpenTrace(undefined)} onOpenLogs={onOpenLogs} />;
  return (
    <div className="flex h-full flex-col">
      <Toolbar range={range} setRange={setRange} onRefresh={() => void load()} busy={busy}>
        <Select label={t("telemetry:service")} value={service} onChange={setService} options={facets.services} />
        <Select label={t("telemetry:namespace")} value={namespace} onChange={(v) => (setNamespace(v), setPod(""))} options={facets.namespaces} />
        <Select label={t("telemetry:node")} value={node} onChange={setNode} options={facets.nodes ?? []} />
        <Select label={t("telemetry:pod")} value={pod} onChange={setPod} options={facets.pods ?? []} />
        <label className="flex flex-col text-xs text-fg-secondary">
          {t("telemetry:name")}
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("telemetry:namePlaceholder")} data-set={!!q} className="field filter-select w-48 py-1 text-sm" />
        </label>
        <label className="flex flex-col text-xs text-fg-secondary">
          {t("telemetry:longerThan")}
          <input type="number" min={0} value={minMs} onChange={(e) => setMinMs(e.target.value)} data-set={!!minMs} className="field filter-select w-24 py-1 text-sm" />
        </label>
        <label className="flex items-center gap-1 self-center text-xs text-fg-secondary">
          <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> {t("telemetry:errorsOnly")}
        </label>
        {active > 0 && (
          <button type="button" onClick={clear} className="btn-link self-center text-xs">
            {t("telemetry:clearFilters", { n: active })}
          </button>
        )}
        <AddToDashboard
          kinds={["traces"]}
          title={[service, pod || namespace, errors ? t("telemetry:errorsOnly") : ""].filter(Boolean).join(" · ") || t("common:nav.traces")}
          filter={valuesOf({ service, namespace, pod, node, q: name, minMs: Number(longer) > 0 ? longer : "", errors: errors ? "true" : "" })}
          range={range}
        />
      </Toolbar>
      <div className="relative min-h-0 flex-1">
        <Loading show={busy} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <table className="w-full text-sm">
            <thead className="text-start text-xs text-fg-muted">
              <tr>
                <th className="py-1 font-normal">{t("telemetry:time")}</th>
                <th className="py-1 font-normal">{t("telemetry:service")}</th>
                <th className="py-1 font-normal">{t("telemetry:name")}</th>
                <th className="py-1 text-end font-normal">{t("telemetry:duration")}</th>
                <th className="py-1 text-end font-normal">{t("telemetry:spans")}</th>
              </tr>
            </thead>
            <tbody>
              {list?.map((tr) => (
                <tr key={tr.traceId} onClick={() => onOpenTrace(tr.traceId)} className="list-row cursor-pointer border-t border-line">
                  <td className="py-1 pe-3 font-mono text-xs whitespace-nowrap text-fg-muted">{time(tr.ts, range > 24 * 3_600_000)}</td>
                  <td className="py-1 pe-3 text-fg-secondary">{tr.service}</td>
                  <td className="py-1 pe-3">
                    {tr.error && <span className="me-1 text-error" aria-label={t("telemetry:error")}>●</span>}
                    {tr.name}
                  </td>
                  <td className="py-1 pe-3 text-end font-mono text-xs">{duration(tr.durationMs)}</td>
                  <td className="py-1 text-end text-fg-muted">{formatNumber(tr.spans)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list && !list.length && <p className="py-4 text-sm text-fg-muted">{t("telemetry:noTraces")}</p>}
        </div>
      </div>
    </div>
  );
}

function TraceView({ traceId, onBack, onOpenLogs }: { traceId: string; onBack: () => void; onOpenLogs: (traceId: string) => void }) {
  const [spans, setSpans] = useState<SpanRecord[]>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.trace(traceId).then(setSpans, (e: Error) => setError(e.message)), [traceId]);

  // Spans in tree order (children under their parent), with their depth.
  const rows = useMemo(() => {
    if (!spans) return [];
    const ids = new Set(spans.map((s) => s.spanId));
    const children = new Map<string, SpanRecord[]>();
    for (const s of spans) {
      const parent = ids.has(s.parentSpanId) ? s.parentSpanId : "";
      children.set(parent, [...(children.get(parent) ?? []), s]);
    }
    const out: { span: SpanRecord; depth: number }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const s of (children.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs)) {
        out.push({ span: s, depth });
        walk(s.spanId, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [spans]);
  const start = Math.min(...rows.map((r) => r.span.startMs));
  const end = Math.max(...rows.map((r) => r.span.startMs + r.span.durationMs));
  const total = Math.max(end - start, 0.001);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-3 text-sm">
        <button onClick={onBack} className="btn-link">
          ← {t("telemetry:tabs.traces")}
        </button>
        <code className="text-xs">{traceId}</code>
        {rows.length > 0 && (
          <span className="text-fg-secondary">
            {t("telemetry:spanCount", { count: rows.length })} · {duration(total)} · {time(start, true)}
          </span>
        )}
        <span className="flex-1" />
        <button onClick={() => onOpenLogs(traceId)} className="btn-secondary py-1 text-sm">
          {t("telemetry:traceLogs")}
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <Loading show={!spans && !error} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <ul className="text-xs">
            {rows.map(({ span: s, depth }) => (
              <li key={s.spanId} className="border-b border-line">
                <button onClick={() => setOpen(open === s.spanId ? undefined : s.spanId)} data-active={open === s.spanId} className="list-row flex w-full items-center gap-3 px-1 py-1 text-start">
                  <span className="w-80 shrink-0 truncate" style={{ paddingInlineStart: depth * 12 }} title={`${s.service}: ${s.name}`}>
                    {s.error && <span className="me-1 text-error" aria-label={t("telemetry:error")}>●</span>}
                    <span className="text-fg-muted">{s.service}</span> {s.name}
                  </span>
                  <span className="relative h-3 min-w-0 flex-1">
                    <span
                      className={`absolute top-0 h-3 rounded-sm ${s.error ? "bg-error" : "bg-primary"}`}
                      style={{ left: `${((s.startMs - start) / total) * 100}%`, width: `max(2px, ${(s.durationMs / total) * 100}%)` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-end font-mono">{duration(s.durationMs)}</span>
                </button>
                {open === s.spanId && (
                  <div className="px-1 pb-2">
                    <p className="text-fg-secondary">
                      {s.kind} · {t("telemetry:start", { offset: duration(s.startMs - start) })}
                      {s.statusMessage && <span className="text-error"> · {s.statusMessage}</span>}
                    </p>
                    <Attributes title={t("telemetry:attributes")} values={s.attributes} />
                    <Attributes title={t("telemetry:resource")} values={s.resource} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {spans && !spans.length && <p className="py-4 text-sm text-fg-muted">{t("telemetry:noSpans")}</p>}
        </div>
      </div>
    </div>
  );
}

const GROUPS = ["", "k8s.pod.name", "k8s.namespace.name", "k8s.node.name", "k8s.container.name", "service.name", "http.route", "http.response.status_code"];
const typeLabel = (type: MetricInfo["type"]) => t(`telemetry:metricTypes.${type}`);

/** Metrics by name on the left; the chosen one as a line chart (a line per group) with a table view. */
export function Metrics({ preset }: { preset: Preset }) {
  const [range, setRange] = useState(3_600_000);
  const [filter, setFilter] = useState("");
  const [metrics, setMetrics] = useState<MetricInfo[]>();
  const [chosen, setChosen] = useState<MetricInfo>();
  const [groupBy, setGroupBy] = useState("k8s.pod.name");
  const [data, setData] = useState<{ step: number; series: MetricSeries[] }>();
  /** Whose series (opened from a twin: its namespace, pod, node or container); each part can be cleared. */
  const [scope, setScope] = useState<Scope>(preset);
  const [table, setTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadList = () => attempt(setBusy, setError, async () => setMetrics(await api.metrics(lastMs(Math.max(range, 3_600_000)))));
  const loadSeries = () =>
    chosen && attempt(setBusy, setError, async () => setData(await api.series({ ...lastMs(range), ...scope, name: chosen.name, type: chosen.type, groupBy })));
  useEffect(() => void loadList(), []);
  useEffect(() => void loadSeries(), [chosen, groupBy, range, scope]);
  const shown = metrics?.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <div className="flex h-full">
      <nav className="flex w-80 shrink-0 flex-col border-e border-line p-2 text-sm">
        <h2 className="section-header px-2 py-1">{t("telemetry:tabs.metrics")}</h2>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("telemetry:searchMetric")} className="field mx-1 mt-1 w-auto py-1 text-sm" />
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {shown.map((m) => (
            <button
              key={`${m.type}:${m.name}`}
              onClick={() => (setChosen(m), setData(undefined))}
              data-active={chosen?.name === m.name && chosen.type === m.type}
              className="list-row block w-full px-2 py-1 text-start"
              title={m.description || m.name}
            >
              <span className="block truncate font-mono text-xs">{m.name}</span>
              <span className="block truncate text-xs text-fg-muted">
                {m.type}
                {m.unit && ` · ${m.unit}`}
              </span>
            </button>
          ))}
          {metrics && !shown.length && <p className="px-2 py-1 text-fg-muted">{t("telemetry:noData")}</p>}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar range={range} setRange={setRange} onRefresh={() => void (chosen ? loadSeries() : loadList())} busy={busy}>
          <label className="flex flex-col text-xs text-fg-secondary">
            {t("telemetry:groupBy")}
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="field w-auto py-1 text-sm">
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g || t("telemetry:noGrouping")}
                </option>
              ))}
            </select>
          </label>
          {scope.namespace && (
            <button type="button" onClick={() => setScope({ ...scope, namespace: undefined })} className="badge self-center" title={t("telemetry:all")}>
              {t("telemetry:namespace")}: {scope.namespace} ×
            </button>
          )}
          <ScopeChips scope={scope} onClear={(key) => setScope({ ...scope, [key]: undefined })} />
          {chosen && (
            <AddToDashboard
              kinds={["metric"]}
              title={chosen.name}
              filter={valuesOf({ metric: chosen.name, type: chosen.type, groupBy, unit: chosen.unit, ...scope })}
              range={range}
            />
          )}
          <label className="flex items-center gap-1 self-center text-xs text-fg-secondary">
            <input type="checkbox" checked={table} onChange={(e) => setTable(e.target.checked)} /> {t("telemetry:table")}
          </label>
        </Toolbar>
        <div className="relative min-h-0 flex-1">
          <Loading show={busy} />
          <div className="h-full overflow-y-auto px-6 py-4">
            <ErrorNotice error={error} />
            {!chosen ? (
              <p className="text-sm text-fg-muted">{t("telemetry:selectMetric")}</p>
            ) : (
              <>
                <h1 className="font-mono text-base font-semibold">{chosen.name}</h1>
                <p className="text-xs text-fg-secondary">
                  {chosen.description}
                  {chosen.description && " · "}
                  {typeLabel(chosen.type)}
                  {chosen.unit && ` (${chosen.unit}${chosen.type === "sum" ? "/s" : ""})`}
                  {data && ` · ${t("telemetry:step", { step: data.step >= 3600 ? formatNumber(data.step / 3600, { style: "unit", unit: "hour" }) : formatNumber(data.step / 60, { style: "unit", unit: "minute" }) })}`}
                </p>
                {data && !data.series.length && <p className="mt-4 text-sm text-fg-muted">{t("telemetry:noData")}</p>}
                {data && data.series.length > 0 && (table ? <SeriesTable data={data.series} /> : <LineChart series={data.series} unit={chosen.unit} />)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const number = (v: number) =>
  Math.abs(v) >= 1e4 ? formatNumber(v, { notation: "compact", maximumFractionDigits: 1 }) : formatNumber(v, { maximumFractionDigits: 2 });

function SeriesTable({ data }: { data: MetricSeries[] }) {
  const times = [...new Set(data.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a);
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr className="text-start text-fg-muted">
            <th className="py-1 pe-4 font-normal">{t("telemetry:time")}</th>
            {data.map((s) => (
              <th key={s.name} className="py-1 pe-4 font-normal">
                {s.name || t("telemetry:value")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {times.map((at) => (
            <tr key={at} className="border-t border-line">
              <td className="py-0.5 pe-4 whitespace-nowrap text-fg-muted">{formatDateTime(at, { dateStyle: "short", timeStyle: "medium" })}</td>
              {data.map((s) => {
                const v = s.points.find((p) => p[0] === at)?.[1];
                return (
                  <td key={s.name} className="py-0.5 pe-4 text-end">
                    {v === undefined ? "" : number(v)}
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
