import type { AccountActivity as Activity, LoginEvent, LoginSession } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "@osiris/client/api.ts";
import { attempt, ErrorNotice, Pending } from "./Scope.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { formatDateTime } from "./i18n.ts";

const time = (value: number) => (value ? formatDateTime(value, { dateStyle: "medium", timeStyle: "medium" }) : t("activity:unknownTime"));
const location = (row: LoginEvent | LoginSession) => [row.city, row.region, row.country].filter(Boolean).join(", ") || t("activity:unknownLocation");
/** Sign-in methods (OIDC `amr` values) by name. */
const METHODS = ["pwd", "otp", "kba", "hwk", "user", "email", "link", "ext"] as const;
const method = (m: string) => ((METHODS as readonly string[]).includes(m) ? t(`activity:methods.${m as (typeof METHODS)[number]}`) : m);
const DELIVERY = ["accepted", "sent", "delivered", "read", "failed"] as const;
const delivery = (s: string) => ((DELIVERY as readonly string[]).includes(s) ? t(`activity:delivery.${s as (typeof DELIVERY)[number]}`) : s);

/** WhatsApp's delivery reports for the user's verified number (control keeps them; the PWA's Profile > Activity). */
export function WhatsAppDeliveries() {
  const [deliveries, setDeliveries] = useState<{ status: string; at: number }[]>();
  const [error, setError] = useState<string>();
  useEffect(() => void api.security.whatsappDeliveries().then(setDeliveries, (e: Error) => setError(e.message)), []);
  return <section className="space-y-3">
    <h2 className="section-header">{t("activity:deliveries")}</h2>
    <ErrorNotice error={error} />
    {!deliveries && !error && <Pending />}
    <ul className="divide-y divide-line">{deliveries?.map((d, i) => <li key={i} className="py-2 text-sm">{time(d.at)} · {delivery(d.status)}</li>)}</ul>
  </section>;
}

/** Sign-ins and sessions, on osiris-auth's account page (its session cookie says who). */
export function AccountActivity() {
  const [data, setData] = useState<Activity>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => setData(await api.security.activity());
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, []);
  const revoke = (session: LoginSession) => attempt(setBusy, setError, async () => {
    await api.security.revokeSession(session.id);
    if (session.current) window.location.assign("/logout?client_id=osiris-account");
    else await load();
  });
  return <section className="space-y-6">
    <h1 className="text-lg font-semibold">{t("profile:parts.activity")}</h1>
    <p className="text-sm text-fg-secondary">{t("activity:intro", { days: 90 })}</p>
    <ErrorNotice error={error} />
    {!data && !error && <Pending />}
    {data && <>
      <section>
        <h2 className="section-header">{t("activity:sessions")}</h2>
        <ul className="mt-2 divide-y divide-line">
          {data.sessions.map(session => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{session.browser} · {session.os} {session.current && <span className="badge">{t("activity:thisSession")}</span>}</p>
              <p>{location(session)} · {session.ip || t("activity:unknownIp")}</p>
              <p className="text-xs text-fg-muted">{[session.asn, session.network].filter(Boolean).join(" · ")}</p>
              <p className="text-xs text-fg-secondary">{t("activity:sessionTimes", { signedIn: time(session.at), lastSeen: time(session.lastSeenAt) })}</p>
            </div>
            <button className="btn-danger text-sm" disabled={busy} onClick={() => void revoke(session)}>{session.current ? t("activity:signOutThis") : t("app:signOut")}</button>
          </li>)}
          {!data.sessions.length && <li className="py-3 text-sm text-fg-muted">{t("activity:noSessions")}</li>}
        </ul>
      </section>
      <section>
        <h2 className="section-header">{t("activity:history")}</h2>
        <ul className="mt-2 divide-y divide-line">
          {data.events.map(event => <li key={event.id} className="space-y-1 py-3 text-sm">
            <p><span className={event.success ? "text-success" : "text-error"}>{event.success ? t("activity:success") : t("activity:failure")}</span> · {time(event.at)} · {event.method.split("+").map(method).join(" + ")}</p>
            <p>{location(event)} · {event.ip || t("activity:unknownIp")}</p>
            <p className="text-xs text-fg-secondary">{[event.browser, event.os, event.device, event.asn, event.network].filter(Boolean).join(" · ")}</p>
          </li>)}
          {!data.events.length && <li className="py-3 text-sm text-fg-muted">{t("activity:noEvents")}</li>}
        </ul>
      </section>
    </>}
    <p className="text-xs text-fg-muted"><Trans ns="activity" i18nKey="footer" components={{ a: <a className="btn-link" href="https://db-ip.com" target="_blank" rel="noreferrer" /> }} /></p>
  </section>;
}
