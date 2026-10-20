import { FEATURES, type BuiltinTool } from "@osiris/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice } from "./Scope.tsx";
import { FEATURE_LABELS } from "./Tenants.tsx";

/** The Google and Microsoft tools (`<provider>_<area>_<action>`) are split by service. */
const INTEGRATION_GROUPS: Record<string, string> = {
  google_mail: "Google Mail",
  google_contacts: "Google kontakty",
  google_calendar: "Google kalendář",
  microsoft_mail: "Microsoft Outlook pošta",
  microsoft_contacts: "Microsoft kontakty",
  microsoft_calendar: "Microsoft kalendář",
};

interface Group {
  key: string;
  label: string;
  tools: BuiltinTool[];
}

/** By feature, the integrations' tools by service. */
function groups(tools: BuiltinTool[]): Group[] {
  return FEATURES.flatMap((f) => {
    const list = tools.filter((t) => t.feature === f);
    if (f !== "integrations") return list.length ? [{ key: f, label: FEATURE_LABELS[f].label, tools: list }] : [];
    const byService = new Map<string, BuiltinTool[]>();
    for (const t of list) {
      const key = t.name.split("_").slice(0, 2).join("_");
      byService.set(key, [...(byService.get(key) ?? []), t]);
    }
    return [...byService].map(([key, tools]) => ({ key, label: INTEGRATION_GROUPS[key] ?? key, tools }));
  });
}

/** Switches a whole group: off when all its tools are on, otherwise all on. */
function GroupSwitch({ group, disabled, onChange }: { group: Group; disabled: boolean; onChange: (on: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const on = group.tools.filter((t) => !t.disabled).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = on > 0 && on < group.tools.length;
  });
  return (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      className="switch"
      checked={on === group.tools.length}
      disabled={disabled}
      onChange={() => onChange(on < group.tools.length)}
      aria-label={`${group.label}: ${on < group.tools.length ? "zapnout vše" : "vypnout vše"}`}
    />
  );
}

/**
 * The assistant's built-in tools, grouped by feature (the Google and Microsoft ones by service). A system admin switches each one on or off for the tenant;
 * the runtime picks the change up within half a minute, so the list keeps the admin's choice rather than reloading.
 */
export function BuiltinTools({ tenantId, systemAdmin }: { tenantId: string; systemAdmin: boolean }) {
  const [tools, setTools] = useState<BuiltinTool[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.tools().then(setTools, (e: Error) => setError(e.message)), []);

  /** Switches these tools on or off. */
  const toggle = (names: string[], on: boolean) =>
    attempt(setBusy, setError, async () => {
      const next = tools!.map((t) => (names.includes(t.name) ? { ...t, disabled: !on } : t));
      await api.admin.updateTenant(tenantId, { disabledTools: next.filter((t) => t.disabled).map((t) => t.name) });
      setTools(next);
    });

  return (
    <section className="mt-6">
      <h2 className="section-header">Interní nástroje</h2>
      <p className="mt-1 text-xs text-fg-muted">
        {systemAdmin ? "Vypnutý nástroj asistent nepoužije. Změna se projeví do půl minuty." : "Nástroje, které asistent má. Zapíná a vypíná je správce systému."}
      </p>
      <ErrorNotice error={error} />
      {groups(tools ?? []).map((group) => {
        const featureOn = group.tools[0]!.featureOn;
        return (
          <div key={group.key} className="mt-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {systemAdmin && <GroupSwitch group={group} disabled={busy || !featureOn} onChange={(on) => void toggle(group.tools.map((t) => t.name), on)} />}
              {group.label}
              {!featureOn && <span className="badge">funkce vypnutá</span>}
            </h3>
            <ul className="mt-1 text-sm">
              {group.tools.map((t) => {
                const on = t.featureOn && !t.disabled;
                return (
                  <li key={t.name} className="flex items-start gap-3 py-1.5 pr-2 pl-6">
                    {systemAdmin ? (
                      <input
                        type="checkbox"
                        role="switch"
                        checked={!t.disabled}
                        disabled={busy || !t.featureOn}
                        onChange={() => void toggle([t.name], t.disabled)}
                        aria-label={`${t.name}: ${t.disabled ? "zapnout" : "vypnout"}`}
                        className="switch mt-0.5"
                      />
                    ) : (
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${on ? "bg-success" : "bg-line-strong"}`} aria-label={on ? "zapnuto" : "vypnuto"} />
                    )}
                    <span className={`min-w-0 flex-1 ${on ? "" : "text-fg-muted"}`}>
                      <code>{t.name}</code>
                      <span className="line-clamp-2 text-xs text-fg-secondary">{t.description}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
