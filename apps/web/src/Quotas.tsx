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

/** Shown even without a limit: what everyone wants to see at a glance. */
const ALWAYS = new Set<keyof TenantUsage>(["storage", "tokens"]);

/**
 * The bottom status bar: the active tenant and their role on the left, its use on the right (storage and tokens
 * always, the other quotas when they have a limit). A quota nearly or fully used says so in words, not only by colour.
 */
export function StatusBar({ tenant, role, usage }: { tenant?: string; role?: string; usage?: TenantUsage }) {
  const shown = usage ? METERS.filter((m) => ALWAYS.has(m.key) || usage[m.key].limit !== null) : [];
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 overflow-hidden bg-statusbar px-2.5 text-[11.5px] font-medium whitespace-nowrap text-on-statusbar">
      <span className="truncate">{tenant ? `${tenant}${role ? ` · ${role}` : ""}` : "bez tenanta"}</span>
      <span className="ml-auto flex min-w-0 items-center gap-4 overflow-hidden">
        {shown.map((m) => {
          const { used, limit } = usage![m.key] as Meter;
          const share = limit === null ? 0 : limit > 0 ? used / limit : 1;
          const state = share >= 1 ? "vyčerpáno" : share >= 0.8 ? "dochází" : null;
          return (
            <span key={m.key} title={state ? `${m.label}: ${state}` : m.label} className={state ? "font-bold" : "opacity-90"}>
              {state && "⚠ "}
              {m.label} {m.format(used)}
              {limit !== null && ` / ${m.format(limit)}`}
            </span>
          );
        })}
      </span>
    </footer>
  );
}
