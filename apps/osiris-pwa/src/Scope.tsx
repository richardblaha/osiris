import type { Scope } from "@osiris/shared";
import type { ReactNode } from "react";
import { t } from "i18next";

/** What every detail form gets. Records are the project's or the viewer's own. */
export interface DetailProps<T> {
  /** The record shown, or undefined for a new one. */
  item?: T;
  /** Where a new record goes unless the admin picks otherwise: the project for admins, their own for everyone else. */
  scope: Scope;
  isAdmin: boolean;
  /** After a save: the list is reloaded and the saved record (by its sidebar key) selected. */
  onSaved: (key: string) => void;
  onDeleted: () => void;
}

/** The project's records are the admins' to change; everyone changes their own. */
export const canEdit = (scope: Scope, isAdmin: boolean) => scope === "personal" || isAdmin;

export function DetailHeader({ title, scope, canEdit, overridden, children }: { title: string; scope?: Scope; canEdit: boolean; overridden?: boolean; children?: ReactNode }) {
  return (
    <>
      <h1 className="text-lg font-semibold break-words">
        {title} {scope && <ScopeBadge scope={scope} />} {overridden && <OverriddenBadge />}
      </h1>
      {children && <p className="mt-1 text-sm text-fg-secondary">{children}</p>}
      {scope && (
        <p className="mt-1 text-xs text-fg-muted">
          {scope === "personal" ? t("scope.personal") : canEdit ? t("scope.project") : t("scope.projectAdminOnly")}
        </p>
      )}
      {overridden && <p className="notice mt-3 px-3 py-2 text-sm">{t("scope.overridden")}</p>}
    </>
  );
}

export function ScopeBadge({ scope }: { scope: Scope | "bundled" }) {
  if (scope === "bundled") return <span className="badge align-middle">{t("badge.bundled")}</span>;
  return scope === "project" ? <span className="badge badge-accent align-middle">{t("badge.project")}</span> : <span className="badge align-middle">{t("badge.personal")}</span>;
}

/** A project record the viewer's own copy replaces for them. */
export const OverriddenBadge = () => <span className="badge align-middle text-fg-muted">{t("badge.overridden")}</span>;

/** Where a new record goes: admins choose the project or themselves; everyone else always keeps their own. */
export function ScopeChoice({ value, onChange, isAdmin }: { value: Scope; onChange: (scope: Scope) => void; isAdmin: boolean }) {
  if (!isAdmin) return null;
  return (
    <fieldset className="flex flex-wrap items-center gap-4 text-sm">
      <legend className="section-header mb-1">{t("scope.choose")}</legend>
      <label className="flex items-center gap-1">
        <input type="radio" checked={value === "project"} onChange={() => onChange("project")} /> {t("scope.forProject")}
      </label>
      <label className="flex items-center gap-1">
        <input type="radio" checked={value === "personal"} onChange={() => onChange("personal")} /> {t("scope.forMe")}
      </label>
    </fieldset>
  );
}

/** On a project record the viewer may not change: make their own copy, which then replaces it for them. */
export function OwnCopy({ onClick, busy, label = t("scope.makeCopy") }: { onClick: () => void; busy?: boolean; label?: string }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={onClick} disabled={busy} className="btn-secondary text-sm">
        {label}
      </button>
      <span className="text-xs text-fg-muted">{t("scope.copyHint")}</span>
    </div>
  );
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block space-y-1">
    <span className="section-header block">{label}</span>
    {children}
  </label>
);

export const ErrorNotice = ({ error }: { error?: string }) =>
  error ? <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p> : null;

/**
 * The loader: the k6labs pyramid turning about its vertical axis (`/splash.svg`, the same as the splash); with reduced
 * motion, the still logo.
 */
const PyramidLogo = () => (
  <img className="pyramid-logo" src={matchMedia("(prefers-reduced-motion: reduce)").matches ? "/favicon.svg" : "/splash.svg"} alt="" aria-hidden="true" />
);

/**
 * A blurred veil with the pyramid loader over its nearest positioned parent (give it `relative`) while data loads. It
 * fades in after a moment, so quick loads don't flash.
 */
export const Loading = ({ show }: { show: boolean }) =>
  show ? (
    <div role="status" aria-label={t("loading")} className="loading-overlay">
      <span className="pyramid-loader">
        <PyramidLogo />
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
