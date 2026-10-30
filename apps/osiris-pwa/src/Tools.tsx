import { FEATURES, type BuiltinTool } from "@osiris/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { attempt, ErrorNotice, Loading } from "./Scope.tsx";
import { featureLabels } from "./Projects.tsx";
import { t as i18n } from "i18next";

/** The Google and Microsoft tools (`<provider>_<area>_<action>`) are split by service. */
const INTEGRATION_GROUPS = ["standard_accounts", "mail", "caldav", "carddav", "google_mail", "google_contacts", "google_calendar", "microsoft_mail", "microsoft_contacts", "microsoft_calendar"] as const;
const integrationGroup = (service: string) => ((INTEGRATION_GROUPS as readonly string[]).includes(service) ? i18n(`tools:groups.${service as (typeof INTEGRATION_GROUPS)[number]}`) : service);

/** Tools of a feature that form a tool of their own. */
const OWN_GROUPS: Record<string, { key: string; label: () => string }> = {
  render_template: { key: "templates", label: () => i18n("tools:groups.templates") },
  convert_to_pdf: { key: "pdf", label: () => "PDF" },
  resize_image: { key: "image", label: () => i18n("tools:groups.image") },
  build_vitepress_site: { key: "vitepress", label: () => "VitePress" },
};

interface Group {
  key: string;
  label: string;
  tools: BuiltinTool[];
}

/** By feature, the integrations' tools by service, and the tools in OWN_GROUPS each after their feature. */
function groups(tools: BuiltinTool[]): Group[] {
  return FEATURES.flatMap((f) => {
    const byKey = new Map<string, Group>();
    for (const t of tools.filter((t) => t.feature === f)) {
      const service = f === "integrations" ? (/^(mail|caldav|carddav)_/.test(t.name) ? t.name.split("_")[0] : t.name.split("_").slice(0, 2).join("_")) : undefined;
      const own = t.name.startsWith("image_") ? OWN_GROUPS.resize_image : OWN_GROUPS[t.name];
      const { key, label } = service ? { key: service, label: integrationGroup(service) } : own ? { key: own.key, label: own.label() } : { key: f, label: featureLabels()[f].label };
      const group = byKey.get(key) ?? byKey.set(key, { key, label, tools: [] }).get(key)!;
      group.tools.push(t);
    }
    // The feature's own group first.
    return [...byKey.values()].sort((a, b) => Number(b.key === f) - Number(a.key === f));
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
      aria-label={`${group.label}: ${on < group.tools.length ? i18n("tools:allOn") : i18n("tools:allOff")}`}
    />
  );
}

/**
 * The assistant's built-in tools, grouped by feature (the Google and Microsoft ones by service). A system admin switches each one on or off for the project.
 * Which are switched off is control's, read fresh from it: the runtime's own list may lag by half a minute (it caches its policy), and a change made from
 * that stale list would undo the one before it.
 */
export function BuiltinTools({ projectId, systemAdmin }: { projectId: string; systemAdmin: boolean }) {
  const [tools, setTools] = useState<BuiltinTool[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** The switched-off tools as control has them now (system admins). */
  const fresh = async () => new Set((await api.admin.project(projectId)).disabledTools);
  useEffect(() => {
    void Promise.all([api.tools(), systemAdmin ? fresh() : Promise.resolve(undefined)]).then(
      ([list, off]) => setTools(off ? list.map((t) => ({ ...t, disabled: off.has(t.name) })) : list),
      (e: Error) => setError(e.message),
    );
  }, []);

  /** Switches these tools on or off: the change applied to control's current list, not to what this page last saw. */
  const toggle = (names: string[], on: boolean) =>
    attempt(setBusy, setError, async () => {
      const off = await fresh();
      for (const name of names) on ? off.delete(name) : off.add(name);
      await api.admin.updateProject(projectId, { disabledTools: [...off] });
      setTools((list) => list?.map((t) => ({ ...t, disabled: off.has(t.name) })));
    });

  return (
    <section className="relative mt-6 min-h-32">
      <Loading show={!tools && !error} />
      <h2 className="section-header">{i18n("app:builtinTools")}</h2>
      <p className="mt-1 text-xs text-fg-muted">
        {systemAdmin ? i18n("tools:introAdmin") : i18n("tools:intro")}
      </p>
      <ErrorNotice error={error} />
      {groups(tools ?? []).map((group) => {
        const featureOn = group.tools[0]!.featureOn;
        return (
          <div key={group.key} className="mt-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {systemAdmin && <GroupSwitch group={group} disabled={busy || !featureOn} onChange={(on) => void toggle(group.tools.map((t) => t.name), on)} />}
              {group.label}
              {!featureOn && <span className="badge">{i18n("tools:featureOff")}</span>}
            </h3>
            <ul className="mt-1 text-sm">
              {group.tools.map((t) => {
                const on = t.featureOn && !t.disabled;
                return (
                  <li key={t.name} className="flex items-start gap-3 py-1.5 pe-2 pl-6">
                    {systemAdmin ? (
                      <input
                        type="checkbox"
                        role="switch"
                        checked={!t.disabled}
                        disabled={busy || !t.featureOn}
                        onChange={() => void toggle([t.name], t.disabled)}
                        aria-label={`${t.name}: ${t.disabled ? i18n("tools:on") : i18n("tools:off")}`}
                        className="switch mt-0.5"
                      />
                    ) : (
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${on ? "bg-success" : "bg-line-strong"}`} aria-label={on ? i18n("tools:isOn") : i18n("tools:isOff")} />
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
