import type { Scope } from "@osiris/shared";

/** Admins choose who a setting is for; everyone else always saves personal settings. */
export function ScopeSelect({ isAdmin, value, onChange, disabled }: {
  isAdmin: boolean;
  value: Scope;
  onChange: (scope: Scope) => void;
  disabled?: boolean;
}) {
  if (!isAdmin) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Scope)} disabled={disabled} className="field w-auto py-1.5 text-sm">
      <option value="personal">Jen pro mě</option>
      <option value="tenant">Pro celou firmu</option>
    </select>
  );
}

export function ScopeBadge({ scope }: { scope: Scope | "bundled" }) {
  if (scope === "bundled") return <span className="badge">výchozí</span>;
  return scope === "tenant" ? <span className="badge badge-accent">firma</span> : <span className="badge">osobní</span>;
}
