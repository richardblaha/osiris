import { t } from "i18next";
import type { ReactNode } from "react";
import type { MaterialIcon } from "@osiris/shared/material-icons.ts";
import { Icon } from "./Icon.tsx";
import { Timeline } from "./Timeline.tsx";
import { DisplayMenu } from "./DisplayMenu.tsx";
import type { DisplayOptions, Layers } from "./Twin3D.tsx";
import type { TwinScene, ViewFilters } from "./scene.ts";
import { PANELS, type PanelId } from "./windowLayout.ts";

/** Each panel's button in the bar, with the icon its window has. */
const PANEL_ICONS: Record<PanelId, MaterialIcon> = { properties: "deployed_code", logs: "description", metrics: "bar_chart", traces: "schedule", chat: "chat" };

/**
 * The bar under the 3D view: the time axis (live, or a past recorded state), the display menu (the layers, how the
 * twin is drawn, and the filters — which models, statuses and names show), a button per panel that shows or closes
 * it (the selection's four need a selection), and the chat with Osiris (its input here, its answers in a window).
 */
export function BottomBar({
  historyFrom,
  at,
  onAt,
  layers,
  onLayers,
  display,
  onDisplay,
  filters,
  onFilters,
  scene,
  chat,
  windows,
}: {
  historyFrom?: number;
  at: number | null;
  onAt: (at: number | null) => void;
  layers: Layers;
  onLayers: (l: Layers) => void;
  display: DisplayOptions;
  onDisplay: (d: DisplayOptions) => void;
  filters: ViewFilters;
  onFilters: (f: ViewFilters) => void;
  scene?: TwinScene;
  chat: ReactNode;
  /**
   * The windows over the twin: the panels the user closed, showing one again, the default layout, and for the bar's
   * buttons which panels show and which could, and showing or closing one.
   */
  windows: { hidden: PanelId[]; show: (p: PanelId) => void; reset: () => void; shown: ReadonlySet<PanelId>; available: ReadonlySet<PanelId>; toggle: (p: PanelId) => void };
}) {
  return (
    <div className="bottom-bar" role="toolbar" aria-label={t("twin:bottomBar")}>
      {historyFrom !== undefined ? (
        <Timeline from={historyFrom} at={at} onChange={onAt} className="border-0 bg-transparent px-0 py-0" />
      ) : (
        <span className="px-2 text-xs text-fg-muted">{t("twin:history.live")}</span>
      )}
      <DisplayMenu layers={layers} onLayers={onLayers} display={display} onDisplay={onDisplay} filters={filters} onFilters={onFilters} scene={scene} windows={windows} />
      <div className="panel-toggles" role="group" aria-label={t("twin:windows.panels")}>
        {PANELS.map((p) => {
          const name = t(`twin:windows.panel.${p}`);
          const shown = windows.shown.has(p);
          const label = !windows.available.has(p) ? t("twin:windows.needsSelection", { name }) : shown ? t("twin:windows.hide", { name }) : t("twin:windows.open", { name });
          return (
            <button key={p} type="button" className="panel-toggle" aria-pressed={shown} disabled={!windows.available.has(p)} onClick={() => windows.toggle(p)} title={label} aria-label={label}>
              <Icon name={PANEL_ICONS[p]} className="h-5 w-5" />
            </button>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 justify-end">{chat}</div>
    </div>
  );
}
