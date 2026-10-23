import type { Scope } from "@osiris/shared";
import { useId, type ReactNode } from "react";
import { t } from "i18next";

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
          {scope === "personal" ? t("scope.personal") : canEdit ? t("scope.tenant") : t("scope.tenantAdminOnly")}
        </p>
      )}
    </>
  );
}

export function ScopeBadge({ scope }: { scope: Scope | "bundled" }) {
  if (scope === "bundled") return <span className="badge align-middle">{t("badge.bundled")}</span>;
  return scope === "tenant" ? <span className="badge badge-accent align-middle">{t("badge.tenant")}</span> : <span className="badge align-middle">{t("badge.personal")}</span>;
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block space-y-1">
    <span className="section-header block">{label}</span>
    {children}
  </label>
);

export const ErrorNotice = ({ error }: { error?: string }) =>
  error ? <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p> : null;

/** The OSIRIS orbit loader: the pyramid breathing, two orbits in its base plane; in the theme's text colour. */
function OrbitLogo() {
  const id = useId();
  const orbits = (
    <>
      <ellipse className="orbit orbit-a" cx="100" cy="140" rx="90" ry="33.75" />
      <ellipse className="orbit orbit-b" cx="100" cy="140" rx="82" ry="30.75" />
    </>
  );
  return (
    <svg className="orbit-logo" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <clipPath id={`${id}r`}>
          <rect width="200" height="140" />
        </clipPath>
        <clipPath id={`${id}f`}>
          <rect y="140" width="200" height="60" />
        </clipPath>
      </defs>
      <g className="rear" clipPath={`url(#${id}r)`}>
        {orbits}
      </g>
      <g className="pyramid">
        <polygon points="100,30 20,130 100,170" />
        <polygon points="100,30 180,130 100,170" />
        <polygon className="shade" points="20,130 100,170 180,130 100,110" />
        <line className="axis" x1="100" y1="30" x2="100" y2="170" strokeWidth="2" />
      </g>
      <g clipPath={`url(#${id}f)`}>{orbits}</g>
    </svg>
  );
}

/**
 * A blurred veil with the orbit loader over its nearest positioned parent (give it `relative`) while data loads. It
 * fades in after a moment, so quick loads don't flash.
 */
export const Loading = ({ show }: { show: boolean }) =>
  show ? (
    <div role="status" aria-label={t("loading")} className="loading-overlay">
      <span className="orbit-loader">
        <OrbitLogo />
        <span className="loader-caption">{t("loadingCaption")}</span>
      </span>
    </div>
  ) : null;

/** The app's splash (the same as index.html's, before the code loads), while it signs in and loads the user. */
export const Splash = () => (
  <div className="splash" role="status" aria-label={t("loadingApp")}>
    <img src="/splash.svg" alt="" />
    <strong>OSIRIS</strong>
  </div>
);

/** In place of a part whose data hasn't come yet: the loading veil, or the error that stopped it. */
export const Pending = ({ error, className = "relative min-h-32" }: { error?: string; className?: string }) => (
  <div className={className}>
    <Loading show={!error} />
    <ErrorNotice error={error} />
  </div>
);

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
