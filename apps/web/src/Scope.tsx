import type { Scope } from "@osiris/shared";
import type { ReactNode } from "react";

/**
 * What every detail form gets. Settings records are personal (the user's own) or tenant-wide (managed by admins);
 * the sidebar lists both, and a new record is personal unless an admin picks the tenant.
 */
export interface DetailProps<T> {
  /** The record shown, or undefined for a new one. */
  item?: T;
  isAdmin: boolean;
  /** After a save: the list is reloaded and the saved record (by its sidebar key) selected. */
  onSaved: (key: string) => void;
  onDeleted: () => void;
}

/** Personal records are always the user's; tenant-wide ones only a tenant admin may change. */
export const canEdit = (scope: Scope, isAdmin: boolean) => scope === "personal" || isAdmin;

export function DetailHeader({ title, scope, canEdit, children }: { title: string; scope?: Scope; canEdit: boolean; children?: ReactNode }) {
  return (
    <>
      <h1 className="text-lg font-semibold break-words">
        {title} {scope && <ScopeBadge scope={scope} />}
      </h1>
      {children && <p className="mt-1 text-sm text-fg-secondary">{children}</p>}
      {scope && (
        <p className="mt-1 text-xs text-fg-muted">
          {scope === "personal"
            ? "Platí jen pro tebe."
            : canEdit
              ? "Platí pro všechny v tenantovi."
              : "Platí pro všechny v tenantovi. Měnit ho může jen správce tenanta."}
        </p>
      )}
    </>
  );
}

/** For a new record: tenant admins choose who it is for, everyone else creates personal records only. */
export function ScopePicker({ value, onChange, isAdmin }: { value: Scope; onChange: (s: Scope) => void; isAdmin: boolean }) {
  if (!isAdmin) return null;
  return (
    <label className="block space-y-1">
      <span className="section-header block">Pro koho</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Scope)} className="field w-auto">
        <option value="personal">jen pro mě</option>
        <option value="tenant">pro celý tenant</option>
      </select>
    </label>
  );
}

export function ScopeBadge({ scope }: { scope: Scope | "bundled" }) {
  if (scope === "bundled") return <span className="badge align-middle">výchozí</span>;
  return scope === "tenant" ? <span className="badge badge-accent align-middle">tenant</span> : <span className="badge align-middle">osobní</span>;
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block space-y-1">
    <span className="section-header block">{label}</span>
    {children}
  </label>
);

export const ErrorNotice = ({ error }: { error?: string }) =>
  error ? <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p> : null;

/** Runs a form action with a busy flag and an error message. */
export async function attempt(setBusy: (b: boolean) => void, setError: (e?: string) => void, action: () => Promise<unknown>) {
  setBusy(true);
  setError(undefined);
  try {
    await action();
  } catch (err) {
    setError((err as Error).message);
  } finally {
    setBusy(false);
  }
}
