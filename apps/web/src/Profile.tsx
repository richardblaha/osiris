import type { MeResponse, TenantFeatures, UserProfile, UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { AssistantSettings } from "./Assistant.tsx";
import { Integrations } from "./Integrations.tsx";
import { api } from "./api.ts";
import { logout } from "./auth.ts";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { Security, type SecurityPart } from "./Security.tsx";
import { MasterDetail } from "./MasterDetail.tsx";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** The profile picture (claim `picture`), or the user's initials when there is none or it fails to load. */
export function Avatar({ user, size = 32 }: { user: MeResponse["user"]; size?: number }) {
  const [failed, setFailed] = useState(false);
  const label = user.name ?? user.email ?? "?";
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (user.picture && !failed) {
    return <img src={user.picture} alt="" style={style} onError={() => setFailed(true)} className="shrink-0 rounded-full object-cover" />;
  }
  return (
    <span style={style} className="flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-semibold text-primary">
      {initials(label)}
    </span>
  );
}

type Part = "account" | SecurityPart | "personalization";

/**
 * The user's own: their account, each sign-in method, linked accounts and how the assistant treats them
 * (personalization), each a part of its own; signing out at the end.
 */
export function Profile({ me, notice, features }: { me: MeResponse; notice?: { linked?: string; error?: string }; features?: TenantFeatures }) {
  // Back from linking an account: its part.
  const [part, setPart] = useState<Part>(notice ? "linked" : "account");
  return (
    <MasterDetail
      title={me.user.name ?? me.user.email ?? "Můj profil"}
      groups={[
        {
          items: [
            { key: "account", label: "Účet" },
            { key: "passkeys", label: "Klíče (passkeys)" },
            { key: "password", label: "Změnit heslo" },
            { key: "totp", label: "Dvoufázové přihlašování" },
            { key: "linked", label: "Propojené účty" },
            { key: "personalization", label: "Personalizace" },
            { key: "logout", label: <span className="text-error">Odhlásit</span> },
          ],
        },
      ]}
      selected={part}
      onSelect={(k) => (k === "logout" ? void logout() : setPart(k as Part))}
    >
      <div className="detail">
        {part === "account" ? (
          <>
            <div className="flex items-center gap-4">
              <Avatar user={me.user} size={56} />
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{me.user.name ?? me.user.email ?? "Můj profil"}</h1>
            </div>
            <Account />
          </>
        ) : part === "personalization" ? (
          <Personalization />
        ) : (
          <>
            <Security key={part} part={part} notice={part === "linked" ? notice : undefined} />
            {part === "linked" && features?.integrations && (
              <div className="mt-8">
                <Integrations />
              </div>
            )}
          </>
        )}
      </div>
    </MasterDetail>
  );
}

/** How the assistant treats the user: address, language, signature, own instructions and their persona. */
function Personalization() {
  const [settings, setSettings] = useState<UserSettings>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => void api.settings().then(setSettings, (e: Error) => setError(e.message)), []);

  const set = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSaved(false);
    setSettings((s) => s && { ...s, [key]: value });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (settings) void attempt(setBusy, setError, async () => (setSettings(await api.saveSettings(settings)), setSaved(true)));
  };

  return (
    <>
      <h1 className="text-lg font-semibold">Personalizace</h1>
      <p className="mt-1 text-sm text-fg-secondary">Jak s tebou má asistent jednat. Platí jen pro tebe, ve všech tvých tenantech zvlášť.</p>
      {!settings && !error && <Pending />}
      {settings && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-6">
            <label className="space-y-1">
              <span className="section-header block">Oslovení</span>
              <select value={settings.address} onChange={(e) => set("address", e.target.value as UserSettings["address"])} className="field w-auto">
                <option value="auto">podle mě</option>
                <option value="ty">tykání</option>
                <option value="vy">vykání</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="section-header block">Jazyk odpovědí</span>
              <select value={settings.language} onChange={(e) => set("language", e.target.value as UserSettings["language"])} className="field w-auto">
                <option value="auto">podle mě</option>
                <option value="cs">čeština</option>
                <option value="sk">slovenčina</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1">
            <span className="section-header block">Podpis</span>
            <textarea
              value={settings.signature}
              onChange={(e) => set("signature", e.target.value)}
              placeholder={"Do e-mailů, nabídek a dalších textů psaných tvým jménem, např.\nJan Novák, elektro Novák, 777 123 456"}
              maxLength={1000}
              rows={3}
              className="field"
            />
          </label>
          <label className="block space-y-1">
            <span className="section-header block">Vlastní pokyny pro asistenta</span>
            <textarea
              value={settings.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="Např. Ceny uváděj vždy s DPH. Termíny navrhuj jen ve všední dny."
              maxLength={4000}
              rows={5}
              className="field"
            />
          </label>
          <div className="flex items-center gap-3">
            <button disabled={busy} className="btn-primary">
              {busy ? "Ukládám…" : "Uložit"}
            </button>
            {saved && <span className="text-sm text-success">Uloženo.</span>}
          </div>
        </form>
      )}
      <ErrorNotice error={error} />

      <h2 className="section-header mt-8">Persona asistenta</h2>
      <AssistantSettings scope="personal" editable />
    </>
  );
}

