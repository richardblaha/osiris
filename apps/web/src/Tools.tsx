import { FEATURES, type BuiltinTool } from "@osiris/shared";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice } from "./Scope.tsx";
import { FEATURE_LABELS } from "./Tenants.tsx";

/**
 * The assistant's built-in tools, grouped by feature. A system admin switches each one on or off for the tenant;
 * the runtime picks the change up within half a minute, so the list keeps the admin's choice rather than reloading.
 */
export function BuiltinTools({ tenantId, systemAdmin }: { tenantId: string; systemAdmin: boolean }) {
  const [tools, setTools] = useState<BuiltinTool[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => void api.tools().then(setTools, (e: Error) => setError(e.message)), []);

  const toggle = (tool: BuiltinTool) =>
    attempt(setBusy, setError, async () => {
      const next = tools!.map((t) => (t.name === tool.name ? { ...t, disabled: !t.disabled } : t));
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
      {FEATURES.map((f) => {
        const group = tools?.filter((t) => t.feature === f) ?? [];
        if (!group.length) return null;
        return (
          <div key={f} className="mt-3">
            <h3 className="text-sm font-medium">
              {FEATURE_LABELS[f].label}
              {!group[0]!.featureOn && <span className="ml-2 badge align-middle">funkce vypnutá</span>}
            </h3>
            <ul className="mt-1 text-sm">
              {group.map((t) => {
                const on = t.featureOn && !t.disabled;
                return (
                  <li key={t.name} className="flex items-start gap-3 px-2 py-1.5">
                    {systemAdmin ? (
                      <input
                        type="checkbox"
                        checked={!t.disabled}
                        disabled={busy || !t.featureOn}
                        onChange={() => void toggle(t)}
                        aria-label={`${t.name}: ${t.disabled ? "zapnout" : "vypnout"}`}
                        className="mt-1"
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
