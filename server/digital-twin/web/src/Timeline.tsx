import { t } from "i18next";
import { useEffect, useState } from "react";
import { formatDateTime } from "./i18n.ts";

const STEP = 5 * 60_000;

/**
 * The twin's time axis under the 3D view: live by default; dragging goes back to any five minutes of the recorded
 * history (from its first checkpoint), and "Live" returns. The chosen time is reported only once the slider rests.
 */
export function Timeline({ from, at, onChange, className }: { from: number; at: number | null; onChange: (at: number | null) => void; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [value, setValue] = useState(at ?? now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => setValue(at ?? now), [at, now]);
  // Report the time once the slider rests, not on every pixel of the drag.
  useEffect(() => {
    if (at === null && value >= now - STEP) return;
    if (value === at) return;
    const id = setTimeout(() => onChange(value >= now - STEP ? null : value), 350);
    return () => clearTimeout(id);
  }, [value]);

  const min = Math.floor(from / STEP) * STEP;
  return (
    <div className={`flex items-center gap-3 px-4 py-2 text-xs ${className ?? "border-t border-line bg-sidebar"}`}>
      <button type="button" className={at === null ? "btn-primary px-2 py-1" : "btn-secondary px-2 py-1"} onClick={() => onChange(null)} title={t("twin:history.back")}>
        {t("twin:history.live")}
      </button>
      <input
        type="range"
        className="min-w-0 flex-1"
        min={min}
        max={now}
        step={STEP}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-label={t("twin:history.title")}
      />
      <span className={`w-44 shrink-0 text-end ${at === null ? "text-fg-muted" : "text-warning"}`}>
        {at === null ? formatDateTime(now) : t("twin:history.at", { time: formatDateTime(at) })}
      </span>
    </div>
  );
}
