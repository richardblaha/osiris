import type { Scope } from "@osiris/shared";
import type { ReactNode } from "react";

/** Settings pages are shown twice: under "Moje nastavení" (personal) and "Nastavení tenanta" (tenant-wide). */
export interface ScopedProps {
  scope: Scope;
  /** Personal settings are always the user's; tenant-wide ones only a tenant admin may change. */
  canEdit: boolean;
}

export function PageHeader({ title, scope, canEdit, children }: ScopedProps & { title: string; children: ReactNode }) {
  return (
    <>
      <h1 className="section-header text-[13px]">
        {title} <span className="text-fg-muted">· {scope === "tenant" ? "tenant" : "osobní"}</span>
      </h1>
      <p className="mt-1 text-sm text-fg-secondary">{children}</p>
      <p className="mt-1 text-xs text-fg-muted">
        {scope === "personal"
          ? "Platí jen pro tebe."
          : canEdit
            ? "Platí pro všechny v tenantovi."
            : "Platí pro všechny v tenantovi. Měnit je může jen správce tenanta."}
      </p>
    </>
  );
}

export function ScopeBadge({ scope }: { scope: Scope | "bundled" }) {
  if (scope === "bundled") return <span className="badge">výchozí</span>;
  return scope === "tenant" ? <span className="badge badge-accent">tenant</span> : <span className="badge">osobní</span>;
}
