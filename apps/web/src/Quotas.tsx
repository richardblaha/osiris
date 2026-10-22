import type { Meter, TenantQuotas, TenantUsage } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { Field } from "./Scope.tsx";
import { fileSize } from "./Files.tsx";

const FIELDS: { key: keyof TenantQuotas; label: string }[] = [
  { key: "storageMb", label: "Úložiště souborů (MB)" },
  { key: "tokensPerMonth", label: "AI tokeny za měsíc" },
  { key: "members", label: "Uživatelé" },
  { key: "schedules", label: "Plánované úlohy" },
  { key: "tokensPerUserMonth", label: "AI tokeny za měsíc na uživatele" },
  { key: "tables", label: "Tabulky databáze" },
  { key: "databaseMb", label: "Databáze (MB)" },
  { key: "dashboards", label: "Vlastní dashboardy" },
];

/** The system admin's quotas of a tenant; an empty field is no limit (storage: 80 % of the disk). */
export function QuotaForm({ quotas, busy, onSave }: { quotas: TenantQuotas; busy: boolean; onSave: (q: TenantQuotas) => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, quotas[f.key]?.toString() ?? ""])) as Record<keyof TenantQuotas, string>);
  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  const parsed = Object.fromEntries(FIELDS.map((f) => [f.key, parse(values[f.key])])) as unknown as TenantQuotas;
  const changed = FIELDS.some((f) => parsed[f.key] !== quotas[f.key]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(parsed);
  };
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-3">
      {FIELDS.map((f) => (
        <Field key={f.key} label={f.label}>
          <input
            type="number"
            min={f.key === "members" || f.key === "storageMb" || f.key === "databaseMb" ? 1 : 0}
            placeholder="bez limitu"
            value={values[f.key]}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            className="field w-36"
          />
        </Field>
      ))}
      <button disabled={busy || !changed} className="btn-secondary">
        Uložit kvóty
      </button>
    </form>
  );
}

const compact = new Intl.NumberFormat("cs-CZ", { notation: "compact", maximumFractionDigits: 1 });

const METERS: { key: keyof TenantUsage; label: string; format: (n: number) => string }[] = [
  { key: "storage", label: "Úložiště", format: fileSize },
  { key: "tokens", label: "AI tento měsíc", format: (n) => compact.format(n) },
  { key: "members", label: "Uživatelé", format: String },
  { key: "schedules", label: "Úlohy", format: String },
  { key: "userTokens", label: "Moje AI tento měsíc", format: (n) => compact.format(n) },
  { key: "tables", label: "Tabulky", format: String },
  { key: "database", label: "Databáze", format: fileSize },
  { key: "dashboards", label: "Dashboardy", format: String },
];

/** The tenant's quotas and how full they are, above the tenant in the sidebar; quotas without a limit are left out. */
export function QuotaMeters({ usage }: { usage: TenantUsage }) {
  const shown = METERS.filter((m) => usage[m.key].limit !== null);
  if (!shown.length) return null;
  return (
    <div className="space-y-1.5 px-2 pb-2 text-xs">
      {shown.map((m) => {
        const { used, limit } = usage[m.key] as Meter & { limit: number };
        const share = limit > 0 ? Math.min(1, used / limit) : 1;
        const tone = share >= 1 ? "bg-error" : share >= 0.8 ? "bg-warning" : "bg-primary";
        return (
          <div key={m.key}>
            <div className="flex justify-between text-fg-secondary">
              <span>{m.label}</span>
              <span>
                {m.format(used)} / {m.format(limit)}
              </span>
            </div>
            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-hover" role="meter" aria-label={m.label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
              <div className={`h-full ${tone}`} style={{ width: `${share * 100}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
