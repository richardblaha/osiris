import { t } from "i18next";
import { useId } from "react";

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
    <div role="status" aria-label={t("common:loading")} className="loading-overlay">
      <span className="orbit-loader">
        <OrbitLogo />
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