/** Name, email, picture and phone of the Osiris account. */
function Account() {
  const [profile, setProfile] = useState<UserProfile>();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "" });
  const [phone, setPhone] = useState("");
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const show = (p: UserProfile) => {
    setProfile(p);
    setForm({ firstName: p.firstName, lastName: p.lastName, email: p.email ?? "" });
  };
  useEffect(() => void api.profile().then(show, (e: Error) => setError(e.message)), []);
  const act = (action: () => Promise<unknown>, message?: string) =>
    attempt(setBusy, setError, async () => {
      setSaved(undefined);
      await action();
      if (message) setSaved(message);
    });

  if (!profile) return <Pending error={error} />;
  const challenge = profile.phoneChallenge;
  const waLink = challenge?.whatsappNumber
    ? `https://wa.me/${challenge.whatsappNumber.replace(/\D/g, "")}?text=${encodeURIComponent(`OVERENI ${challenge.code}`)}`
    : undefined;

  return (
    <section className="mt-6 space-y-4">
      <h2 className="section-header">Účet</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => show(await api.saveProfile(form)), "Uloženo. Nové jméno se projeví do minuty.");
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap gap-3">
          <Field label="Jméno">
            <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required maxLength={50} className="field" />
          </Field>
          <Field label="Příjmení">
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} maxLength={50} className="field" />
          </Field>
        </div>
        <Field label="E-mail">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={200} className="field" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy} className="btn-primary">
            Uložit účet
          </button>
          <label className="btn-secondary cursor-pointer">
            Změnit fotku
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void act(() => api.savePicture(file), "Fotka uložena. Projeví se do minuty.");
              }}
            />
          </label>
        </div>
      </form>

      <div>
        <span className="section-header block">Telefon pro WhatsApp</span>
        <p className="mt-1 text-sm">
          {profile.phone ?? <span className="text-fg-muted">neověřený</span>}
          {profile.phone && (
            <button onClick={() => void act(async () => (await api.removePhone(), show(await api.profile())))} className="btn-danger ml-3 text-sm">
              Odebrat
            </button>
          )}
        </p>
        {challenge ? (
          <div className="notice mt-2 space-y-2 px-3 py-2 text-sm">
            <p>
              Pošli z čísla <strong>{challenge.phone}</strong> zprávu <code>OVERENI {challenge.code}</code> na WhatsApp
              {challenge.whatsappNumber ? <> číslo <strong>{challenge.whatsappNumber}</strong></> : " Osirisu"}. Kód platí 15 minut.
            </p>
            <div className="flex gap-3">
              {waLink && (
                <a href={waLink} target="_blank" rel="noreferrer" className="btn-primary">
                  Otevřít WhatsApp
                </a>
              )}
              <button onClick={() => void act(async () => show(await api.profile()))} className="btn-secondary">
                Hotovo, zkontrolovat
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => show(await api.startPhone(phone)));
            }}
            className="mt-2 flex gap-2"
          >
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+420 777 123 456" required className="field min-w-0 flex-1" />
            <button disabled={busy} className="btn-secondary">
              {profile.phone ? "Změnit číslo" : "Ověřit číslo"}
            </button>
          </form>
        )}
      </div>
      {saved && <p className="text-sm text-success">{saved}</p>}
      <ErrorNotice error={error} />
    </section>
  );
}
