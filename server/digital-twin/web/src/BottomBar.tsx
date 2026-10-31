import { t } from "i18next";
import type { ReactNode } from "react";
import { Timeline } from "./Timeline.tsx";
import { DisplayMenu } from "./DisplayMenu.tsx";
import type { Layers } from "./Twin3D.tsx";
import type { TwinScene, ViewFilters } from "./scene.ts";

/**
 * The bar under the 3D view: the time axis (live, or a past recorded state), the display menu (the legend, the layers,
 * and the filters — which models, statuses and names show), and the chat with Osiris (its input here, the
 * conversation in a panel above the bar).
 */
export function BottomBar({
  historyFrom,
  at,
  onAt,
  layers,
  onLayers,
  filters,
  onFilters,
  scene,
  chat,
}: {
  historyFrom?: number;
  at: number | null;
  onAt: (at: number | null) => void;
  layers: Layers;
  onLayers: (l: Layers) => void;
  filters: ViewFilters;
  onFilters: (f: ViewFilters) => void;
  scene?: TwinScene;
  chat: ReactNode;
}) {
  return (
    <div className="bottom-bar" role="toolbar" aria-label={t("twin:bottomBar")}>
      {historyFrom !== undefined ? (
        <Timeline from={historyFrom} at={at} onChange={onAt} className="border-0 bg-transparent px-0 py-0" />
      ) : (
        <span className="px-2 text-xs text-fg-muted">{t("twin:history.live")}</span>
      )}
      <DisplayMenu layers={layers} onLayers={onLayers} filters={filters} onFilters={onFilters} scene={scene} inBar />
      <div className="relative flex min-w-0 flex-1 justify-end">{chat}</div>
    </div>
  );
}
