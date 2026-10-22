import type { AccountActivity as Activity, LoginEvent, LoginSession } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { logout } from "./auth.ts";
import { attempt, ErrorNotice, Pending } from "./Scope.tsx";

const time = (value: number) => value ? new Date(value).toLocaleString("cs-CZ") : "neznámý čas";
const location = (row: LoginEvent | LoginSession) => [row.city, row.region, row.country].filter(Boolean).join(", ") || "neznámá lokalita";
const methods: Record<string, string> = { pwd: "Heslo", otp: "Ověřovací kód", kba: "Záložní kód", hwk: "Passkey", user: "Ověření uživatele", email: "E-mailový odkaz" };

export function AccountActivity() {
  const [data, setData] = useState<Activity>();
  const [deliveries, setDeliveries] = useState<{ status: string; at: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => { const [activity, sent] = await Promise.all([api.security.activity(), api.security.whatsappDeliveries()]); setData(activity); setDeliveries(sent); };
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, []);
  const revoke = (session: LoginSession) => attempt(setBusy, setError, async () => {
    await api.security.revokeSession(session.id);
    if (session.current) await logout();
    else await load();
  });
  return <section className="space-y-6">
    <h1 className="text-lg font-semibold">Aktivita a relace</h1>
    <p className="text-sm text-fg-secondary">Historie přihlášení za posledních 90 dní. Lokalita je přibližná; mobilní sítě a VPN ji mohou zkreslit.</p>
    <ErrorNotice error={error} />
    {!data && !error && <Pending />}
    {data && <>
      <section>
        <h2 className="section-header">Aktivní relace</h2>
        <ul className="mt-2 divide-y divide-line">
          {data.sessions.map(session => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{session.browser} · {session.os} {session.current && <span className="badge">Tato relace</span>}</p>
              <p>{location(session)} · {session.ip || "neznámá IP"}</p>
              <p className="text-xs text-fg-muted">{[session.asn, session.network].filter(Boolean).join(" · ")}</p>
              <p className="text-xs text-fg-secondary">Přihlášení {time(session.at)} · Poslední aktivita {time(session.lastSeenAt)}</p>
            </div>
            <button className="btn-danger text-sm" disabled={busy} onClick={() => void revoke(session)}>Odhlásit{session.current ? " tuto relaci" : ""}</button>
          </li>)}
          {!data.sessions.length && <li className="py-3 text-sm text-fg-muted">Žádné aktivní relace.</li>}
        </ul>
      </section>
      <section>
        <h2 className="section-header">Historie přihlášení</h2>
        <ul className="mt-2 divide-y divide-line">
          {data.events.map(event => <li key={event.id} className="space-y-1 py-3 text-sm">
            <p><span className={event.success ? "text-success" : "text-error"}>{event.success ? "Úspěšné" : "Neúspěšné"}</span> · {time(event.at)} · {event.method.split("+").map(m => methods[m] ?? m).join(" + ")}</p>
            <p>{location(event)} · {event.ip || "neznámá IP"}</p>
            <p className="text-xs text-fg-secondary">{[event.browser, event.os, event.device, event.asn, event.network].filter(Boolean).join(" · ")}</p>
          </li>)}
          {!data.events.length && <li className="py-3 text-sm text-fg-muted">Zatím žádné záznamy.</li>}
        </ul>
      </section>
    </>}
    {!!deliveries.length && <section>
      <h2 className="section-header">Doručení zpráv na WhatsApp</h2>
      <ul className="mt-2 divide-y divide-line">{deliveries.map((d, i) => <li key={i} className="py-2 text-sm">{time(d.at)} · {({ accepted: "Přijato k odeslání", sent: "Odesláno", delivered: "Doručeno", read: "Přečteno", failed: "Odeslání selhalo" } as Record<string, string>)[d.status] ?? d.status}</li>)}</ul>
    </section>}
    <p className="text-xs text-fg-muted">Geolokace: <a className="btn-link" href="https://db-ip.com" target="_blank" rel="noreferrer">DB-IP</a>. Odhlášení relace se na ostatních zařízeních projeví nejpozději po obnovení ověření přístupu (do jedné minuty).</p>
  </section>;
}
