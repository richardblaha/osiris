import { t } from "i18next";
import { useMemo, useRef, useState } from "react";
import type { MaterialIcon } from "@osiris/shared/material-icons.ts";
import { Icon } from "./Icon.tsx";
import { usePopupClose } from "./Telemetry.tsx";
import { K8S_ICONS } from "./k8s-icons.ts";
import { ALL_LAYERS, DEFAULT_DISPLAY, LAYER_KEYS, type DisplayOptions, type Layers } from "./Twin3D.tsx";
import { INFRA_LAYERS, WORKLOAD_LAYERS, type TwinScene, type ViewFilters, type ViewLayer, type WorkloadLayer } from "./scene.ts";
import type { PanelId } from "./windowLayout.ts";

/** Each infrastructure layer's icon in the menu. */
const LAYER_ICONS: Record<(typeof INFRA_LAYERS)[number], MaterialIcon> = { hardware: "dashboard", network: "lan", services: "hub", storage: "storage", namespaces: "folder" };
/** Each kind of workload's Kubernetes icon (the generated, geometry-only markup of `k8s-icons.ts`). */
const WORKLOAD_ICONS: Record<WorkloadLayer, string> = { deployments: "deploy", statefulsets: "sts", daemonsets: "ds", jobs: "job", replicasets: "rs", standalonePods: "pod", otherWorkloads: "rs" };

/**
 * The view's settings, opened from the bottom bar (its button the "tune" icon) as a dialog over the whole window: the
 * layers to show — the hardware, the low-level network, the network services, storage, namespaces and each kind of
 * workload — how the twin is drawn (moving traffic), the windows, and the filters (which models,
 * statuses and names show). Escape, a click beside it or its close button closes it.
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
  /** How many workloads of each kind the scene has. */
  const workloads = useMemo(() => {
    const n = new Map<ViewLayer, number>();
    for (const v of scene?.byId.values() ?? []) if (!v.of && !v.isBand && v.look === "workload") n.set(v.layer as ViewLayer, (n.get(v.layer as ViewLayer) ?? 0) + 1);
    return n;
  }, [scene]);
  const off = LAYER_KEYS.filter((k) => !layers[k]).length;
  const filtered = filters.hiddenModels.size > 0 || !!filters.minStatus || !!filters.query;
  const setFilter = (change: (f: ViewFilters) => ViewFilters) => onFilters(change(filters));
  const reset = () => (onLayers(ALL_LAYERS), onDisplay(DEFAULT_DISPLAY), onFilters({ hiddenModels: new Set() }));
  const label = t("twin:display.title");
  // The whole view's settings, full screen: the layers, how the twin is drawn, the windows and the filters.
  const layerGroup = (group: "groupInfra" | "groupWorkloads", keys: readonly ViewLayer[]) => (
    <section key={group} className="display-section">
      <p className="section-header flex items-center">
        <span className="flex-1">{t(`twin:display.${group}`)}</span>
        {/* Key 6 shows the workloads alone. */}
        {group === "groupWorkloads" && <kbd className="text-[10px]">{INFRA_LAYERS.length + 1}</kbd>}
      </p>
      <ul className="mt-1 space-y-0.5">
        {keys.map((k: ViewLayer) => {
          const workload = (WORKLOAD_LAYERS as readonly string[]).includes(k);
          const n = workloads.get(k);
          // Keys 1–5 show one infrastructure layer alone.
          const key = workload ? "" : String(LAYER_KEYS.indexOf(k) + 1);
          return (
            <li key={k}>
              <label className="layer-row" data-on={layers[k]}>
                <input type="checkbox" className="sr-only" checked={layers[k]} onChange={(e) => onLayers({ ...layers, [k]: e.target.checked })} />
                {workload ? (
                  <svg className="k8s-icon h-5 w-5 shrink-0" viewBox={K8S_ICONS[WORKLOAD_ICONS[k as WorkloadLayer]]!.viewBox} aria-hidden="true" dangerouslySetInnerHTML={{ __html: K8S_ICONS[WORKLOAD_ICONS[k as WorkloadLayer]]!.body }} />
                ) : (
                  <Icon name={LAYER_ICONS[k as (typeof INFRA_LAYERS)[number]]} className="h-5 w-5 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">
                    {t(`twin:display.layer.${k}`)}
                    {workload && <span className="ms-1 text-xs text-fg-muted">{n ?? 0}</span>}
                  </span>
                  <span className="block text-xs text-fg-muted">{t(`twin:display.layerHelp.${k}`)}</span>
                </span>
                {key && <kbd className="text-[10px] text-fg-muted">{key}</kbd>}
                <span className="layer-switch" aria-hidden="true" />
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <div className="relative">
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
        <Icon name="tune" className="h-5 w-5" />
        {count !== undefined && <span className="text-xs text-fg-muted">{count}</span>}
      </button>
      {open && (
        <div className="display-backdrop">
          <div ref={box} className="display-dialog" role="dialog" aria-modal="true" aria-label={label}>
            <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
              <Icon name="tune" className="h-5 w-5 text-fg-muted" />
              <h2 className="flex-1 text-base font-semibold">{label}</h2>
              <button type="button" className="btn-link text-xs" onClick={reset}>
                <Icon name="restart_alt" className="me-0.5 h-3.5 w-3.5 align-[-0.15em]" />
                {t("twin:display.reset")}
              </button>
              <button type="button" className="wm-button" onClick={() => setOpen(false)} title={t("twin:display.close")} aria-label={t("twin:display.close")}>
                <Icon name="close" className="h-5 w-5" />
              </button>
            </header>
            <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4 md:grid-cols-2 xl:grid-cols-4">
              {layerGroup("groupInfra", INFRA_LAYERS)}
              {layerGroup("groupWorkloads", WORKLOAD_LAYERS)}

              <section className="display-section">
                <p className="section-header">{t("twin:display.drawing")}</p>
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={display.traffic} onChange={(e) => onDisplay({ ...display, traffic: e.target.checked })} />
                  {t("twin:display.traffic")}
                </label>

                <div className="mt-4 flex items-center gap-2">
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
                <p className="mt-4 text-xs text-fg-muted">{t("twin:display.hint")}</p>
              </section>

              <section className="display-section flex flex-col">
                <p className="section-header">{t("twin:display.filters")}</p>
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
                  <ul className="mt-2 space-y-0.5 text-xs">
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
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
