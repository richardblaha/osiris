import type { LogRecord, MetricInfo, MetricSeries, SpanRecord, TelemetryFacets, TraceSummary } from "@osiris/shared";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";

const RANGES = [
  { label: "15 min", ms: 15 * 60_000 },
  { label: "1 hod", ms: 3_600_000 },
  { label: "6 hod", ms: 6 * 3_600_000 },
  { label: "24 hod", ms: 24 * 3_600_000 },
  { label: "7 dní", ms: 7 * 24 * 3_600_000 },
];

const time = (ms: number, withDate = false) =>
  new Date(ms).toLocaleString("cs-CZ", withDate ? { dateStyle: "short", timeStyle: "medium" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const duration = (ms: number) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** The range to query: the last `ms` up to now, recomputed on every load. */
const lastMs = (ms: number) => ({ from: Date.now() - ms, to: Date.now() });

/** Range and filters in one row above the results; `onRefresh` reloads (also every 30 s with auto). */
function Toolbar({ range, setRange, children, onRefresh, busy }: { range: number; setRange: (ms: number) => void; children?: ReactNode; onRefresh: () => void; busy: boolean }) {
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
      <div className="flex overflow-hidden rounded-md border border-line-strong" role="group" aria-label="Časový rozsah">
        {RANGES.map((r) => (
          <button key={r.ms} type="button" onClick={() => setRange(r.ms)} data-active={range === r.ms} className="list-row border-r border-line px-2 py-1 last:border-r-0">
            {r.label}
          </button>
        ))}
      </div>
      {children}
      <span className="flex-1" />
      <label className="flex items-center gap-1 text-xs text-fg-secondary">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> obnovovat
      </label>
      <button type="button" onClick={onRefresh} disabled={busy} className="btn-secondary py-1 text-sm">
        {busy ? "Načítám…" : "Obnovit"}
      </button>
    </div>
  );
}

function useFacets(range: number) {
  const [facets, setFacets] = useState<TelemetryFacets>({ services: [], namespaces: [] });
  useEffect(() => void api.admin.telemetry.facets(lastMs(Math.max(range, 24 * 3_600_000))).then(setFacets, () => {}), [range]);
  return facets;
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="flex flex-col text-xs text-fg-secondary">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field w-auto max-w-48 py-1 text-sm">
        <option value="">vše</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function Attributes({ title, values }: { title: string; values: Record<string, string> }) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
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

const SEVERITY_CLASS = (n: number) => (n >= 17 ? "text-error" : n >= 13 ? "text-warning" : n >= 9 ? "text-fg" : "text-fg-muted");

/** The cluster's log records, newest first, with filters; a record opens with its attributes and its trace. */
export function Logs({ onOpenTrace, traceId: initialTrace }: { onOpenTrace: (id: string) => void; traceId?: string }) {
  const [range, setRange] = useState(3_600_000);
  const [service, setService] = useState("");
  const [namespace, setNamespace] = useState("");
  const [severity, setSeverity] = useState("");
  const [q, setQ] = useState("");
  const [traceId, setTraceId] = useState(initialTrace ?? "");
  const [logs, setLogs] = useState<LogRecord[]>();
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const facets = useFacets(range);
  const filters = () => ({ ...lastMs(range), service, namespace, severity, q, traceId: traceId || undefined, limit: 200 });

  const load = () =>
    attempt(setBusy, setError, async () => {
      const list = await api.admin.telemetry.logs(filters());
      setLogs(list);
      setMore(list.length === 200);
      setOpen(undefined);
    });
  const older = () =>
    attempt(setBusy, setError, async () => {
      const last = logs?.at(-1);
      if (!last) return;
      const list = await api.admin.telemetry.logs({ ...filters(), to: last.ts - 1 });
      setLogs([...(logs ?? []), ...list]);
      setMore(list.length === 200);
    });
  useEffect(() => void load(), [range, service, namespace, severity, traceId]);
  const search = (e: FormEvent) => (e.preventDefault(), void load());

  return (
    <div className="flex h-full flex-col">
      <Toolbar range={range} setRange={setRange} onRefresh={() => void load()} busy={busy}>
        <Select label="Služba" value={service} onChange={setService} options={facets.services} />
        <Select label="Namespace" value={namespace} onChange={setNamespace} options={facets.namespaces} />
        <label className="flex flex-col text-xs text-fg-secondary">
          Závažnost
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="field w-auto py-1 text-sm">
            <option value="">vše</option>
            <option value="info">info a vyšší</option>
            <option value="warn">varování a vyšší</option>
            <option value="error">chyby</option>
          </select>
        </label>
        <form onSubmit={search} className="flex flex-col text-xs text-fg-secondary">
          Hledat v textu
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="např. timeout" className="field w-56 py-1 text-sm" />
        </form>
        {traceId && (
          <button type="button" onClick={() => setTraceId("")} className="badge self-center" title="Zrušit filtr trasy">
            trasa {traceId.slice(0, 8)}… ×
          </button>
        )}
      </Toolbar>
      <div className="relative min-h-0 flex-1">
        <Loading show={busy} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <ul className="font-mono text-xs">
            {logs?.map((l, i) => (
              <li key={`${l.ts}:${i}`} className="border-b border-line">
                <button onClick={() => setOpen(open === i ? undefined : i)} data-active={open === i} className="list-row flex w-full gap-3 px-1 py-1 text-left">
                  <span className="shrink-0 text-fg-muted">{time(l.ts, range > 24 * 3_600_000)}</span>
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
                        Otevřít trasu {l.traceId}
                      </button>
                    )}
                    <Attributes title="Atributy" values={l.attributes} />
                    <Attributes title="Zdroj" values={l.resource} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {logs && !logs.length && <p className="py-4 text-sm text-fg-muted">Žádné záznamy v tomto rozsahu.</p>}
          {more && (
            <button onClick={() => void older()} disabled={busy} className="btn-secondary mt-3 text-sm">
              Načíst starší
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Traces by their root span; one opens as a waterfall of its spans, with its logs. */
export function Traces({ traceId, onOpenTrace, onOpenLogs }: { traceId?: string; onOpenTrace: (id?: string) => void; onOpenLogs: (traceId: string) => void }) {
  const [range, setRange] = useState(3_600_000);
  const [service, setService] = useState("");
  const [q, setQ] = useState("");
  const [minMs, setMinMs] = useState("");
  const [errors, setErrors] = useState(false);
  const [list, setList] = useState<TraceSummary[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const facets = useFacets(range);

  const load = () =>
    attempt(setBusy, setError, async () =>
      setList(await api.admin.telemetry.traces({ ...lastMs(range), service, q, minMs: minMs ? Number(minMs) : undefined, errors })),
    );
  useEffect(() => void load(), [range, service, errors]);

  if (traceId) return <TraceView traceId={traceId} onBack={() => onOpenTrace(undefined)} onOpenLogs={onOpenLogs} />;
  return (
    <div className="flex h-full flex-col">
      <Toolbar range={range} setRange={setRange} onRefresh={() => void load()} busy={busy}>
        <Select label="Služba" value={service} onChange={setService} options={facets.services} />
        <form onSubmit={(e) => (e.preventDefault(), void load())} className="flex items-end gap-2">
          <label className="flex flex-col text-xs text-fg-secondary">
            Název
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="např. POST /api" className="field w-48 py-1 text-sm" />
          </label>
          <label className="flex flex-col text-xs text-fg-secondary">
            Delší než (ms)
            <input type="number" min={0} value={minMs} onChange={(e) => setMinMs(e.target.value)} className="field w-24 py-1 text-sm" />
          </label>
          <button className="btn-secondary py-1 text-sm">Hledat</button>
        </form>
        <label className="flex items-center gap-1 self-center text-xs text-fg-secondary">
          <input type="checkbox" checked={errors} onChange={(e) => setErrors(e.target.checked)} /> jen chyby
        </label>
      </Toolbar>
      <div className="relative min-h-0 flex-1">
        <Loading show={busy} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-muted">
              <tr>
                <th className="py-1 font-normal">Čas</th>
                <th className="py-1 font-normal">Služba</th>
                <th className="py-1 font-normal">Název</th>
                <th className="py-1 text-right font-normal">Trvání</th>
                <th className="py-1 text-right font-normal">Spanů</th>
              </tr>
            </thead>
            <tbody>
              {list?.map((t) => (
                <tr key={t.traceId} onClick={() => onOpenTrace(t.traceId)} className="list-row cursor-pointer border-t border-line">
                  <td className="py-1 pr-3 font-mono text-xs whitespace-nowrap text-fg-muted">{time(t.ts, range > 24 * 3_600_000)}</td>
                  <td className="py-1 pr-3 text-fg-secondary">{t.service}</td>
                  <td className="py-1 pr-3">
                    {t.error && <span className="mr-1 text-error" aria-label="chyba">●</span>}
                    {t.name}
                  </td>
                  <td className="py-1 pr-3 text-right font-mono text-xs">{duration(t.durationMs)}</td>
                  <td className="py-1 text-right text-fg-muted">{t.spans}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list && !list.length && <p className="py-4 text-sm text-fg-muted">Žádné trasy v tomto rozsahu.</p>}
        </div>
      </div>
    </div>
  );
}

function TraceView({ traceId, onBack, onOpenLogs }: { traceId: string; onBack: () => void; onOpenLogs: (traceId: string) => void }) {
  const [spans, setSpans] = useState<SpanRecord[]>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.admin.telemetry.trace(traceId).then(setSpans, (e: Error) => setError(e.message)), [traceId]);

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
          ← Trasy
        </button>
        <code className="text-xs">{traceId}</code>
        {rows.length > 0 && (
          <span className="text-fg-secondary">
            {rows.length} spanů · {duration(total)} · {time(start, true)}
          </span>
        )}
        <span className="flex-1" />
        <button onClick={() => onOpenLogs(traceId)} className="btn-secondary py-1 text-sm">
          Logy trasy
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <Loading show={!spans && !error} />
        <div className="h-full overflow-y-auto px-6 py-2">
          <ErrorNotice error={error} />
          <ul className="text-xs">
            {rows.map(({ span: s, depth }) => (
              <li key={s.spanId} className="border-b border-line">
                <button onClick={() => setOpen(open === s.spanId ? undefined : s.spanId)} data-active={open === s.spanId} className="list-row flex w-full items-center gap-3 px-1 py-1 text-left">
                  <span className="w-80 shrink-0 truncate" style={{ paddingLeft: depth * 12 }} title={`${s.service}: ${s.name}`}>
                    {s.error && <span className="mr-1 text-error" aria-label="chyba">●</span>}
                    <span className="text-fg-muted">{s.service}</span> {s.name}
                  </span>
                  <span className="relative h-3 min-w-0 flex-1">
                    <span
                      className={`absolute top-0 h-3 rounded-sm ${s.error ? "bg-error" : "bg-primary"}`}
                      style={{ left: `${((s.startMs - start) / total) * 100}%`, width: `max(2px, ${(s.durationMs / total) * 100}%)` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono">{duration(s.durationMs)}</span>
                </button>
                {open === s.spanId && (
                  <div className="px-1 pb-2">
                    <p className="text-fg-secondary">
                      {s.kind} · začátek +{duration(s.startMs - start)}
                      {s.statusMessage && <span className="text-error"> · {s.statusMessage}</span>}
                    </p>
                    <Attributes title="Atributy" values={s.attributes} />
                    <Attributes title="Zdroj" values={s.resource} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {spans && !spans.length && <p className="py-4 text-sm text-fg-muted">Trasa nemá žádné spany (možná už vypršela).</p>}
        </div>
      </div>
    </div>
  );
}

const GROUPS = ["", "k8s.pod.name", "k8s.namespace.name", "k8s.node.name", "k8s.container.name", "service.name", "http.route", "http.response.status_code"];
const TYPE_LABEL: Record<MetricInfo["type"], string> = { gauge: "hodnota", sum: "za sekundu", histogram: "průměr" };

/** Metrics by name on the left; the chosen one as a line chart (a line per group) with a table view. */
export function Metrics() {
  const [range, setRange] = useState(3_600_000);
  const [filter, setFilter] = useState("");
  const [metrics, setMetrics] = useState<MetricInfo[]>();
  const [chosen, setChosen] = useState<MetricInfo>();
  const [groupBy, setGroupBy] = useState("k8s.pod.name");
  const [data, setData] = useState<{ step: number; series: MetricSeries[] }>();
  const [table, setTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadList = () => attempt(setBusy, setError, async () => setMetrics(await api.admin.telemetry.metrics(lastMs(Math.max(range, 3_600_000)))));
  const loadSeries = () =>
    chosen && attempt(setBusy, setError, async () => setData(await api.admin.telemetry.series({ ...lastMs(range), name: chosen.name, type: chosen.type, groupBy })));
  useEffect(() => void loadList(), []);
  useEffect(() => void loadSeries(), [chosen, groupBy, range]);
  const shown = metrics?.filter((m) => m.name.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <div className="flex h-full">
      <nav className="flex w-80 shrink-0 flex-col border-r border-line p-2 text-sm">
        <h2 className="section-header px-2 py-1">Metriky</h2>
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Hledat metriku" className="field mx-1 mt-1 w-auto py-1 text-sm" />
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {shown.map((m) => (
            <button
              key={`${m.type}:${m.name}`}
              onClick={() => (setChosen(m), setData(undefined))}
              data-active={chosen?.name === m.name && chosen.type === m.type}
              className="list-row block w-full px-2 py-1 text-left"
              title={m.description || m.name}
            >
              <span className="block truncate font-mono text-xs">{m.name}</span>
              <span className="block truncate text-xs text-fg-muted">
                {m.type}
                {m.unit && ` · ${m.unit}`}
              </span>
            </button>
          ))}
          {metrics && !shown.length && <p className="px-2 py-1 text-fg-muted">Nic.</p>}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar range={range} setRange={setRange} onRefresh={() => void (chosen ? loadSeries() : loadList())} busy={busy}>
          <label className="flex flex-col text-xs text-fg-secondary">
            Rozdělit podle
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="field w-auto py-1 text-sm">
              {GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g || "nerozdělovat"}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 self-center text-xs text-fg-secondary">
            <input type="checkbox" checked={table} onChange={(e) => setTable(e.target.checked)} /> tabulka
          </label>
        </Toolbar>
        <div className="relative min-h-0 flex-1">
          <Loading show={busy} />
          <div className="h-full overflow-y-auto px-6 py-4">
            <ErrorNotice error={error} />
            {!chosen ? (
              <p className="text-sm text-fg-muted">Vyber metriku vlevo.</p>
            ) : (
              <>
                <h1 className="font-mono text-base font-semibold">{chosen.name}</h1>
                <p className="text-xs text-fg-secondary">
                  {chosen.description}
                  {chosen.description && " · "}
                  {TYPE_LABEL[chosen.type]}
                  {chosen.unit && ` (${chosen.unit}${chosen.type === "sum" ? "/s" : ""})`}
                  {data && ` · krok ${data.step >= 3600 ? `${data.step / 3600} h` : `${data.step / 60} min`}`}
                </p>
                {data && !data.series.length && <p className="mt-4 text-sm text-fg-muted">V tomto rozsahu žádná data.</p>}
                {data && data.series.length > 0 && (table ? <SeriesTable data={data.series} /> : <LineChart series={data.series} unit={chosen.unit} />)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const color = (i: number) => `var(--series-${(i % 8) + 1})`;
const number = (v: number) =>
  Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(1)} G` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(1)} k` : v.toLocaleString("cs-CZ", { maximumFractionDigits: 2 });

/** "Nice" ticks across [0, max]. */
function ticks(max: number, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

/**
 * Lines over time, one per series in fixed palette order (at most eight; the server sends the busiest). A crosshair
 * shows every series' value at the nearest time; a legend names them (with two to four also at the line ends).
 */
function LineChart({ series, unit }: { series: MetricSeries[]; unit: string }) {
  const lines = series.slice(0, 8);
  const [hover, setHover] = useState<number>();
  const W = 800;
  const H = 280;
  const pad = { l: 56, r: lines.length > 1 && lines.length <= 4 ? 110 : 12, t: 12, b: 24 };
  const times = [...new Set(lines.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
  const t0 = times[0]!;
  const t1 = times.at(-1)!;
  const yTicks = ticks(Math.max(...lines.flatMap((s) => s.points.map((p) => p[1]))));
  const yMax = yTicks.at(-1)!;
  const x = (t: number) => pad.l + (t1 === t0 ? (W - pad.l - pad.r) / 2 : ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const xTicks = times.length > 1 ? Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4) : [t0];
  const label = (t: number) => new Date(t).toLocaleString("cs-CZ", t1 - t0 > 2 * 86_400_000 ? { day: "numeric", month: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

  const svg = useRef<SVGSVGElement>(null);
  const onMove = (e: React.PointerEvent) => {
    const box = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(x(times[i]!) - px) < Math.abs(x(times[best]!) - px)) best = i;
    setHover(times[best]);
  };
  const at = (s: MetricSeries, t: number) => s.points.find((p) => p[0] === t)?.[1];

  return (
    <figure className="mt-4">
      <div className="relative">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Graf ${lines.length} řad`} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border-subtle)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--text-muted)">
                {number(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
              {label(t)}
            </text>
          ))}
          {lines.map((s, i) => (
            <polyline
              key={s.name}
              points={s.points.map(([t, v]) => `${x(t)},${y(v)}`).join(" ")}
              fill="none"
              stroke={color(i)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {lines.length > 1 &&
            lines.length <= 4 &&
            lines.map((s, i) => {
              const last = s.points.at(-1);
              return (
                last && (
                  <text key={s.name} x={x(last[0]) + 6} y={y(last[1])} dominantBaseline="middle" fontSize={11} fill="var(--text-secondary)">
                    {(s.name || "—").slice(0, 16)}
                  </text>
                )
              );
            })}
          {hover !== undefined && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" />
              {lines.map((s, i) => {
                const v = at(s, hover);
                return v === undefined ? null : <circle key={s.name} cx={x(hover)} cy={y(v)} r={4} fill={color(i)} stroke="var(--bg-editor)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {hover !== undefined && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-md border border-line bg-canvas px-2 py-1 text-xs shadow-[var(--shadow-popup)]"
            style={x(hover) > W / 2 ? { right: `${100 - (x(hover) / W) * 100 + 1}%` } : { left: `${(x(hover) / W) * 100 + 1}%` }}
          >
            <p className="text-fg-secondary">{new Date(hover).toLocaleString("cs-CZ")}</p>
            {lines.map((s, i) => {
              const v = at(s, hover);
              return (
                v !== undefined && (
                  <p key={s.name} className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: color(i) }} />
                    <span className="max-w-56 truncate">{s.name || "hodnota"}</span>
                    <span className="ml-auto pl-3 font-mono">
                      {number(v)}
                      {unit && ` ${unit}`}
                    </span>
                  </p>
                )
              );
            })}
          </div>
        )}
      </div>
      {lines.length > 1 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-secondary">
          {lines.map((s, i) => (
            <li key={s.name} className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4 rounded-md" style={{ background: color(i) }} />
              {s.name || "—"}
            </li>
          ))}
        </ul>
      )}
      {series.length > 8 && <figcaption className="mt-1 text-xs text-fg-muted">Zobrazeno 8 nejčetnějších z {series.length}.</figcaption>}
    </figure>
  );
}

function SeriesTable({ data }: { data: MetricSeries[] }) {
  const times = [...new Set(data.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a);
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="text-xs">
        <thead>
          <tr className="text-left text-fg-muted">
            <th className="py-1 pr-4 font-normal">Čas</th>
            {data.map((s) => (
              <th key={s.name} className="py-1 pr-4 font-normal">
                {s.name || "hodnota"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {times.map((t) => (
            <tr key={t} className="border-t border-line">
              <td className="py-0.5 pr-4 whitespace-nowrap text-fg-muted">{new Date(t).toLocaleString("cs-CZ")}</td>
              {data.map((s) => {
                const v = s.points.find((p) => p[0] === t)?.[1];
                return (
                  <td key={s.name} className="py-0.5 pr-4 text-right">
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
