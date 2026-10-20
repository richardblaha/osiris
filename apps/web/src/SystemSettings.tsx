import { FEATURES, type SystemDefaults, type TenantQuotas, type UserSettings } from "@osiris/shared";
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void attempt(setBusy, setError, async () => (setD(await api.admin.saveDefaults(d)), setSaved(true)));
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
        <p className="text-sm text-fg-secondary">Jak s uživatelem asistent jedná, dokud si v Personalizaci nenastaví vlastní.</p>
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
