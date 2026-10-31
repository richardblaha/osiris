import { t } from "i18next";
import { useMemo, useRef, useState } from "react";
import type { MaterialIcon } from "@osiris/shared/material-icons.ts";
import { Icon } from "./Icon.tsx";
import { usePopupClose } from "./Telemetry.tsx";
import { ALL_LAYERS, DEFAULT_DISPLAY, LAYER_KEYS, type DisplayOptions, type Layers } from "./Twin3D.tsx";
import type { TwinScene, ViewFilters } from "./scene.ts";
import type { PanelId } from "./windowLayout.ts";

/** Each layer's icon in the menu. */
const LAYER_ICONS: Record<(typeof LAYER_KEYS)[number], MaterialIcon> = { network: "lan", services: "hub", storage: "storage", logical: "account_tree" };

/**
 * The display menu in the bottom bar (its button an icon): the layers to show — the low-level network, the network
 * services, storage, the logical groupings — how the twin is drawn (labels, addresses, moving traffic), and the
 * filters (which models, statuses and names show). It opens upward from the bar, within the window.
 */
export function DisplayMenu({
  layers,
  onLayers,
  display,
  onDisplay,
  filters,
  onFilters,
  scene,
  windows,
}: {
  layers: Layers;
  onLayers: (l: Layers) => void;
  display: DisplayOptions;
  onDisplay: (d: DisplayOptions) => void;
  filters: ViewFilters;
  onFilters: (f: ViewFilters) => void;
  scene?: TwinScene;
  windows: { hidden: PanelId[]; show: (p: PanelId) => void; reset: () => void };
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  usePopupClose(open, box, () => setOpen(false));
  /** The models in the scene, with how many twins each has, for the filter's checkboxes. */
  const modelList = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const v of scene?.byId.values() ?? []) {
      if (v.of || v.isBand) continue;
      const e = m.get(v.model) ?? { name: v.modelName, n: 0 };
      e.n++;
      m.set(v.model, e);
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [scene]);
  const count = scene ? [...scene.byId.values()].filter((v) => !v.of).length : undefined;
  const off = LAYER_KEYS.filter((k) => !layers[k]).length;
  const filtered = filters.hiddenModels.size > 0 || !!filters.minStatus || !!filters.query;
  const setFilter = (change: (f: ViewFilters) => ViewFilters) => onFilters(change(filters));
  const reset = () => (onLayers(ALL_LAYERS), onDisplay(DEFAULT_DISPLAY), onFilters({ hiddenModels: new Set() }));
  const label = t("twin:display.title");
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="display-button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        aria-label={label}
        data-changed={off > 0 || filtered}
      >
        <Icon name="layers" className="h-5 w-5" />
        {count !== undefined && <span className="text-xs text-fg-muted">{count}</span>}
      </button>
      {open && (
        <div className="menu-popup menu-up start-0 w-80 p-3" role="dialog" aria-label={label}>
          <div className="flex items-center gap-2">
            <p className="section-header flex-1">{t("twin:display.layers")}</p>
            <button type="button" className="btn-link text-xs" onClick={reset}>
              {t("twin:display.reset")}
            </button>
          </div>
          <ul className="mt-1 space-y-0.5">
            {LAYER_KEYS.map((k, i) => (
              <li key={k}>
                <label className="layer-row" data-on={layers[k]}>
                  <input type="checkbox" className="sr-only" checked={layers[k]} onChange={(e) => onLayers({ ...layers, [k]: e.target.checked })} />
                  <Icon name={LAYER_ICONS[k]} className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{t(`twin:display.layer.${k}`)}</span>
                    <span className="block text-xs text-fg-muted">{t(`twin:display.layerHelp.${k}`)}</span>
                  </span>
                  <kbd className="text-[10px] text-fg-muted">{i + 1}</kbd>
                  <span className="layer-switch" aria-hidden="true" />
                </label>
              </li>
            ))}
          </ul>

          <p className="section-header mt-3">{t("twin:display.drawing")}</p>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <span className="flex-1">{t("twin:display.labels")}</span>
            <select className="field py-0.5 text-xs" value={display.labels} onChange={(e) => onDisplay({ ...display, labels: e.target.value as DisplayOptions["labels"] })}>
              {(["auto", "all", "off"] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`twin:display.labelMode.${v}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={display.addresses} onChange={(e) => onDisplay({ ...display, addresses: e.target.checked })} />
            {t("twin:display.addresses")}
          </label>
          <label className="mt-1 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={display.traffic} onChange={(e) => onDisplay({ ...display, traffic: e.target.checked })} />
            {t("twin:display.traffic")}
          </label>

          <div className="mt-3 flex items-center gap-2">
            <p className="section-header flex-1">{t("twin:windows.title")}</p>
            <button type="button" className="btn-link text-xs" onClick={windows.reset}>
              <Icon name="restart_alt" className="me-0.5 h-3.5 w-3.5 align-[-0.15em]" />
              {t("twin:windows.reset")}
            </button>
          </div>
          {windows.hidden.length ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {windows.hidden.map((p) => (
                <li key={p}>
                  <button type="button" className="btn-secondary px-2 py-0.5 text-xs" onClick={() => windows.show(p)}>
                    {t("twin:windows.show", { name: t(`twin:windows.panel.${p}`) })}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-fg-muted">{t("twin:windows.help")}</p>
          )}

          <p className="section-header mt-3">{t("twin:display.filters")}</p>
          <input
            className="field mt-1 w-full px-2 py-1 text-xs"
            placeholder={t("twin:display.search")}
            value={filters.query ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value || undefined }))}
          />
          <select className="field mt-1 w-full py-1 text-xs" value={filters.minStatus ?? ""} onChange={(e) => setFilter((f) => ({ ...f, minStatus: (e.target.value || undefined) as ViewFilters["minStatus"] }))}>
            <option value="">{t("twin:display.anyStatus")}</option>
            <option value="warn">{t("twin:display.warnUp")}</option>
            <option value="error">{t("twin:display.errorOnly")}</option>
          </select>
          {modelList.length > 0 && (
            <ul className="mt-1 max-h-36 space-y-0.5 overflow-y-auto text-xs">
              {modelList.map(([id, m]) => (
                <li key={id}>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!filters.hiddenModels.has(id)}
                      onChange={(e) =>
                        setFilter((f) => {
                          const hiddenModels = new Set(f.hiddenModels);
                          if (e.target.checked) hiddenModels.delete(id);
                          else hiddenModels.add(id);
                          return { ...f, hiddenModels };
                        })
                      }
                    />
                    <span className="break-all" title={id}>
                      {m.name} <span className="text-fg-muted">×{m.n}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-fg-muted">{t("twin:display.hint")}</p>
        </div>
      )}
    </div>
  );
}
