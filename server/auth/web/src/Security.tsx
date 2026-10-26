import type { SecurityOverview, SocialProvider } from "@osiris/shared";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field, Pending } from "./ui.tsx";
import { SOCIAL_LABELS } from "./SignIn.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { formatDate as date } from "./i18n.ts";

/** A QR code as SVG squares, for the authenticator app to scan. */
function Qr({ text }: { text: string }) {
  const { data, size } = encode(text, { border: 2 });
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-44 w-44 rounded-md bg-white" shapeRendering="crispEdges" role="img" aria-label={t("security:qr")}>
      <path d={path} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="notice space-y-3 px-3 py-3 text-sm">
      <p>
        <Trans ns="security" i18nKey="recoveryIntro" components={{ strong: <strong /> }} />
      </p>
      <pre className="grid grid-cols-2 gap-1 font-mono">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
      <div className="flex gap-3">
        <button onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))} className="btn-secondary">
          {t("copy")}
        </button>
        <button onClick={onDone} className="btn-primary">
          {t("security:recoverySaved")}
        </button>
      </div>
    </div>
  );
}

/**
 * How the user signs in: passkeys, password, linked Google/Facebook/Microsoft/Seznam accounts and the authenticator app
 * as a second factor. `notice` comes back from linking a social account (`?linked=` / `?error=`).
 */
export type SecurityPart = "passkeys" | "password" | "totp" | "linked";

const partTitle = (part: SecurityPart) => t(`security:titles.${part}`);

