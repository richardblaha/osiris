import { MasterDetail } from "./MasterDetail.tsx";
import { PersonaEditor } from "./PersonaEditor.tsx";
import type { SettingsPart } from "./routes.ts";
import { CUSTOM_PERSONA, FEATURES, type SystemDefaults, type UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { featureLabels } from "./Tenants.tsx";
import { QUOTA_KEYS, quotaLabel } from "./Quotas.tsx";
import { LanguageSelect } from "./Profile.tsx";
import { t } from "i18next";

/** What new tenants and users start with (system admins); existing ones keep what they have. */
export function SystemSettings({ part = "features", onSelect }: { part?: SettingsPart; onSelect: (part: SettingsPart) => void }) {
  return <MasterDetail title={t("app:nav.settings")} groups={[
    { title: t("settings:newTenant"), items: [{ key: "features", label: title("features") }, { key: "quotas", label: title("quotas") }, { key: "runtime", label: title("runtime") }] },
    { title: t("settings:newUser"), items: [{ key: "personalization", label: title("personalization") }, { key: "persona", label: title("persona") }] },
  ]} selected={part} onSelect={(key) => onSelect(key as SettingsPart)}>
    <DefaultsForm key={part} part={part} />
  </MasterDetail>;
}

const title = (part: SettingsPart) => t(`settings:titles.${part}`);

function DefaultsForm({ part }: { part: SettingsPart }) {
  const [d, setD] = useState<SystemDefaults>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.admin.defaults().then(setD, (e: Error) => setError(e.message)), []);
  if (!d) return <Pending error={error} className="detail relative" />;

  const tenant = (change: Partial<SystemDefaults["tenant"]>) => (setSaved(false), setD({ ...d, tenant: { ...d.tenant, ...change } }));
  const user = (change: Partial<SystemDefaults["user"]>) => (setSaved(false), setD({ ...d, user: { ...d.user, ...change } }));
  const persona = d.user.persona ?? { character: "", source: "", description: "" };
  const setPersona = (description: string) => user({ persona: description.trim() ? { character: CUSTOM_PERSONA, source: "", description } : null });
  const generate = () =>
    attempt(setBusy, setError, async () => setPersona((await api.generatePersona(persona.description)).description));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => {
      // Each smaller form saves only its section, preserving the latest values of the other sections.
      const body = await api.admin.defaults();
      switch (part) {
        case "features": body.tenant.features = d.tenant.features; break;
        case "quotas": body.tenant.quotas = d.tenant.quotas; break;
        case "runtime":
          body.tenant.idleMinutes = d.tenant.idleMinutes;
          body.tenant.storageGb = d.tenant.storageGb;
          break;
        case "personalization": body.user = { ...d.user, persona: body.user.persona }; break;
        case "persona": body.user.persona = d.user.persona; break;
      }
      setD(await api.admin.saveDefaults(body));
      setSaved(true);
    });
  };

  return (
    <form onSubmit={submit} className="detail max-w-3xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold">{title(part)}</h1>
        <p className="mt-1 text-sm text-fg-secondary">{t("settings:intro")}</p>
      </div>

      {part === "features" && <section className="space-y-4">
        <div>
          <span className="text-sm font-medium">{title("features")}</span>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <label key={f} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={d.tenant.features[f]} onChange={(e) => tenant({ features: { ...d.tenant.features, [f]: e.target.checked } })} />
                <span>{featureLabels()[f].label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>}

      {(part === "quotas" || part === "runtime") && <section className="grid gap-3 sm:grid-cols-2">
          {part === "quotas" && QUOTA_KEYS.map((key) => (
            <Field key={key} label={t("settings:quotaField", { label: quotaLabel(key) })}>
              <input
                type="number"
                min={0}
                value={d.tenant.quotas[key] ?? ""}
                onChange={(e) => tenant({ quotas: { ...d.tenant.quotas, [key]: e.target.value === "" ? null : Number(e.target.value) } })}
                className="field w-48"
              />
            </Field>
          ))}
          {part === "runtime" && <>
          <Field label={t("settings:idle")}>
            <input type="number" min={0} max={1440} value={d.tenant.idleMinutes} onChange={(e) => tenant({ idleMinutes: Number(e.target.value) })} className="field w-48" />
          </Field>
          <Field label={t("settings:disk")}>
            <input type="number" min={1} max={500} value={d.tenant.storageGb} onChange={(e) => tenant({ storageGb: Number(e.target.value) })} className="field w-48" />
          </Field>
          </>}
      </section>}

      {part === "personalization" && <section className="space-y-4">
        <h2 className="section-header">{t("settings:newUser")}</h2>
        <p className="text-sm text-fg-secondary">{t("settings:personalizationIntro")}</p>
        <div className="flex flex-wrap gap-6">
          <Field label={t("profile:address")}>
            <select value={d.user.address} onChange={(e) => user({ address: e.target.value as UserSettings["address"] })} className="field w-auto">
              <option value="auto">{t("settings:byUser")}</option>
              <option value="ty">{t("profile:informal")}</option>
              <option value="vy">{t("profile:formal")}</option>
            </select>
          </Field>
          <Field label={t("profile:language")}>
            <LanguageSelect value={d.user.language} onChange={(language) => user({ language })} />
          </Field>
        </div>
        <Field label={t("profile:signature")}>
          <textarea value={d.user.signature} onChange={(e) => user({ signature: e.target.value })} maxLength={1000} rows={3} className="field" />
        </Field>
        <Field label={t("settings:instructions")}>
          <textarea
            value={d.user.instructions}
            onChange={(e) => user({ instructions: e.target.value })}
            placeholder={t("settings:instructionsPlaceholder")}
            maxLength={4000}
            rows={4}
            className="field"
          />
        </Field>
      </section>}

      {part === "persona" && <section>
        <p className="text-xs text-fg-muted">{t("settings:personaHint")}</p>
        <PersonaEditor value={persona.description} onChange={setPersona} onGenerate={() => void generate()} busy={busy} />
      </section>}

      <ErrorNotice error={error} />
      <div className="flex items-center gap-3">
        <button disabled={busy} className="btn-primary">
          {t("save")}
        </button>
        {saved && <span className="text-sm text-success">{t("savedNotice")}</span>}
      </div>
    </form>
  );
}
