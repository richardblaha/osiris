import type { Scope } from "@osiris/shared";
import type { ReactNode } from "react";

/** What every detail form gets. Settings records are the tenant's. */
export interface DetailProps<T> {
  /** The record shown, or undefined for a new one. */
  item?: T;
  /** Always "tenant": settings are no longer personal. */
  scope: Scope;
  isAdmin: boolean;
  /** After a save: the list is reloaded and the saved record (by its sidebar key) selected. */
  onSaved: (key: string) => void;
  onDeleted: () => void;
}

/** Admin-only settings (skills, MCP servers, secrets) only a tenant admin may change. */
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
