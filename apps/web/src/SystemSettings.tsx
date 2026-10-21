import { FEATURES, type Persona, type SystemDefaults, type TenantQuotas, type UserSettings } from "@osiris/shared";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Field } from "./Scope.tsx";
import { FEATURE_LABELS } from "./Tenants.tsx";

const QUOTAS: { key: keyof TenantQuotas; label: string }[] = [
  { key: "storageMb", label: "Soubory (MB)" },
  { key: "tokensPerMonth", label: "Tokeny modelu za měsíc" },
  { key: "members", label: "Uživatelé" },
  { key: "schedules", label: "Plánované úlohy" },
];

/** What new tenants and users start with (system admins); existing ones keep what they have. */
export function SystemSettings() {
  const [d, setD] = useState<SystemDefaults>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.admin.defaults().then(setD, (e: Error) => setError(e.message)), []);
  if (!d) return <div className="detail"><ErrorNotice error={error} /></div>;

  const tenant = (change: Partial<SystemDefaults["tenant"]>) => (setSaved(false), setD({ ...d, tenant: { ...d.tenant, ...change } }));
  const user = (change: Partial<SystemDefaults["user"]>) => (setSaved(false), setD({ ...d, user: { ...d.user, ...change } }));
  const persona = d.user.persona ?? { character: "", source: "", description: "" };
  const setPersona = (change: Partial<Persona>) => {
    const next = { ...persona, ...change };
    user({ persona: next.character || next.source || next.description ? next : null });
  };
  const generate = () =>
    attempt(setBusy, setError, async () => setPersona({ description: (await api.generatePersona(persona.character, persona.source)).description }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = d.user.persona;
    if (p && !p.description.trim()) return setError("Persona potřebuje popis (tlačítko Nastavit), nebo ji celou vymaž.");
    const body = { ...d, user: { ...d.user, persona: p && { ...p, character: p.character.trim() || "Vlastní" } } };
    void attempt(setBusy, setError, async () => (setD(await api.admin.saveDefaults(body)), setSaved(true)));
  };

  return (
    <form onSubmit={submit} className="detail max-w-3xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Nastavení</h1>
        <p className="mt-1 text-sm text-fg-secondary">Výchozí hodnoty pro nové tenanty a uživatele. Stávající si nechávají svoje.</p>
      </div>

      <section className="space-y-4">
        <h2 className="section-header">Nový tenant</h2>
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
        <div className="grid gap-3 sm:grid-cols-2">
          {QUOTAS.map((q) => (
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
          <Field label="Uspat po nečinnosti (minut, 0 = nikdy)">
            <input type="number" min={0} max={1440} value={d.tenant.idleMinutes} onChange={(e) => tenant({ idleMinutes: Number(e.target.value) })} className="field w-48" />
          </Field>
          <Field label="Disk (GB)">
            <input type="number" min={1} max={500} value={d.tenant.storageGb} onChange={(e) => tenant({ storageGb: Number(e.target.value) })} className="field w-48" />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
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
        <div>
          <span className="text-sm font-medium">Persona</span>
          <p className="text-xs text-fg-muted">Platí, dokud si uživatel nenastaví vlastní. Prázdná = bez persony.</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <Field label="Postava">
              <input value={persona.character} onChange={(e) => setPersona({ character: e.target.value })} maxLength={100} placeholder="např. Sherlock Holmes" className="field w-56" />
            </Field>
            <Field label="Z knihy nebo filmu">
              <input value={persona.source} onChange={(e) => setPersona({ source: e.target.value })} maxLength={150} placeholder="např. Pes baskervillský" className="field w-64" />
            </Field>
            <button type="button" disabled={busy || !persona.character.trim()} onClick={() => void generate()} className="btn-secondary">
              Nastavit
            </button>
          </div>
          <textarea
            value={persona.description}
            onChange={(e) => setPersona({ description: e.target.value })}
            placeholder="Popis persony (vygeneruje se tlačítkem Nastavit, nebo ho napiš sám)"
            maxLength={2000}
            rows={5}
            className="field mt-2"
          />
        </div>
      </section>

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
