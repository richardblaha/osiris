import type { SecurityOverview, SocialProvider } from "@osiris/shared";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import { encode } from "uqr";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { SOCIAL_LABELS } from "./SignIn.tsx";

const date = (iso: string) => new Date(iso).toLocaleDateString("cs-CZ");

/** A QR code as SVG squares, for the authenticator app to scan. */
function Qr({ text }: { text: string }) {
  const { data, size } = encode(text, { border: 2 });
  const path = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-44 w-44 rounded bg-white" shapeRendering="crispEdges" role="img" aria-label="QR kód pro ověřovací aplikaci">
      <path d={path} fill="#000" />
    </svg>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="notice space-y-3 px-3 py-3 text-sm">
      <p>
        <strong>Záložní kódy.</strong> Ulož si je někam mimo telefon (vytiskni, do správce hesel). Každý platí jednou a pustí tě dovnitř, když
        ověřovací aplikaci nemáš po ruce. Znovu je neuvidíš.
      </p>
      <pre className="grid grid-cols-2 gap-1 font-mono">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
      <div className="flex gap-3">
        <button onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))} className="btn-secondary">
          Zkopírovat
        </button>
        <button onClick={onDone} className="btn-primary">
          Mám je uložené
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

const PART_TITLE: Record<SecurityPart, string> = { passkeys: "Klíče (passkeys)", password: "Heslo", totp: "Dvoufázové přihlašování", linked: "Propojené účty" };

