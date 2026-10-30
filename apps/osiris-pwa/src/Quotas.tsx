import type { Meter, ProjectQuotas, ProjectUsage } from "@osiris/shared";
import { useState, type FormEvent } from "react";
import { Icon } from "./Icon.tsx";
import { Field } from "./Scope.tsx";
import { fileSize } from "./Files.tsx";
import { t } from "i18next";
import { formatNumber } from "./i18n.ts";

export const QUOTA_KEYS: (keyof ProjectQuotas)[] = ["storageMb", "tokensPerMonth", "members", "schedules", "tokensPerUserMonth", "tables", "databaseMb", "dashboards"];
export const quotaLabel = (key: keyof ProjectQuotas) => t(`quotas:fields.${key}`);

/** The system admin's quotas of a project; an empty field is no limit (storage: 80 % of the disk). */
export function QuotaForm({ quotas, busy, onSave }: { quotas: ProjectQuotas; busy: boolean; onSave: (q: ProjectQuotas) => void }) {
  const [values, setValues] = useState(() => Object.fromEntries(QUOTA_KEYS.map((k) => [k, quotas[k]?.toString() ?? ""])) as Record<keyof ProjectQuotas, string>);
  const parse = (v: string) => (v.trim() === "" ? null : Number(v));
  const parsed = Object.fromEntries(QUOTA_KEYS.map((k) => [k, parse(values[k])])) as unknown as ProjectQuotas;
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

const METERS: { key: keyof ProjectUsage; format: (n: number) => string }[] = [
  { key: "storage", format: fileSize },
  { key: "tokens", format: compact },
  { key: "members", format: whole },
  { key: "schedules", format: whole },
  { key: "userTokens", format: compact },
  { key: "tables", format: whole },
  { key: "database", format: fileSize },
  { key: "dashboards", format: whole },
];
const meterLabel = (key: keyof ProjectUsage) => t(`quotas:meters.${key}`);

/** Shown even without a limit: what everyone wants to see at a glance. */
const ALWAYS = new Set<keyof ProjectUsage>(["storage", "tokens"]);

/**
 * The bottom status bar: the active project and their role on the left, its use on the right (storage and tokens
 * always, the other quotas when they have a limit). A quota nearly or fully used says so in words, not only by colour.
 */
export function StatusBar({ project, role, usage }: { project?: string; role?: string; usage?: ProjectUsage }) {
  const shown = usage ? METERS.filter((m) => ALWAYS.has(m.key) || usage[m.key].limit !== null) : [];
  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-4 overflow-hidden bg-statusbar px-2.5 text-[11.5px] font-medium whitespace-nowrap text-on-statusbar">
      <span className="truncate">{project ? `${project}${role ? ` · ${role}` : ""}` : t("quotas:noProject")}</span>
      <span className="ms-auto flex min-w-0 items-center gap-4 overflow-hidden">
        {shown.map((m) => {
          const { used, limit } = usage![m.key] as Meter;
          const share = limit === null ? 0 : limit > 0 ? used / limit : 1;
          const state = share >= 1 ? t("quotas:exhausted") : share >= 0.8 ? t("quotas:runningOut") : null;
          const label = meterLabel(m.key);
          return (
            <span key={m.key} title={state ? `${label}: ${state}` : label} className={state ? "font-bold" : "opacity-90"}>
              {state && <Icon name="warning" className="me-1 h-4 w-4 align-[-0.2em]" />}
              {label} {m.format(used)}
              {limit !== null && ` / ${m.format(limit)}`}
            </span>
          );
        })}
      </span>
    </footer>
  );
}
