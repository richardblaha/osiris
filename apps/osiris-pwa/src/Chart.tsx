import type { MetricSeries } from "@osiris/shared";
import { useRef, useState } from "react";
import { t } from "i18next";
import { formatDateTime, formatNumber } from "./i18n.ts";

const color = (i: number) => `var(--series-${(i % 8) + 1})`;
const number = (v: number) =>
  Math.abs(v) >= 1e4 ? formatNumber(v, { notation: "compact", maximumFractionDigits: 1 }) : formatNumber(v, { maximumFractionDigits: 2 });

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
export function LineChart({ series, unit }: { series: MetricSeries[]; unit: string }) {
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
  const label = (at: number) => formatDateTime(at, t1 - t0 > 2 * 86_400_000 ? { day: "numeric", month: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

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
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("dashboards:chart", { count: lines.length })} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border-subtle)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--text-muted)">
                {number(v)}
              </text>
            </g>
          ))}
          {xTicks.map((at) => (
            <text key={at} x={x(at)} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
              {label(at)}
            </text>
          ))}
          {lines.map((s, i) => (
            <polyline
              key={s.name}
              points={s.points.map(([at, v]) => `${x(at)},${y(v)}`).join(" ")}
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
            <p className="text-fg-secondary">{formatDateTime(hover, { dateStyle: "short", timeStyle: "medium" })}</p>
            {lines.map((s, i) => {
              const v = at(s, hover);
              return (
                v !== undefined && (
                  <p key={s.name} className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: color(i) }} />
                    <span className="max-w-56 truncate">{s.name || t("dashboards:columns.value")}</span>
                    <span className="ms-auto ps-3 font-mono">
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
      {series.length > 8 && <figcaption className="mt-1 text-xs text-fg-muted">{t("dashboards:topSeries", { shown: 8, count: series.length })}</figcaption>}
    </figure>
  );
}
