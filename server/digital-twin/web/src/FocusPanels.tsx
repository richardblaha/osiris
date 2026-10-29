import type { LogRecord, MetricInfo, MetricSeries, TraceSummary } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, type Scope } from "./api.ts";
import { formatBytes, formatBytesRate, formatDateTime, formatNumber } from "./i18n.ts";
import { scopeOf, type TwinScene, type TwinView } from "./scene.ts";
import { duration, SEVERITY_CLASS } from "./Telemetry.tsx";
import type { Point } from "./Twin3D.tsx";
import { TwinDetail } from "./TwinDetail.tsx";
import { ErrorNotice } from "./ui.tsx";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Page = "logs" | "metrics" | "traces";
/** The panels and the corner each sits in. */
const SLOTS = [
  { key: "properties", slot: "tl" },
  { key: "logs", slot: "tr" },
  { key: "metrics", slot: "br" },
  { key: "traces", slot: "bl" },
] as const;
type Slot = (typeof SLOTS)[number]["slot"];

/**
 * The selected twin's panels around it, as plain HTML over the 3D view: its properties, its logs, metrics and traces
 * (for the OpenTelemetry resource its `otelResource` names). An SVG line runs from each panel to the nearest corner
 * of the twin's box on screen, following the camera every frame.
 */