/** One part of the user's sign-in methods: passkeys, the password, the authenticator app or linked accounts. */
export function Security({ part, notice }: { part: SecurityPart; notice?: { linked?: string; error?: string } }) {
  const [s, setS] = useState<SecurityOverview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice?.error);
  const [saved, setSaved] = useState(notice?.linked ? t("security:linked", { provider: SOCIAL_LABELS[notice.linked as SocialProvider] ?? notice.linked }) : undefined);
  const [passwords, setPasswords] = useState({ current: "", next: "", again: "" });
  const [totpSetup, setTotpSetup] = useState<{ secret: string; url: string }>();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>();

  useEffect(() => void api.security.get().then(setS, (e: Error) => setError(e.message)), []);
  const act = (action: () => Promise<unknown>, message?: string) =>
    attempt(setBusy, setError, async () => {
      setSaved(undefined);
      await action();
      if (message) setSaved(message);
    });

  if (!s) return <Pending error={error} />;
  const methods = (s.password ? 1 : 0) + s.passkeys.length + s.social.length;

  const addPasskey = () =>
    act(async () => {
      const optionsJSON = await api.security.passkeyOptions();
      const response = await startRegistration({ optionsJSON }).catch((err: Error) => {
        throw new Error(err.name === "NotAllowedError" ? t("security:passkeyCancelled") : err.message);
      });
      const fallback = t("security:passkeyDefaultName");
      const name = window.prompt(t("security:passkeyNamePrompt"), navigator.platform ? t("security:passkeyPlatformName", { platform: navigator.platform }) : fallback)?.trim() || fallback;
      setS(await api.security.addPasskey(response, name.slice(0, 60)));
    }, t("security:passkeyAdded"));

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    if (passwords.next !== passwords.again) return setError(t("security:passwordMismatch"));
    void act(async () => {
      setS(await api.security.setPassword(passwords.next, s.password ? passwords.current : undefined));
      setPasswords({ current: "", next: "", again: "" });
    }, t("security:passwordSaved"));
  };

  const confirmTotp = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const result = await api.security.confirmTotp(code);
      setS(result.security);
      setCodes(result.recoveryCodes);
      setTotpSetup(undefined);
      setCode("");
    });
  };

  return (
    <section className="space-y-6">
      <h1 className="text-lg font-semibold">{partTitle(part)}</h1>
      {methods === 0 && (
        <p className="notice notice-error px-3 py-2 text-sm">
          {t("security:noMethod")}
        </p>
      )}

      {part === "passkeys" && (
      <div className="space-y-2">
        <p className="text-sm text-fg-secondary">{t("security:passkeysIntro")}</p>
        {s.passkeys.map((p) => (
          <div key={p.id} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {p.name} <span className="text-fg-muted">· {p.lastUsedAt ? t("security:passkeyUsed", { added: date(p.createdAt), used: date(p.lastUsedAt) }) : t("security:passkeyAddedOn", { added: date(p.createdAt) })}</span>
            </span>
            <button onClick={() => void act(async () => setS(await api.security.removePasskey(p.id)))} disabled={busy} className="btn-danger text-sm">
              {t("remove")}
            </button>
          </div>
        ))}
        {browserSupportsWebAuthn() ? (
          <button onClick={() => void addPasskey()} disabled={busy} className="btn-secondary">
            {t("security:addPasskey")}
          </button>
        ) : (
          <p className="text-sm text-fg-muted">{t("security:noWebAuthn")}</p>
        )}
      </div>
      )}

      {part === "linked" && (
        <div className="space-y-2">
          <span className="section-header block">{t("security:socialTitle")}</span>
          {!s.providers.length && <p className="text-sm text-fg-muted">{t("security:socialOff")}</p>}
          {s.providers.map((provider) => {
            const linked = s.social.find((l) => l.provider === provider);
            return (
              <div key={provider} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {SOCIAL_LABELS[provider]}
                  {linked && <span className="text-fg-muted"> · {linked.email ?? t("security:linkedShort")}</span>}
                </span>
                {linked ? (
                  <button onClick={() => void act(async () => setS(await api.security.unlinkSocial(provider)))} disabled={busy} className="btn-danger text-sm">
                    {t("security:unlink")}
                  </button>
                ) : (
                  <button onClick={() => void act(async () => location.assign((await api.security.linkSocial(provider)).url))} disabled={busy} className="btn-secondary text-sm">
                    {t("security:link")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {part === "password" && (
      <form onSubmit={savePassword} className="space-y-3">
        <div className="flex flex-wrap gap-3">
          {s.password && (
            <Field label={t("security:currentPassword")}>
              <input type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} required autoComplete="current-password" className="field" />
            </Field>
          )}
          <Field label={s.password ? t("security:newPassword") : t("security:password")}>
            <input type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} required minLength={10} maxLength={200} autoComplete="new-password" className="field" />
          </Field>
          <Field label={t("security:again")}>
            <input type="password" value={passwords.again} onChange={(e) => setPasswords({ ...passwords, again: e.target.value })} required autoComplete="new-password" className="field" />
          </Field>
        </div>
        <p className="text-xs text-fg-muted">{t("security:passwordHint", { count: 10 })}</p>
        <div className="flex gap-3">
          <button disabled={busy} className="btn-secondary">
            {s.password ? t("security:changePassword") : t("security:setPassword")}
          </button>
          {s.password && methods > 1 && (
            <button type="button" onClick={() => void act(async () => setS(await api.security.removePassword()), t("security:passwordRemoved"))} disabled={busy} className="btn-danger">
              {t("security:removePassword")}
            </button>
          )}
        </div>
      </form>
      )}

      {part === "totp" && (
      <div className="space-y-3">
        <p className="text-sm text-fg-secondary">
          {t("security:totpIntro")}
        </p>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(undefined)} />
        ) : s.totp ? (
          <div className="space-y-2">
            <p className="text-sm">
              {t("security:totpOn", { count: s.recoveryCodes })}
            </p>
            <div className="flex flex-wrap gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("security:codeOrRecovery")} autoComplete="one-time-code" className="field min-w-0 flex-1" />
              <button
                onClick={() =>
                  void act(async () => {
                    const result = await api.security.newRecoveryCodes(code);
                    setS(result.security);
                    setCodes(result.recoveryCodes);
                    setCode("");
                  })
                }
                disabled={busy || !code}
                className="btn-secondary"
              >
                {t("security:newRecoveryCodes")}
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    setS(await api.security.disableTotp(code));
                    setCode("");
                  }, t("security:twoFactorOff"))
                }
                disabled={busy || !code}
                className="btn-danger"
              >
                {t("security:turnOff")}
              </button>
            </div>
          </div>
        ) : totpSetup ? (
          <form onSubmit={confirmTotp} className="space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <Qr text={totpSetup.url} />
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p><Trans ns="security" i18nKey="totpScan" components={{ a: <a href={totpSetup.url} className="btn-link" /> }} /></p>
                <code className="block break-all">{totpSetup.secret.match(/.{1,4}/g)!.join(" ")}</code>
              </div>
            </div>
            <div className="flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} required placeholder={t("security:appCode")} inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="field w-40" />
              <button disabled={busy} className="btn-primary">
                {t("security:turnOn")}
              </button>
              <button type="button" onClick={() => setTotpSetup(undefined)} className="btn-secondary">
                {t("cancel")}
              </button>
            </div>
          </form>
        ) : (
          <button onClick={() => void act(async () => setTotpSetup(await api.security.startTotp()))} disabled={busy} className="btn-secondary">
            {t("security:enableTotp")}
          </button>
        )}
      </div>
      )}

      {saved && <p className="text-sm text-success">{saved}</p>}
      <ErrorNotice error={error} />
    </section>
  );
}
