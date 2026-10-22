import { MasterDetail } from "./MasterDetail.tsx";
import { PersonaEditor } from "./PersonaEditor.tsx";
import type { SettingsPart } from "./routes.ts";
import { FEATURES, type SystemDefaults, type TenantQuotas, type UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field, Pending } from "./Scope.tsx";
import { FEATURE_LABELS } from "./Tenants.tsx";

const QUOTAS: { key: keyof TenantQuotas; label: string }[] = [
  { key: "storageMb", label: "Soubory (MB)" },
  { key: "tokensPerMonth", label: "Tokeny modelu za měsíc" },
  { key: "members", label: "Uživatelé" },
  { key: "schedules", label: "Plánované úlohy" },
  { key: "tokensPerUserMonth", label: "Tokeny modelu za měsíc na uživatele" },
  { key: "tables", label: "Tabulky databáze" },
  { key: "databaseMb", label: "Databáze (MB)" },
  { key: "dashboards", label: "Vlastní dashboardy" },
];

/** What new tenants and users start with (system admins); existing ones keep what they have. */
export function SystemSettings({ part = "features", onSelect }: { part?: SettingsPart; onSelect: (part: SettingsPart) => void }) {
  return <MasterDetail title="Nastavení" groups={[
    { title: "Nový tenant", items: [{ key: "features", label: "Funkce" }, { key: "quotas", label: "Limity" }, { key: "runtime", label: "Provoz a úložiště" }] },
    { title: "Nový uživatel", items: [{ key: "personalization", label: "Personalizace" }, { key: "persona", label: "Persona asistenta" }] },
  ]} selected={part} onSelect={(key) => onSelect(key as SettingsPart)}>
    <DefaultsForm key={part} part={part} />
  </MasterDetail>;
}

const TITLES: Record<SettingsPart, string> = { features: "Funkce", quotas: "Limity", runtime: "Provoz a úložiště", personalization: "Personalizace", persona: "Persona asistenta" };

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
  const setPersona = (description: string) => user({ persona: description.trim() ? { character: "Vlastní", source: "", description } : null });
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
        <h1 className="text-lg font-semibold">{TITLES[part]}</h1>
        <p className="mt-1 text-sm text-fg-secondary">Výchozí hodnoty pro nové tenanty a uživatele. Stávající si nechávají svoje.</p>
      </div>

      {part === "features" && <section className="space-y-4">
        <div>
          <span className="text-sm font-medium">Funkce</span>
          <div className="mt-1 grid gap-1 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <label key={f} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={d.tenant.features[f]} onChange={(e) => tenant({ features: { ...d.tenant.features, [f]: e.target.checked } })} />
                <span>{FEATURE_LABELS[f].label}</span>
              </label>
            ))}
          </div>
        </div>
      </section>}

      {(part === "quotas" || part === "runtime") && <section className="grid gap-3 sm:grid-cols-2">
          {part === "quotas" && QUOTAS.map((q) => (
            <Field key={q.key} label={`${q.label} (prázdné = bez limitu)`}>
              <input
                type="number"
                min={0}
                value={d.tenant.quotas[q.key] ?? ""}
                onChange={(e) => tenant({ quotas: { ...d.tenant.quotas, [q.key]: e.target.value === "" ? null : Number(e.target.value) } })}
                className="field w-48"
              />
            </Field>
          ))}
          {part === "runtime" && <>
          <Field label="Uspat po nečinnosti (minut, 0 = nikdy)">
            <input type="number" min={0} max={1440} value={d.tenant.idleMinutes} onChange={(e) => tenant({ idleMinutes: Number(e.target.value) })} className="field w-48" />
          </Field>
          <Field label="Disk (GB)">
            <input type="number" min={1} max={500} value={d.tenant.storageGb} onChange={(e) => tenant({ storageGb: Number(e.target.value) })} className="field w-48" />
          </Field>
          </>}
      </section>}

      {part === "personalization" && <section className="space-y-4">
        <h2 className="section-header">Nový uživatel</h2>
        <p className="text-sm text-fg-secondary">Personalizace, se kterou uživatel začíná, dokud si v Personalizaci nenastaví vlastní.</p>
        <div className="flex flex-wrap gap-6">
          <Field label="Oslovení">
            <select value={d.user.address} onChange={(e) => user({ address: e.target.value as UserSettings["address"] })} className="field w-auto">
              <option value="auto">podle uživatele</option>
              <option value="ty">tykání</option>
              <option value="vy">vykání</option>
            </select>
          </Field>
          <Field label="Jazyk odpovědí">
            <select value={d.user.language} onChange={(e) => user({ language: e.target.value as UserSettings["language"] })} className="field w-auto">
              <option value="auto">podle uživatele</option>
              <option value="cs">čeština</option>
              <option value="sk">slovenčina</option>
            </select>
          </Field>
        </div>
        <Field label="Podpis">
          <textarea value={d.user.signature} onChange={(e) => user({ signature: e.target.value })} maxLength={1000} rows={3} className="field" />
        </Field>
        <Field label="Pokyny pro asistenta">
          <textarea
            value={d.user.instructions}
            onChange={(e) => user({ instructions: e.target.value })}
            placeholder="Např. Ceny uváděj vždy s DPH."
            maxLength={4000}
            rows={4}
            className="field"
          />
        </Field>
      </section>}

      {part === "persona" && <section>
        <p className="text-xs text-fg-muted">Platí, dokud si uživatel nenastaví vlastní. Prázdná = bez persony.</p>
        <PersonaEditor value={persona.description} onChange={setPersona} onGenerate={() => void generate()} busy={busy} />
      </section>}

      <ErrorNotice error={error} />
      <div className="flex items-center gap-3">
        <button disabled={busy} className="btn-primary">
          Uložit
        </button>
        {saved && <span className="text-sm text-success">Uloženo.</span>}
      </div>
    </form>
  );
}