export function FocusPanels({
  node,
  scene,
  anchor,
  onSelect,
  onOpenPage,
  onOpenTrace,
}: {
  node: TwinView;
  scene: TwinScene;
  anchor: RefObject<(() => Point[] | null) | null>;
  onSelect: (id: string) => void;
  onOpenPage: (page: Page) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const panels = useRef(new Map<Slot, HTMLElement>());
  const paths = useRef(new Map<Slot, SVGPathElement>());
  const starts = useRef(new Map<Slot, SVGCircleElement>());
  const targets = useRef(new Map<Slot, SVGCircleElement>());
  const scope = scopeOf(node);

  // The callout lines, redrawn every frame: from the panel's inner top corner to the box's nearest corner.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const box = host.current?.getBoundingClientRect();
      const corners = anchor.current?.() ?? null;
      for (const { slot } of SLOTS) {
        const panel = panels.current.get(slot);
        const path = paths.current.get(slot);
        const a = starts.current.get(slot);
        const b = targets.current.get(slot);
        if (!box || !panel || !path || !a || !b) continue;
        const r = panel.getBoundingClientRect();
        // Panels in a column (a narrow screen) or nothing to point at: no line.
        const shown = corners && getComputedStyle(panel).position === "absolute" && r.width > 0;
        path.style.display = a.style.display = b.style.display = shown ? "" : "none";
        if (!shown) continue;
        const left = slot === "tl" || slot === "bl";
        const top = slot === "tl" || slot === "tr";
        const end = { x: (left ? r.right : r.left) - box.left, y: (top ? r.top + 22 : r.bottom - 22) - box.top };
        const target = corners.reduce((best, p) => (Math.hypot(p.x - end.x, p.y - end.y) < Math.hypot(best.x - end.x, best.y - end.y) ? p : best));
        const knee = { x: end.x + (left ? 28 : -28), y: end.y };
        path.setAttribute("d", `M${end.x},${end.y} L${knee.x},${knee.y} L${target.x},${target.y}`);
        a.setAttribute("cx", String(end.x));
        a.setAttribute("cy", String(end.y));
        b.setAttribute("cx", String(target.x));
        b.setAttribute("cy", String(target.y));
      }
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  /** A ref callback keeping `slot`'s element in `map`. */
  const keep =
    <T,>(map: Map<Slot, T>, slot: Slot) =>
    (el: T | null) =>
      void (el ? map.set(slot, el) : map.delete(slot));
  const bind = (slot: Slot) => keep(panels.current, slot);
  const open = (page: Page) => (
    <button type="button" className="focus-panel-open" onClick={() => onOpenPage(page)} title={t("twin:openPage")} aria-label={t("twin:openPage")}>
      ↗
    </button>
  );

  return (
    <div ref={host} className="focus-panels">
      <svg className="focus-lines" aria-hidden="true">
        {SLOTS.map(({ slot }) => (
          <g key={slot}>
            <path ref={keep(paths.current, slot)} />
            <circle r={2.5} ref={keep(starts.current, slot)} />
            <circle r={3.5} className="focus-line-target" ref={keep(targets.current, slot)} />
          </g>
        ))}
      </svg>
      <Panel slot="tl" bind={bind("tl")} title={node.modelName} heading={node.name} label={`${t("twin:properties")}: ${node.name}`}>
        <TwinDetail node={node} scene={scene} onSelect={onSelect} />
      </Panel>
      <Panel slot="tr" bind={bind("tr")} title={t("twin:panel.logs")} action={open("logs")} flush>
        <LogTail scope={{ ...scope, claim: undefined }} at={scene.at} />
      </Panel>
      <Panel slot="br" bind={bind("br")} title={t("twin:panel.metrics")} action={open("metrics")}>
        <MetricsPanel scope={scope} at={scene.at} />
      </Panel>
      <Panel slot="bl" bind={bind("bl")} title={t("twin:panel.traces")} action={open("traces")} flush>
        <TraceList scope={{ ...scope, container: undefined, claim: undefined }} at={scene.at} onOpen={onOpenTrace} />
      </Panel>
    </div>
  );
}

function Panel({
  slot,
  bind,
  title,
  heading,
  label,
  action,
  flush,
  children,
}: {
  slot: Slot;
  bind: (el: HTMLElement | null) => void;
  title: string;
  heading?: string;
  label?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <section ref={bind} className="focus-panel" data-slot={slot} aria-label={label ?? title}>
      <header className="flex items-start gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="section-header truncate">{title}</h2>
          {heading && (
            <p className="truncate text-sm font-semibold" title={heading}>
              {heading}
            </p>
          )}
        </div>
        {action}
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto ${flush ? "" : "px-3 py-2"}`}>{children}</div>
    </section>
  );
}

const time = (ms: number) => formatDateTime(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const logKey = (l: LogRecord) => `${l.ts}:${l.pod}:${l.body.slice(0, 80)}`;

/**
 * The twin's logs as a terminal: the 10 newest at the bottom, older ones loading as it scrolls up, new ones arriving
 * every 15 s while live (it follows them only when it's at the bottom).
 */
function LogTail({ scope, at }: { scope: Scope; at: number | null }) {
  const [rows, setRows] = useState<LogRecord[]>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  /** How the scroll position moves once new rows are drawn: to the bottom, or kept while older rows go on top. */
  const adjust = useRef<{ bottom: true } | { keep: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const el = list.current;
    const a = adjust.current;
    adjust.current = undefined;
    if (!el || !a) return;
    if ("bottom" in a) el.scrollTop = el.scrollHeight;
    else el.scrollTop += el.scrollHeight - a.keep;
  }, [rows]);

  useEffect(() => {
    const to = at ?? Date.now();
    let current = true;
    api.logs({ ...scope, from: to - DAY, to, limit: 10 }).then(
      (page) => {
        if (!current) return;
        adjust.current = { bottom: true };
        setRows(page.reverse());
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [at]);

  // Live: the records since the newest, appended.
  useEffect(() => {
    if (at !== null) return;
    const id = setInterval(() => {
      const newest = rows?.at(-1);
      if (!rows) return;
      const el = list.current;
      void api.logs({ ...scope, from: newest?.ts ?? Date.now() - HOUR, to: Date.now(), limit: 50 }).then((fresh) => {
        const seen = new Set(rows.map(logKey));
        const add = fresh.reverse().filter((l) => !seen.has(logKey(l)) && (!newest || l.ts >= newest.ts));
        if (!add.length) return;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 30) adjust.current = { bottom: true };
        setRows((r) => [...(r ?? []), ...add]);
      }, () => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [at, rows]);

  const older = () => {
    const oldest = rows?.[0];
    if (!oldest || busy || done) return;
    setBusy(true);
    const to = oldest.ts - 1;
    api.logs({ ...scope, from: to - 30 * DAY, to, limit: 25 }).then(
      (page) => {
        if (!page.length) setDone(true);
        adjust.current = { keep: list.current?.scrollHeight ?? 0 };
        setRows((r) => [...page.reverse(), ...(r ?? [])]);
        setBusy(false);
      },
      (e: Error) => (setError(e.message), setBusy(false)),
    );
  };

  return (
    <div ref={list} className="h-full overflow-y-auto font-mono text-[11px]" onScroll={(e) => e.currentTarget.scrollTop < 24 && older()}>
      {rows && rows.length > 0 && <p className="px-3 py-1 text-center text-fg-muted">{done ? t("twin:logsStart") : busy ? t("telemetry:loading") : t("twin:scrollOlder")}</p>}
      <ErrorNotice error={error} />
      {rows?.map((l) => {
        const key = logKey(l);
        return (
          <button key={key} type="button" onClick={() => setOpen(open === key ? undefined : key)} data-active={open === key} className="list-row flex w-full gap-2 px-3 py-0.5 text-start">
            <span className="shrink-0 text-fg-muted">{time(l.ts)}</span>
            <span className={`w-9 shrink-0 ${SEVERITY_CLASS(l.severityNumber)}`}>{l.severity.slice(0, 5) || "—"}</span>
            <span className={`min-w-0 flex-1 ${open === key ? "break-all whitespace-pre-wrap" : "truncate"}`} title={l.service || l.pod}>
              {l.body}
            </span>
          </button>
        );
      })}
      {rows && !rows.length && <p className="px-3 py-2 text-fg-muted">{t("telemetry:noLogs")}</p>}
      {!rows && !error && <p className="px-3 py-2 text-fg-muted">{t("telemetry:loading")}</p>}
    </div>
  );
}

/** The newest traces of the twin, more as the list scrolls down; one opens on the Traces page. */
function TraceList({ scope, at, onOpen }: { scope: Scope; at: number | null; onOpen: (traceId: string) => void }) {
  const [rows, setRows] = useState<TraceSummary[]>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const to = at ?? Date.now();
    let current = true;
    api.traces({ ...scope, from: to - DAY, to, limit: 10 }).then(
      (list) => current && (setRows(list), setDone(list.length < 10)),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [at]);

  const older = () => {
    const last = rows?.at(-1);
    if (!last || busy || done) return;
    setBusy(true);
    const to = last.ts - 1;
    api.traces({ ...scope, from: to - 7 * DAY, to, limit: 15 }).then(
      (list) => (setRows((r) => [...(r ?? []), ...list]), setDone(list.length < 15), setBusy(false)),
      (e: Error) => (setError(e.message), setBusy(false)),
    );
  };

  return (
    <div
      className="h-full overflow-y-auto text-xs"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) older();
      }}
    >
      <ErrorNotice error={error} />
      {rows?.map((tr) => (
        <button key={tr.traceId} type="button" onClick={() => onOpen(tr.traceId)} className="list-row flex w-full items-baseline gap-2 px-3 py-1 text-start">
          <span className="shrink-0 font-mono text-[11px] text-fg-muted">{time(tr.ts)}</span>
          <span className="min-w-0 flex-1 truncate" title={`${tr.service}: ${tr.name}`}>
            {tr.error && <span className="me-1 text-error" aria-label={t("telemetry:error")}>●</span>}
            <span className="text-fg-muted">{tr.service}</span> {tr.name}
          </span>
          <span className="shrink-0 font-mono text-[11px]">{duration(tr.durationMs)}</span>
        </button>
      ))}
      {rows && rows.length > 0 && busy && <p className="px-3 py-1 text-center text-fg-muted">{t("telemetry:loading")}</p>}
      {rows && !rows.length && <p className="px-3 py-2 text-fg-muted">{t("telemetry:noTraces")}</p>}
      {!rows && !error && <p className="px-3 py-2 text-fg-muted">{t("telemetry:loading")}</p>}
    </div>
  );
}

/** kubeletstats' metric names per level, the newer name first (the collector's version decides which exist). */
const CANDIDATES = {
  node: { cpu: ["k8s.node.cpu.usage", "k8s.node.cpu.utilization"], memory: ["k8s.node.memory.working_set", "k8s.node.memory.usage"], network: ["k8s.node.network.io"] },
  pod: { cpu: ["k8s.pod.cpu.usage", "k8s.pod.cpu.utilization"], memory: ["k8s.pod.memory.working_set", "k8s.pod.memory.usage"], network: ["k8s.pod.network.io"] },
  container: { cpu: ["container.cpu.usage", "container.cpu.utilization"], memory: ["container.memory.working_set", "container.memory.usage"], network: [] },
  volume: { free: ["k8s.volume.available"], size: ["k8s.volume.capacity"] },
} as const;
type Measure = "cpu" | "memory" | "network" | "free" | "size";

/** The metrics seen in the last hours, asked once a while (every panel picks its names from them). */
let available: { at: number; list: Promise<Map<string, MetricInfo>> } | undefined;
const metricList = () => {
  if (!available || Date.now() - available.at > 10 * 60_000) {
    const list = api.metrics({ from: Date.now() - 3 * HOUR, to: Date.now() }).then((l) => new Map(l.map((m) => [m.name, m])));
    available = { at: Date.now(), list };
    list.catch(() => (available = undefined));
  }
  return available.list;
};

/**
 * Which metrics show a twin's load and how: a container's, a pod's or a node's own (CPU, memory, network); a
 * namespace's pods side by side; the cluster's nodes side by side.
 */
function plan(scope: Scope): { level: keyof typeof CANDIDATES; filter: Scope; groupBy: string } {
  if (scope.claim) return { level: "volume", filter: { namespace: scope.namespace, claim: scope.claim }, groupBy: "" };
  if (scope.container) return { level: "container", filter: { namespace: scope.namespace, pod: scope.pod, container: scope.container }, groupBy: "" };
  if (scope.pod) return { level: "pod", filter: { namespace: scope.namespace, pod: scope.pod }, groupBy: "" };
  if (scope.node) return { level: "node", filter: { node: scope.node }, groupBy: "" };
  if (scope.namespace) return { level: "pod", filter: { namespace: scope.namespace }, groupBy: "k8s.pod.name" };
  return { level: "node", filter: {}, groupBy: "k8s.node.name" };
}

/** A value in its metric's unit: bytes, bytes per second, cores or a share. */
function formatValue(v: number, unit: string, measure: Measure): string {
  if (measure === "network") return formatBytesRate(v);
  if (measure === "free" || measure === "size") return formatBytes(v);
  if (unit === "By") return formatBytes(v);
  if (unit === "1") return formatNumber(v, { style: "percent", maximumFractionDigits: 1 });
  return formatNumber(v, { maximumFractionDigits: v < 1 ? 3 : 2 });
}

/** The twin's CPU, memory and network over the last hour (up to the time shown), refreshed every minute while live. */
function MetricsPanel({ scope, at }: { scope: Scope; at: number | null }) {
  const [charts, setCharts] = useState<{ measure: Measure; info: MetricInfo; series: MetricSeries[] }[]>();
  const [error, setError] = useState<string>();
  const { level, filter, groupBy } = plan(scope);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const names = await metricList();
        const to = at ?? Date.now();
        const picked = (Object.entries(CANDIDATES[level] as Partial<Record<Measure, readonly string[]>>) as [Measure, readonly string[]][]).flatMap(([measure, list]) => {
          const info = list.map((n) => names.get(n)).find(Boolean);
          return info ? [{ measure, info }] : [];
        });
        const loaded = await Promise.all(
          picked.map(async ({ measure, info }) => ({ measure, info, series: (await api.series({ ...filter, from: to - HOUR, to, name: info.name, type: info.type, groupBy })).series })),
        );
        if (current) setCharts(loaded);
      } catch (e) {
        if (current) setError((e as Error).message);
      }
    };
    void load();
    if (at !== null) return () => void (current = false);
    const id = setInterval(() => void load(), 60_000);
    return () => {
      current = false;
      clearInterval(id);
    };
  }, [at]);

  if (error) return <ErrorNotice error={error} />;
  if (!charts) return <p className="text-xs text-fg-muted">{t("telemetry:loading")}</p>;
  if (!charts.some((c) => c.series.length)) return <p className="text-xs text-fg-muted">{t("telemetry:noData")}</p>;
  return (
    <div className="space-y-3">
      {charts.map((c) => (
        <Spark key={c.measure} title={t(`twin:measure.${c.measure}`)} series={c.series} format={(v) => formatValue(v, c.info.unit, c.measure)} />
      ))}
    </div>
  );
}

const seriesColor = (i: number) => `var(--series-${(i % 8) + 1})`;

/** A small chart: one line per series (the first in the theme's cyan with an area under it), the newest value. */
function Spark({ title, series, format }: { title: string; series: MetricSeries[]; format: (v: number) => string }) {
  const W = 300;
  const H = 56;
  const points = series.flatMap((s) => s.points);
  if (!points.length) return null;
  const t0 = Math.min(...points.map((p) => p[0]));
  const t1 = Math.max(...points.map((p) => p[0]));
  const max = Math.max(...points.map((p) => p[1])) || 1;
  const x = (at: number) => (t1 === t0 ? W / 2 : ((at - t0) / (t1 - t0)) * W);
  const y = (v: number) => H - 2 - (v / max) * (H - 6);
  const single = series.length === 1;
  const last = single ? series[0]!.points.at(-1)?.[1] : undefined;
  return (
    <figure>
      <figcaption className="flex items-baseline justify-between text-xs">
        <span className="text-fg-secondary">{title}</span>
        <span className="font-mono">{last !== undefined ? format(last) : t("twin:peak", { value: format(max) })}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 h-14 w-full" role="img" aria-label={title}>
        {series.map((s, i) => {
          const d = s.points.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
          const stroke = single ? "var(--accent-primary)" : seriesColor(i);
          return (
            <g key={s.name}>
              {single && <path d={`${d} L${x(s.points.at(-1)![0])},${H} L${x(s.points[0]![0])},${H} Z`} fill="var(--accent-primary-soft)" />}
              <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {!single && (
        <ul className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-fg-secondary">
          {series.slice(0, 8).map((s, i) => (
            <li key={s.name} className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: seriesColor(i) }} />
              <span className="max-w-32 truncate">{s.name || "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
