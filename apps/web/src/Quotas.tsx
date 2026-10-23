import type { Meter, TenantQuotas, TenantUsage } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { Field } from "./Scope.tsx";
import { fileSize } from "./Files.tsx";
import { t } from "i18next";
import { formatNumber } from "./i18n.ts";

export const QUOTA_KEYS: (keyof TenantQuotas)[] = ["storageMb", "tokensPerMonth", "members", "schedules", "tokensPerUserMonth", "tables", "databaseMb", "dashboards"];
export const quotaLabel = (key: keyof TenantQuotas) => t(`quotas:fields.${key}`);

/** The system admin's quotas of a tenant; an empty field is no limit (storage: 80 % of the disk). */
export function QuotaForm({ quotas, busy, onSave }: { quotas: TenantQuotas; busy: boolean; onSave: (q: TenantQuotas) => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(QUOTA_KEYS.map((k) => [k, quotas[k]?.toString() ?? ""])) as Record<keyof TenantQuotas, string>);
  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  const parsed = Object.fromEntries(QUOTA_KEYS.map((k) => [k, parse(values[k])])) as unknown as TenantQuotas;
  const changed = QUOTA_KEYS.some((k) => parsed[k] !== quotas[k]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(parsed);
  };
  return (
    <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-3">
      {QUOTA_KEYS.map((key) => (
        <Field key={key} label={quotaLabel(key)}>
          <input
            type="number"
            min={key === "members" || key === "storageMb" || key === "databaseMb" ? 1 : 0}
            placeholder={t("quotas:noLimit")}
            value={values[key]}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            className="field w-36"
          />
        </Field>
      ))}
      <button disabled={busy || !changed} className="btn-secondary">
        {t("quotas:save")}
      </button>
    </form>
  );
}

const compact = (n: number) => formatNumber(n, { notation: "compact", maximumFractionDigits: 1 });
const whole = (n: number) => formatNumber(n);

const METERS: { key: keyof TenantUsage; format: (n: number) => string }[] = [
  { key: "storage", format: fileSize },
  { key: "tokens", format: compact },
  { key: "members", format: whole },
  { key: "schedules", format: whole },
  { key: "userTokens", format: compact },
  { key: "tables", format: whole },
  { key: "database", format: fileSize },
  { key: "dashboards", format: whole },
];
const meterLabel = (key: keyof TenantUsage) => t(`quotas:meters.${key}`);

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
      <span className="truncate">{tenant ? `${tenant}${role ? ` · ${role}` : ""}` : t("quotas:noTenant")}</span>
      <span className="ms-auto flex min-w-0 items-center gap-4 overflow-hidden">
        {shown.map((m) => {
          const { used, limit } = usage![m.key] as Meter;
          const share = limit === null ? 0 : limit > 0 ? used / limit : 1;
          const state = share >= 1 ? t("quotas:exhausted") : share >= 0.8 ? t("quotas:runningOut") : null;
          const label = meterLabel(m.key);
          return (
            <span key={m.key} title={state ? `${label}: ${state}` : label} className={state ? "font-bold" : "opacity-90"}>
              {state && "⚠ "}
              {label} {m.format(used)}
              {limit !== null && ` / ${m.format(limit)}`}
            </span>
          );
        })}
      </span>
    </footer>
  );
}
