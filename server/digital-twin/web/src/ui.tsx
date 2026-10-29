import { t } from "i18next";

export const ErrorNotice = ({ error }: { error?: string }) =>
  error ? <p className="notice notice-error mt-3 px-3 py-2 text-sm">{error}</p> : null;

/**
 * The loader: the k6labs pyramid turning about its vertical axis (`/splash.svg`, the same as the splash before the app
 * loads); with reduced motion, the still logo.
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
    <div role="status" aria-label={t("common:loading")} className="loading-overlay">
      <span className="pyramid-loader">
        <PyramidLogo />
        <span className="loader-caption">{t("telemetry:loading")}</span>
      </span>
    </div>
  ) : null;

/** In place of a part whose data hasn't come yet: the loading veil, or the error that stopped it. */
export const Pending = ({ error, className = "relative min-h-32" }: { error?: string; className?: string }) => (
  <div className={className}>
    <Loading show={!error} />
    <ErrorNotice error={error} />
  </div>
);

/** Runs a data load with a busy flag and an error message. */
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
