import type { SignInState, SocialProvider } from "@osiris/shared";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import { login } from "./auth.ts";

export const SOCIAL_LABELS: Record<SocialProvider, string> = { google: "Google", facebook: "Facebook", microsoft: "Microsoft", seznam: "Seznam" };

/** A call to the sign-in API (`/auth/interaction/:uid/...`); the interaction cookie goes along. */
async function step<T>(uid: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/auth/interaction/${encodeURIComponent(uid)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

type Next = { redirectTo: string } | { step: "second-factor" };

/**
 * The sign-in screen at `/login?uid=…`, where the OIDC provider sends the browser: passkey, email and password,
 * Google/Facebook/Microsoft/Seznam, or a link by email; then the authenticator code when the account has one.
 */
export function SignIn() {
  const params = new URLSearchParams(location.search);
  const uid = params.get("uid");
  const [state, setState] = useState<SignInState>();
  const [form, setForm] = useState({ email: "", password: "" });
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get("error") ?? undefined);

  useEffect(() => {
    // Opened directly, not from a sign-in in progress: start one.
    if (!uid) void login();
    else step<SignInState>(uid, "/state").then(setState, () => void login());
  }, [uid]);

  if (!uid || !state) return null;

  const run = async (action: () => Promise<Next | void>) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await action();
      if (next && "redirectTo" in next) location.assign(next.redirectTo);
      else if (next) setState({ ...state, step: next.step });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const passkey = () =>
    run(async () => {
      const optionsJSON = await step<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(uid, "/passkey/options", {});
      const response = await startAuthentication({ optionsJSON }).catch((err: Error) => {
        throw new Error(err.name === "NotAllowedError" ? "Přihlášení klíčem bylo zrušeno." : err.message);
      });
      return step<Next>(uid, "/passkey", { response });
    });

  const password = (e: FormEvent) => {
    e.preventDefault();
    void run(() => step<Next>(uid, "/password", form));
  };

  const emailLink = () => {
    if (!form.email) return setError("Vyplň e-mail, na který ti máme poslat odkaz.");
    void run(async () => {
      await step(uid, "/email-link", { email: form.email });
      setSent(true);
    });
  };

  const secondFactor = (e: FormEvent) => {
    e.preventDefault();
    void run(() => step<Next>(uid, "/second-factor", { code }));
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <img src="/logo.svg" alt="" className="h-20 w-20" />
          <h1 className="text-3xl font-semibold tracking-[0.2em]">OSIRIS</h1>
        </div>

        {state.step === "second-factor" ? (
          <form onSubmit={secondFactor} className="space-y-3">
            <p className="text-sm text-fg-secondary">Zadej kód z ověřovací aplikace. Když telefon nemáš po ruce, použij jeden ze záložních kódů.</p>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
              required
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="123 456"
              maxLength={20}
              className="field text-center text-lg tracking-widest"
            />
            <button disabled={busy} className="btn-primary w-full py-2.5">
              Ověřit
            </button>
          </form>
        ) : sent ? (
          <p className="notice px-3 py-2 text-sm">
            Pokud u nás účet s adresou <strong>{form.email}</strong> máš, poslali jsme na ni odkaz pro přihlášení. Platí hodinu.
          </p>
        ) : (
          <>
            {state.methods.passkey && browserSupportsWebAuthn() && (
              <button onClick={() => void passkey()} disabled={busy} className="btn-primary w-full py-2.5">
                Přihlásit se klíčem (passkey)
              </button>
            )}
            {state.methods.social.length > 0 && (
              <div className="space-y-2">
                {state.methods.social.map((p) => (
                  <a key={p} href={`/auth/interaction/${encodeURIComponent(uid)}/social/${p}`} className="btn-secondary block w-full py-2.5 text-center">
                    Pokračovat přes {SOCIAL_LABELS[p]}
                  </a>
                ))}
              </div>
            )}
            <div className="flex items-center gap-3 text-xs text-fg-muted">
              <span className="h-px flex-1 bg-line" />
              nebo e-mailem
              <span className="h-px flex-1 bg-line" />
            </div>
            <form onSubmit={password} className="space-y-3">
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
                autoComplete="username"
                placeholder="e-mail"
                maxLength={200}
                className="field"
              />
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
                autoComplete="current-password"
                placeholder="heslo"
                maxLength={200}
                className="field"
              />
              <button disabled={busy} className="btn-primary w-full py-2.5">
                Přihlásit
              </button>
            </form>
            {state.methods.emailLink && (
              <button onClick={emailLink} disabled={busy} className="btn-link block w-full text-center text-sm">
                Zapomněl(a) jsem heslo, pošlete mi odkaz e-mailem
              </button>
            )}
          </>
        )}
        {error && <p className="notice notice-error px-3 py-2 text-sm">{error}</p>}
      </div>
    </div>
  );
}
