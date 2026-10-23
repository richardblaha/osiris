import type { Integration } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api, getTenant } from "./api.ts";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { t } from "i18next";

const NAMES: Record<Integration["provider"], string> = { google: "Google", microsoft: "Microsoft" };

/** Where the browser goes back to after connecting an account: the tenant it was connected in. */
export const INTEGRATION_RETURN = "osiris.integrationReturn";

/**
 * The user's Google and Microsoft accounts the assistant may use. Connecting sends the browser to the provider, which
 * returns it to /integration-callback; the assistant then reads and sends mail, manages contacts and the calendar
 * only on the user's instructions.
 */
export function Integrations() {
  const [list, setList] = useState<Integration[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.integrations().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const connect = (provider: Integration["provider"]) =>
    attempt(setBusy, setError, async () => {
      const { authorizationUrl } = await api.connectIntegration(provider);
      try {
        sessionStorage.setItem(INTEGRATION_RETURN, JSON.stringify({ tenant: getTenant() }));
      } catch {
        // The callback still works, in the last tenant.
      }
      location.assign(authorizationUrl);
    });


  return (
    <section className="relative mt-8 min-h-24">
      <Loading show={!list && !error} />
      <h2 className="section-header">{t("integrations:title")}</h2>
      <p className="mt-1 text-xs text-fg-muted">
        {t("integrations:intro")}
      </p>
      <ErrorNotice error={error} />
      <ul className="mt-3 space-y-2 text-sm">
        {list?.map((i) => (
          <li key={i.provider} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{NAMES[i.provider]}</span>
              <span className="block text-xs text-fg-muted">{i.connected ? t("integrations:connected", { account: i.account ?? t("integrations:account") }) : t(`integrations:what.${i.provider}`)}</span>
            </span>
            <button disabled={busy} onClick={() => void connect(i.provider)} className="btn-secondary text-sm">
              {i.connected ? t("integrations:reconnect") : t("security:link")}
            </button>
            {i.connected && (
              <button disabled={busy} onClick={() => void attempt(setBusy, setError, async () => (await api.disconnectIntegration(i.provider), await load()))} className="btn-danger text-sm">
                {t("security:unlink")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <StandardIntegrations />
    </section>
  );
}

function StandardIntegrations() {
  const [accounts, setAccounts] = useState<{ name: string; kind: string }[]>([]);
  const [kind, setKind] = useState("mail");
  const [incoming, setIncoming] = useState("imap");
  const [smtp, setSmtp] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const load = () => api.standardAccounts().then(setAccounts);
  useEffect(() => { void load().catch((e: Error) => setError(e.message)); }, []);
  return <div className="mt-6 space-y-3">
    <h3 className="font-medium">{t("integrations:standardTitle")}</h3>
    <ErrorNotice error={error} />
    {accounts.map(a => <div key={a.name} className="flex items-center justify-between gap-3 text-sm">
      <span>{a.name} ({a.kind})</span>
      <button className="btn-danger" disabled={busy} onClick={() => void attempt(setBusy, setError, async () => { await api.deleteStandardAccount(a.name); await load(); })}>{t("security:unlink")}</button>
    </div>)}
    <form className="space-y-3" onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const value = (key: string) => String(values.get(key) ?? "");
      const endpoint = (prefix: string) => ({ host: value(`${prefix}Host`), port: Number(value(`${prefix}Port`)), username: value(`${prefix}User`), password: value(`${prefix}Password`) });
      const data = kind === "mail" ? { kind, from: value("from"),
        ...(smtp ? { smtp: { ...endpoint("smtp"), secure: value("smtpTls") === "implicit" } } : {}),
        ...(incoming ? { incoming: { ...endpoint("incoming"), protocol: incoming } } : {}) }
        : { kind, url: value("url"), username: value("username"), password: value("password") };
      void attempt(setBusy, setError, async () => { await api.saveStandardAccount(value("name"), data); form.reset(); await load(); });
    }}>
      <label className="block text-sm">{t("integrations:kind")}
        <select className="field w-full" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="mail">{t("tools:groups.mail")}</option><option value="caldav">{t("tools:groups.caldav")}</option><option value="carddav">{t("tools:groups.carddav")}</option>
        </select>
      </label>
      <label className="block text-sm">{t("integrations:name")}<input className="field w-full" name="name" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} placeholder={t("integrations:namePlaceholder")} /></label>
      {kind === "mail" ? <>
        <label className="block text-sm">{t("integrations:from")}<input className="field w-full" name="from" type="email" required /></label>
        <label className="block text-sm"><input type="checkbox" checked={smtp} onChange={e => setSmtp(e.target.checked)} /> {t("integrations:smtp")}</label>
        {smtp && <>
          <EndpointFields prefix="smtp" port={465} />
          <label className="block text-sm">{t("integrations:smtpTls")}<select className="field w-full" name="smtpTls"><option value="implicit">{t("integrations:implicitTls")}</option><option value="starttls">{t("integrations:starttls")}</option></select></label>
        </>}
        <label className="block text-sm">{t("integrations:incoming")}<select className="field w-full" value={incoming} onChange={e => setIncoming(e.target.value)}><option value="imap">{t("integrations:imap")}</option><option value="pop3">{t("integrations:pop3")}</option><option value="">{t("integrations:noIncoming")}</option></select></label>
        {incoming && <EndpointFields key={incoming} prefix="incoming" port={incoming === "imap" ? 993 : 995} />}
      </> : <>
        <label className="block text-sm">{t("integrations:url")}<input className="field w-full" name="url" type="url" required placeholder="https://cloud.example.cz/remote.php/dav/" /></label>
        <label className="block text-sm">{t("integrations:username")}<input className="field w-full" name="username" required autoComplete="off" /></label>
        <label className="block text-sm">{t("integrations:password")}<input className="field w-full" name="password" type="password" required autoComplete="new-password" /></label>
      </>}
      <button className="btn-primary" disabled={busy || (kind === "mail" && !smtp && !incoming)}>{t("integrations:connect")}</button>
    </form>
  </div>;
}

function EndpointFields({ prefix, port }: { prefix: string; port: number }) {
  return <fieldset className="space-y-2 rounded border border-border p-3">
    <label className="block text-sm">{t("integrations:server")}<input className="field w-full" name={`${prefix}Host`} required /></label>
    <label className="block text-sm">{t("integrations:port")}<input className="field w-full" name={`${prefix}Port`} type="number" min={1} max={65535} defaultValue={port} required /></label>
    <label className="block text-sm">{t("integrations:username")}<input className="field w-full" name={`${prefix}User`} required autoComplete="off" /></label>
    <label className="block text-sm">{t("integrations:password")}<input className="field w-full" name={`${prefix}Password`} type="password" required autoComplete="new-password" /></label>
  </fieldset>;
}
