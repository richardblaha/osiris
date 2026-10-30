import { t } from "i18next";
import { useRef, useState } from "react";
import type { InstanceSummary } from "./api.ts";
import { usePopupClose } from "./Telemetry.tsx";

/**
 * The twin shown, in the bar: its name, and a menu of the other twins the user may see (with one twin and no admin
 * rights, just the name). Admins also find the twins' administration there.
 */
export function InstanceMenu({
  list,
  current,
  admin,
  onPick,
  onManage,
}: {
  list: InstanceSummary[];
  current?: string;
  admin: boolean;
  onPick: (id: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  usePopupClose(open, box, () => setOpen(false));
  const shown = list.find((i) => i.id === current);
  if (list.length <= 1 && !admin) return <span className="instance-button">{shown?.name}</span>;
  return (
    <div ref={box} className="relative">
      <button type="button" className="instance-button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={t("instances:choose")}>
        {shown?.name ?? t("instances:choose")} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu-popup start-0 w-64" role="menu" aria-label={t("instances:choose")}>
          <p className="section-header px-3 py-1">{t("instances:choose")}</p>
          {list.map((i) => (
            <button
              key={i.id}
              role="menuitemradio"
              aria-checked={i.id === current}
              type="button"
              className="list-row block w-full px-3 py-1.5 text-start text-sm"
              data-active={i.id === current}
              onClick={() => (setOpen(false), onPick(i.id))}
            >
              <span className="block truncate">{i.name}</span>
              {i.error && <span className="block truncate text-xs text-error">{t("instances:failing")}</span>}
            </button>
          ))}
          {admin && (
            <button role="menuitem" type="button" className="list-row block w-full border-t border-line px-3 py-1.5 text-start text-sm text-primary" onClick={() => (setOpen(false), onManage())}>
              {t("instances:manage")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
