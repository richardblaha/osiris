import type { WebStats, WebTopRow } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { LineChart } from "./Telemetry.tsx";

const DAY = 86_400_000;
const RANGES = [
  { label: "24 h", ms: DAY },
  { label: "7 dní", ms: 7 * DAY },
  { label: "30 dní", ms: 30 * DAY },
  { label: "90 dní", ms: 90 * DAY },
  { label: "Rok", ms: 365 * DAY },
];

const SOURCES: Record<string, string> = { search: "vyhledávač", social: "sociální síť", referral: "odkaz", email: "e-mail", direct: "přímo" };
const DEVICES: Record<string, string> = { desktop: "počítač", mobile: "mobil", tablet: "tablet" };

/** A country's flag from its ISO code (regional indicator letters). */
const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
const n = (v: number) => v.toLocaleString("cs-CZ");

/**
 * Tenant > Návštěvnost: the tenant's sites' web analytics (web-events → ClickHouse), without cookies. Visitors are counted once
 * per day (the hash changes daily), so over a longer range they're visits by day rather than people.
 */
export function WebAnalytics() {
  const [site, setSite] = useState<string>();
  const [range, setRange] = useState(30 * DAY);
  const [stats, setStats] = useState<WebStats>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const to = Date.now();
    void attempt(setBusy, setError, async () => {
      const s = await api.analytics({ site, from: to - range, to });
      setStats(s);
      if (!site && s.sites[0]) setSite(s.sites[0]);
    });
  }, [site, range]);

  return (
    <div className="relative h-full overflow-y-auto">
      <Loading show={busy} />
      <div className="detail max-w-6xl space-y-6">
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="flex-1 text-lg font-semibold">Návštěvnost</h1>
          <label className="flex flex-col text-xs text-fg-secondary">
            Web
            <select value={site ?? ""} onChange={(e) => setSite(e.target.value)} className="field w-auto py-1 text-sm">
              {stats?.sites.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="flex overflow-hidden rounded-md border border-line-strong text-sm" role="group" aria-label="Období">
            {RANGES.map((r) => (
              <button key={r.ms} onClick={() => setRange(r.ms)} data-active={range === r.ms} className="list-row border-r border-line px-2 py-1 last:border-r-0">
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <ErrorNotice error={error} />
        {stats && !stats.sites.length && <p className="text-sm text-fg-muted">Zatím žádná data. Návštěvy webu se tu ukážou, až bude mít firma web s měřením návštěvnosti (skript /_e/e.js) přiřazený správcem Osirisu.</p>}
        {stats && !!stats.sites.length && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile label="Návštěvníci" value={stats.totals.visitors} hint="unikátní za den" />
              <Tile label="Zobrazení stránek" value={stats.totals.pageviews} />
              <Tile label="Události" value={stats.totals.events} />
            </div>
            {stats.series.length > 0 ? (
              <LineChart
                unit=""
                series={[
                  { name: "Zobrazení", points: stats.series.map((p) => [p.t, p.pageviews]) },
                  { name: "Návštěvníci", points: stats.series.map((p) => [p.t, p.visitors]) },
                ]}
              />
            ) : (
              <p className="text-sm text-fg-muted">V tomto období žádné návštěvy.</p>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
              <Top title="Stránky" rows={stats.pages} />
              <Top title="Zdroje návštěv" rows={stats.referrers} detail={(d) => SOURCES[d] ?? d} empty="Jen přímé návštěvy." />
              <Top title="Kampaně (UTM)" rows={stats.campaigns} detail={(d) => d} empty="Žádné odkazy s UTM." />
              <Top title="Země" rows={stats.countries} label={(k) => (k ? `${flag(k)} ${k}` : "neznámá")} />
              <Top title="Prohlížeče" rows={stats.browsers} />
              <Top title="Systémy" rows={stats.systems} />
              <Top title="Zařízení" rows={stats.devices} label={(k) => DEVICES[k] ?? k} />
              <Top title="Vlastní události" rows={stats.events} count="Počet" empty="Žádné (window.wa.event)." />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-md border border-line bg-sidebar px-4 py-3">
      <p className="text-xs text-fg-secondary">
        {label}
        {hint && <span className="text-fg-muted"> · {hint}</span>}
      </p>
      <p className="mt-1 text-2xl font-semibold">{n(value)}</p>
    </div>
  );
}

/** A breakdown as a table, each row with a bar for its share of the top row. */
function Top({
  title,
  rows,
  label = (k) => k || "—",
  detail,
  count = "Zobrazení",
  empty = "Nic.",
}: {
  title: string;
  rows: WebTopRow[];
  label?: (key: string) => string;
  detail?: (detail: string) => string;
  count?: string;
  empty?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.pageviews));
  return (
    <section>
      <h2 className="section-header">{title}</h2>
      {rows.length ? (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-xs text-fg-muted">
              <th className="py-1 text-left font-normal" />
              <th className="w-24 py-1 text-right font-normal">Návštěvníci</th>
              <th className="w-24 py-1 text-right font-normal">{count}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.key}\n${r.detail}`} className="border-t border-line">
                <td className="relative max-w-0 py-1 pr-2">
                  <span className="absolute inset-y-0.5 left-0 rounded-sm bg-primary-soft" style={{ width: `${(r.pageviews / max) * 100}%` }} aria-hidden="true" />
                  <span className="relative block truncate px-1" title={r.key}>
                    {label(r.key)}
                    {detail && r.detail && <span className="ml-2 text-xs text-fg-muted">{detail(r.detail)}</span>}
                  </span>
                </td>
                <td className="py-1 text-right font-mono text-xs">{n(r.visitors)}</td>
                <td className="py-1 text-right font-mono text-xs">{n(r.pageviews)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">{empty}</p>
      )}
    </section>
  );
}
