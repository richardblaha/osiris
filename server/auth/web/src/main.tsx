import "./i18n.ts";
import { t } from "i18next";
import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AccountActivity } from "./AccountActivity.tsx";
import { Admin } from "./Admin.tsx";
import { api, type Config, type Profile } from "./api.ts";
import { Security, type SecurityPart } from "./Security.tsx";
import { SignIn } from "./SignIn.tsx";
import { attempt, ErrorNotice, Field, Pending } from "./ui.tsx";
import "./index.css";

/** The page's frame: the provider's name and logo, the user's way between their account and the administration. */
function Frame({ config, children }: { config: Config; children: ReactNode }) {
  const admin = location.pathname.startsWith("/admin");
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <img src={config.logo ?? "/favicon.svg"} alt="" className="h-7 w-7" /> {config.name}
        </h1>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          {config.admin && (
            <a className={admin ? "btn-secondary" : "btn-primary"} href={admin ? "/account" : "/admin"}>
              {admin ? t("account") : t("admin:title")}
            </a>
          )}
          <a className="btn-danger" href="/logout?client_id=osiris-account">
            {t("signOut")}
          </a>
        </nav>
      </header>
      {children}
    </div>
  );
}

type Part = "profile" | SecurityPart | "activity";
const PARTS: Part[] = ["profile", "passkeys", "password", "totp", "linked", "activity"];

/** The user's own account: profile, sign-in methods, linked accounts, sign-ins and sessions. */
function Account() {
  const params = new URLSearchParams(location.search);
  const notice = params.has("linked") || params.has("error") ? { linked: params.get("linked") ?? undefined, error: params.get("error") ?? undefined } : undefined;
  const [part, setPart] = useState<Part>(notice ? "linked" : "profile");
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2" aria-label={t("account")}>
        {PARTS.map((p) => (
          <button key={p} onClick={() => setPart(p)} className={p === part ? "btn-primary text-sm" : "btn-secondary text-sm"} aria-current={p === part ? "page" : undefined}>
            {t(`parts.${p}`)}
          </button>
        ))}
      </nav>
      <main className="detail">
        {part === "profile" ? <ProfileForm /> : part === "activity" ? <AccountActivity /> : <Security key={part} part={part} notice={part === "linked" ? notice : undefined} />}
      </main>
    </div>
  );
}

function ProfileForm() {
  const [profile, setProfile] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => void api.profile().then(setProfile, (e: Error) => setError(e.message)), []);
  if (!profile) return <Pending error={error} />;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void attempt(setBusy, setError, async () => {
      setProfile(await api.saveProfile({ firstName: profile.firstName, lastName: profile.lastName, email: profile.email ?? undefined }));
      setSaved(true);
    });
  };
  const picture = (file?: File) =>
    file &&
    void attempt(setBusy, setError, async () => {
      await api.savePicture(file);
      setProfile(await api.profile());
    });
  return (
    <form onSubmit={save} className="max-w-md space-y-4">
      <h2 className="text-lg font-semibold">{t("parts.profile")}</h2>
      <div className="flex items-center gap-4">
        {profile.picture ? <img src={profile.picture} alt="" className="h-16 w-16 rounded-full object-cover" /> : <span className="h-16 w-16 rounded-full bg-primary-soft" />}
        <label className="btn-secondary cursor-pointer text-sm">
          {t("picture")}
          <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => picture(e.target.files?.[0])} />
        </label>
      </div>
      <Field label={t("firstName")}>
        <input className="field" value={profile.firstName} onChange={(e) => setProfile({ ...profile, firstName: e.target.value })} required maxLength={100} />
      </Field>
      <Field label={t("lastName")}>
        <input className="field" value={profile.lastName} onChange={(e) => setProfile({ ...profile, lastName: e.target.value })} maxLength={100} />
      </Field>
      <Field label={t("email")}>
        <input className="field" type="email" value={profile.email ?? ""} onChange={(e) => setProfile({ ...profile, email: e.target.value })} maxLength={200} />
      </Field>
      <ErrorNotice error={error} />
      {saved && <p className="notice px-3 py-2 text-sm">{t("saved")}</p>}
      <button className="btn-primary" disabled={busy}>
        {t("save")}
      </button>
    </form>
  );
}

/** Account and administration need the browser signed in; the sign-in page needs nothing. */
function App() {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState<string>();
  const signIn = location.pathname === "/login";
  useEffect(() => {
    if (signIn) return;
    api.config().then((c) => {
      document.title = c.name;
      if (!c.user) window.location.assign("/account/signin");
      else setConfig(c);
    }, (e: Error) => setError(e.message));
  }, [signIn]);
  if (signIn) return <SignIn />;
  if (!config) return <div className="mx-auto max-w-md px-4 py-8"><Pending error={error} /></div>;
  return <Frame config={config}>{location.pathname.startsWith("/admin") && config.admin ? <Admin /> : <Account />}</Frame>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