/** One part of the user's sign-in methods: passkeys, the password, the authenticator app or linked accounts. */
export function Security({ part, notice }: { part: SecurityPart; notice?: { linked?: string; error?: string } }) {
  const [s, setS] = useState<SecurityOverview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(notice?.error);
  const [saved, setSaved] = useState(notice?.linked ? `Účet ${SOCIAL_LABELS[notice.linked as SocialProvider] ?? notice.linked} je propojený.` : undefined);
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

  if (!s) return <ErrorNotice error={error} />;
  const methods = (s.password ? 1 : 0) + s.passkeys.length + s.social.length;

  const addPasskey = () =>
    act(async () => {
      const optionsJSON = await api.security.passkeyOptions();
      const response = await startRegistration({ optionsJSON }).catch((err: Error) => {
        throw new Error(err.name === "NotAllowedError" ? "Přidání klíče bylo zrušeno." : err.message);
      });
      const name = window.prompt("Jak klíč pojmenovat?", navigator.platform ? `Klíč (${navigator.platform})` : "Můj klíč")?.trim() || "Můj klíč";
      setS(await api.security.addPasskey(response, name.slice(0, 60)));
    }, "Klíč je přidaný. Příště se jím můžeš přihlásit.");

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    if (passwords.next !== passwords.again) return setError("Hesla se neshodují");
    void act(async () => {
      setS(await api.security.setPassword(passwords.next, s.password ? passwords.current : undefined));
      setPasswords({ current: "", next: "", again: "" });
    }, "Heslo je uložené.");
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
      <h1 className="text-lg font-semibold">{PART_TITLE[part]}</h1>
      {methods === 0 && (
        <p className="notice notice-error px-3 py-2 text-sm">
          Zatím se nemáš jak přihlásit znovu. Přidej si klíč (passkey), nastav heslo, nebo propoj účet Google, Facebook, Microsoft či Seznam.
        </p>
      )}

      {part === "passkeys" && (
      <div className="space-y-2">
        <p className="text-sm text-fg-secondary">Přihlášení otiskem prstu, obličejem nebo PINem zařízení. Nejbezpečnější a nejrychlejší způsob.</p>
        {s.passkeys.map((p) => (
          <div key={p.id} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {p.name} <span className="text-fg-muted">· přidán {date(p.createdAt)}{p.lastUsedAt && `, naposledy ${date(p.lastUsedAt)}`}</span>
            </span>
            <button onClick={() => void act(async () => setS(await api.security.removePasskey(p.id)))} disabled={busy} className="btn-danger text-sm">
              Odebrat
            </button>
          </div>
        ))}
        {browserSupportsWebAuthn() ? (
          <button onClick={() => void addPasskey()} disabled={busy} className="btn-secondary">
            Přidat klíč
          </button>
        ) : (
          <p className="text-sm text-fg-muted">Tento prohlížeč klíče nepodporuje.</p>
        )}
      </div>
      )}

      {part === "linked" && (
        <div className="space-y-2">
          <span className="section-header block">Přihlašování účtem</span>
          {!s.providers.length && <p className="text-sm text-fg-muted">Přihlašování účty Google, Facebook, Microsoft ani Seznam tu není nastavené.</p>}
          {s.providers.map((provider) => {
            const linked = s.social.find((l) => l.provider === provider);
            return (
              <div key={provider} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {SOCIAL_LABELS[provider]}
                  {linked && <span className="text-fg-muted"> · {linked.email ?? "propojeno"}</span>}
                </span>
                {linked ? (
                  <button onClick={() => void act(async () => setS(await api.security.unlinkSocial(provider)))} disabled={busy} className="btn-danger text-sm">
                    Odpojit
                  </button>
                ) : (
                  <button onClick={() => void act(async () => location.assign((await api.security.linkSocial(provider)).url))} disabled={busy} className="btn-secondary text-sm">
                    Propojit
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
            <Field label="Současné heslo">
              <input type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} required autoComplete="current-password" className="field" />
            </Field>
          )}
          <Field label={s.password ? "Nové heslo" : "Heslo"}>
            <input type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} required minLength={10} maxLength={200} autoComplete="new-password" className="field" />
          </Field>
          <Field label="Znovu">
            <input type="password" value={passwords.again} onChange={(e) => setPasswords({ ...passwords, again: e.target.value })} required autoComplete="new-password" className="field" />
          </Field>
        </div>
        <p className="text-xs text-fg-muted">Aspoň 10 znaků. Dobře se pamatuje věta z několika slov.</p>
        <div className="flex gap-3">
          <button disabled={busy} className="btn-secondary">
            {s.password ? "Změnit heslo" : "Nastavit heslo"}
          </button>
          {s.password && methods > 1 && (
            <button type="button" onClick={() => void act(async () => setS(await api.security.removePassword()), "Heslo je zrušené.")} disabled={busy} className="btn-danger">
              Zrušit heslo
            </button>
          )}
        </div>
      </form>
      )}

      {part === "totp" && (
      <div className="space-y-3">
        <p className="text-sm text-fg-secondary">
          Po přihlášení heslem nebo účtem Google/Facebook/Microsoft/Seznam se zeptáme ještě na kód z aplikace v telefonu (Google Authenticator, Microsoft
          Authenticator, 1Password…). Přihlášení klíčem kód nepotřebuje.
        </p>
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => setCodes(undefined)} />
        ) : s.totp ? (
          <div className="space-y-2">
            <p className="text-sm">
              Zapnuto. Zbývá {s.recoveryCodes} záložních kódů.
            </p>
            <div className="flex flex-wrap gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="kód z aplikace nebo záložní kód" autoComplete="one-time-code" className="field min-w-0 flex-1" />
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
                Nové záložní kódy
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    setS(await api.security.disableTotp(code));
                    setCode("");
                  }, "Dvoufázové ověření je vypnuté.")
                }
                disabled={busy || !code}
                className="btn-danger"
              >
                Vypnout
              </button>
            </div>
          </div>
        ) : totpSetup ? (
          <form onSubmit={confirmTotp} className="space-y-3">
            <div className="flex flex-wrap items-center gap-4">
              <Qr text={totpSetup.url} />
              <div className="min-w-0 flex-1 space-y-2 text-sm">
                <p>Naskenuj kód v ověřovací aplikaci. Na telefonu můžeš <a href={totpSetup.url} className="btn-link">otevřít aplikaci přímo</a>, nebo opsat klíč:</p>
                <code className="block break-all">{totpSetup.secret.match(/.{1,4}/g)!.join(" ")}</code>
              </div>
            </div>
            <div className="flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} required placeholder="kód z aplikace" inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="field w-40" />
              <button disabled={busy} className="btn-primary">
                Zapnout
              </button>
              <button type="button" onClick={() => setTotpSetup(undefined)} className="btn-secondary">
                Zrušit
              </button>
            </div>
          </form>
        ) : (
          <button onClick={() => void act(async () => setTotpSetup(await api.security.startTotp()))} disabled={busy} className="btn-secondary">
            Zapnout ověřovací aplikaci
          </button>
        )}
      </div>
      )}

      {saved && <p className="text-sm text-success">{saved}</p>}
      <ErrorNotice error={error} />
    </section>
  );
}
