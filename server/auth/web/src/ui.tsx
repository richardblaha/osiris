import type { ReactNode } from "react";
import { t } from "i18next";

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block space-y-1">
    <span className="section-header block">{label}</span>
    {children}
  </label>
);

export const ErrorNotice = ({ error }: { error?: string }) => (error ? <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p> : null);

/** In place of a part whose data hasn't come yet, or the error that stopped it. */
export const Pending = ({ error }: { error?: string }) =>
  error ? <ErrorNotice error={error} /> : <p role="status" className="py-6 text-sm text-fg-muted">{t("loading")}</p>;

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
