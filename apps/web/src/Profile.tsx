import { AccountActivity } from "./AccountActivity.tsx";
import type { MeResponse, ProjectFeatures, UserProfile, UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { AssistantSettings } from "./Assistant.tsx";
import { Integrations } from "./Integrations.tsx";
import { api } from "./api.ts";
import { logout } from "./auth.ts";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { Security, type SecurityPart } from "./Security.tsx";
import { MasterDetail } from "./MasterDetail.tsx";
import { t } from "i18next";
import { Trans } from "react-i18next";
import { applyLanguageSetting, initial } from "./i18n.ts";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(initial)
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

type Part = "account" | SecurityPart | "personalization" | "activity";

/**
 * The user's own: their account, each sign-in method, linked accounts and how the assistant treats them
 * (personalization), each a part of its own; signing out at the end.
 */
export function Profile({ me, notice, features }: { me: MeResponse; notice?: { linked?: string; error?: string }; features?: ProjectFeatures }) {
  // Back from linking an account: its part.
  const [part, setPart] = useState<Part>(notice ? "linked" : "account");
  return (
    <MasterDetail
      title={me.user.name ?? me.user.email ?? t("profile:title")}
      groups={[
        {
          items: [
            { key: "account", label: t("profile:parts.account") },
            { key: "passkeys", label: t("profile:parts.passkeys") },
            { key: "password", label: t("profile:parts.password") },
            { key: "totp", label: t("profile:parts.totp") },
            { key: "linked", label: t("profile:parts.linked") },
            { key: "personalization", label: t("profile:parts.personalization") },
            { key: "activity", label: t("profile:parts.activity") },
            { key: "logout", label: <span className="text-error">{t("app:signOut")}</span> },
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
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{me.user.name ?? me.user.email ?? t("profile:title")}</h1>
            </div>
            <Account />
          </>
        ) : part === "activity" ? (
          <AccountActivity />
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
    if (!settings) return;
    void attempt(setBusy, setError, async () => {
      const next = await api.saveSettings(settings);
      setSettings(next);
      setSaved(true);
      // The app follows the language too; changing it renders the app anew.
      applyLanguageSetting(next.language);
    });
  };

  return (
    <>
      <h1 className="text-lg font-semibold">{t("profile:parts.personalization")}</h1>
      <p className="mt-1 text-sm text-fg-secondary">{t("profile:personalizationIntro")}</p>
      {!settings && !error && <Pending />}
      {settings && (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="flex flex-wrap gap-6">
            <label className="space-y-1">
              <span className="section-header block">{t("profile:address")}</span>
              <select value={settings.address} onChange={(e) => set("address", e.target.value as UserSettings["address"])} className="field w-auto">
                <option value="auto">{t("profile:auto")}</option>
                <option value="ty">{t("profile:informal")}</option>
                <option value="vy">{t("profile:formal")}</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="section-header block">{t("profile:language")}</span>
              <LanguageSelect value={settings.language} onChange={(v) => set("language", v)} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="section-header block">{t("profile:signature")}</span>
            <textarea
              value={settings.signature}
              onChange={(e) => set("signature", e.target.value)}
              placeholder={t("profile:signaturePlaceholder")}
              maxLength={1000}
              rows={3}
              className="field"
            />
          </label>
          <label className="block space-y-1">
            <span className="section-header block">{t("profile:instructions")}</span>
            <textarea
              value={settings.instructions}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder={t("profile:instructionsPlaceholder")}
              maxLength={4000}
              rows={5}
              className="field"
            />
          </label>
          <div className="flex items-center gap-3">
            <button disabled={busy} className="btn-primary">
              {busy ? t("saving") : t("save")}
            </button>
            {saved && <span className="text-sm text-success">{t("savedNotice")}</span>}
          </div>
        </form>
      )}
      <ErrorNotice error={error} />

      <h2 className="section-header mt-8">{t("profile:persona")}</h2>
      <AssistantSettings scope="personal" editable />
    </>
  );
}

/** The language choice; each language is named in itself, so a reader finds theirs whatever the app's language. */
export function LanguageSelect({ value, onChange }: { value: UserSettings["language"]; onChange: (v: UserSettings["language"]) => void }) {
  const own = (code: string) => new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as UserSettings["language"])} className="field w-auto">
      <option value="auto">{t("profile:languageAuto")}</option>
      {(["en", "cs", "sk"] as const).map((code) => (
        <option key={code} value={code} lang={code}>
          {own(code)}
        </option>
      ))}
    </select>
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
    ? `https://wa.me/${challenge.whatsappNumber.replace(/\D/g, "")}?text=${encodeURIComponent(`${t("profile:verifyKeyword")} ${challenge.code}`)}`
    : undefined;

  return (
    <section className="mt-6 space-y-4">
      <h2 className="section-header">{t("profile:parts.account")}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => show(await api.saveProfile(form)), t("profile:savedName"));
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap gap-3">
          <Field label={t("invite:firstNameLabel")}>
            <input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required maxLength={50} className="field" />
          </Field>
          <Field label={t("invite:lastNameLabel")}>
            <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} maxLength={50} className="field" />
          </Field>
        </div>
        <Field label={t("profile:email")}>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} maxLength={200} className="field" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={busy} className="btn-primary">
            {t("profile:saveAccount")}
          </button>
          <label className="btn-secondary cursor-pointer">
            {t("profile:changePhoto")}
            <input
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void act(() => api.savePicture(file), t("profile:photoSaved"));
              }}
            />
          </label>
        </div>
      </form>

      <div>
        <span className="section-header block">{t("profile:phone")}</span>
        <p className="mt-1 text-sm">
          {profile.phone ?? <span className="text-fg-muted">{t("profile:unverified")}</span>}
          {profile.phone && (
            <button onClick={() => void act(async () => (await api.removePhone(), show(await api.profile())))} className="btn-danger ms-3 text-sm">
              {t("remove")}
            </button>
          )}
        </p>
        {challenge ? (
          <div className="notice mt-2 space-y-2 px-3 py-2 text-sm">
            <p>
              <Trans
                ns="profile"
                i18nKey={challenge.whatsappNumber ? "verifyTo" : "verifyOsiris"}
                values={{ phone: challenge.phone, message: `${t("profile:verifyKeyword")} ${challenge.code}`, number: challenge.whatsappNumber ?? "" }}
                components={{ strong: <strong />, code: <code /> }}
              />
            </p>
            <div className="flex gap-3">
              {waLink && (
                <a href={waLink} target="_blank" rel="noreferrer" className="btn-primary">
                  {t("profile:openWhatsApp")}
                </a>
              )}
              <button onClick={() => void act(async () => show(await api.profile()))} className="btn-secondary">
                {t("profile:checkDone")}
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
              {profile.phone ? t("profile:changeNumber") : t("profile:verifyNumber")}
            </button>
          </form>
        )}
      </div>
      {saved && <p className="text-sm text-success">{saved}</p>}
      <ErrorNotice error={error} />
    </section>
  );
}
