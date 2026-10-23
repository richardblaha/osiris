import type { WebStats, WebTopRow } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { LineChart } from "./Telemetry.tsx";
import { t } from "i18next";
import { currentLocale, formatNumber } from "./i18n.ts";

const DAY = 86_400_000;
const RANGES = [
  { key: "day", ms: DAY },
  { key: "week", ms: 7 * DAY },
  { key: "month", ms: 30 * DAY },
  { key: "quarter", ms: 90 * DAY },
  { key: "year", ms: 365 * DAY },
] as const;

const SOURCES = ["search", "social", "referral", "email", "direct"] as const;
const source = (d: string) => ((SOURCES as readonly string[]).includes(d) ? t(`analytics:sources.${d as (typeof SOURCES)[number]}`) : d);
const DEVICES = ["desktop", "mobile", "tablet"] as const;
const device = (k: string) => ((DEVICES as readonly string[]).includes(k) ? t(`analytics:devices.${k as (typeof DEVICES)[number]}`) : k);
/** A country by its ISO code, named in the reader's language. */
const country = (code: string) => {
  try {
    return new Intl.DisplayNames([currentLocale()], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** A country's flag from its ISO code (regional indicator letters). */
const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
const n = (v: number) => formatNumber(v);

/**
 * Project > Návštěvnost: the project's sites' web analytics (web-events → ClickHouse), without cookies. Visitors are counted once
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
          <h1 className="flex-1 text-lg font-semibold">{t("app:nav.analytics")}</h1>
          <label className="flex flex-col text-xs text-fg-secondary">
            {t("dashboards:columns.site")}
            <select value={site ?? ""} onChange={(e) => setSite(e.target.value)} className="field w-auto py-1 text-sm">
              {stats?.sites.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="flex overflow-hidden rounded-md border border-line-strong text-sm" role="group" aria-label={t("dashboards:range")}>
            {RANGES.map((r) => (
              <button key={r.ms} onClick={() => setRange(r.ms)} data-active={range === r.ms} className="list-row border-e border-line px-2 py-1 last:border-e-0">
                {t(`analytics:ranges.${r.key}`)}
              </button>
            ))}
          </div>
        </div>
        <ErrorNotice error={error} />
        {stats && !stats.sites.length && <p className="text-sm text-fg-muted">{t("analytics:empty")}</p>}
        {stats && !!stats.sites.length && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile label={t("dashboards:columns.visitors")} value={stats.totals.visitors} hint={t("analytics:uniquePerDay")} />
              <Tile label={t("analytics:pageviews")} value={stats.totals.pageviews} />
              <Tile label={t("dashboards:columns.events")} value={stats.totals.events} />
            </div>
            {stats.series.length > 0 ? (
              <LineChart
                unit=""
                series={[
                  { name: t("dashboards:columns.pageviews"), points: stats.series.map((p) => [p.t, p.pageviews]) },
                  { name: t("dashboards:columns.visitors"), points: stats.series.map((p) => [p.t, p.visitors]) },
                ]}
              />
            ) : (
              <p className="text-sm text-fg-muted">{t("analytics:noVisits")}</p>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
              <Top title={t("analytics:pages")} rows={stats.pages} />
              <Top title={t("analytics:referrers")} rows={stats.referrers} detail={source} empty={t("analytics:directOnly")} />
              <Top title={t("analytics:campaigns")} rows={stats.campaigns} detail={(d) => d} empty={t("analytics:noCampaigns")} />
              <Top title={t("dashboards:panels.countries")} rows={stats.countries} label={(k) => (k ? `${flag(k)} ${country(k)}` : t("analytics:unknown"))} />
              <Top title={t("analytics:regions")} rows={stats.regions ?? []} detail={(v) => v} />
              <Top title={t("analytics:cities")} rows={stats.cities ?? []} detail={(v) => v} />
              <Top title={t("analytics:networks")} rows={stats.networks ?? []} detail={(v) => v} />
              <Top title={t("analytics:browsers")} rows={stats.browsers} />
              <Top title={t("analytics:systems")} rows={stats.systems} />
              <Top title={t("analytics:devicesTitle")} rows={stats.devices} label={device} />
              <Top title={t("analytics:customEvents")} rows={stats.events} count={t("dashboards:columns.count")} empty={t("analytics:noEvents")} />
            </div>
          </>
        )}
        <p className="text-xs text-fg-muted">{t("analytics:approximate")} <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="btn-link">IP Geolocation by DB-IP</a></p>
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
  count = t("dashboards:columns.pageviews"),
  empty = t("analytics:nothing"),
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
              <th className="py-1 text-start font-normal" />
              <th className="w-24 py-1 text-end font-normal">{t("dashboards:columns.visitors")}</th>
              <th className="w-24 py-1 text-end font-normal">{count}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.key}\n${r.detail}`} className="border-t border-line">
                <td className="relative max-w-0 py-1 pe-2">
                  <span className="absolute inset-y-0.5 start-0 rounded-sm bg-primary-soft" style={{ width: `${(r.pageviews / max) * 100}%` }} aria-hidden="true" />
                  <span className="relative block truncate px-1" title={r.key}>
                    {label(r.key)}
                    {detail && r.detail && <span className="ms-2 text-xs text-fg-muted">{detail(r.detail)}</span>}
                  </span>
                </td>
                <td className="py-1 text-end font-mono text-xs">{n(r.visitors)}</td>
                <td className="py-1 text-end font-mono text-xs">{n(r.pageviews)}</td>
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
