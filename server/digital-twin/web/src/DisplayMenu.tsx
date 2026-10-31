import { t } from "i18next";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { usePopupClose } from "./Telemetry.tsx";
import type { Layers } from "./Twin3D.tsx";
import type { TwinScene, ViewFilters } from "./scene.ts";

const C = "var(--accent-primary)";
const A = "var(--accent-active)";
const N = "var(--text-secondary)";
/** A small drawing of each kind of solid and line, as the 3D view draws it. */
const GLYPHS: Record<string, ReactNode> = {
  cluster: (
    <>
      <rect x="2" y="5" width="20" height="13" rx="2" fill="none" stroke={C} strokeWidth="1.5" />
      <path d="M2 18h20M6 18v-2M10 18v-2M14 18v-2M18 18v-2" stroke={C} strokeWidth="0.7" opacity="0.6" />
    </>
  ),
  node: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke={C} strokeWidth="1.6" />
      <rect x="8" y="14.5" width="8" height="1.2" fill="var(--state-success)" />
    </>
  ),
  namespace: <rect x="3" y="5" width="18" height="13" rx="2" fill="color-mix(in srgb, var(--accent-primary) 10%, transparent)" stroke={C} strokeWidth="1.2" strokeDasharray="3 2" />,
  workload: <rect x="4" y="6" width="16" height="11" rx="2" fill="none" stroke={C} strokeWidth="1" strokeDasharray="1 1.5" />,
  pod: <rect x="5" y="6" width="14" height="11" rx="3" fill="color-mix(in srgb, var(--accent-primary) 20%, transparent)" stroke={C} strokeWidth="1.2" />,
  container: <rect x="8" y="8" width="8" height="8" rx="1" fill="color-mix(in srgb, var(--accent-primary) 45%, transparent)" stroke={C} strokeWidth="1.2" />,
  volume: (
    <>
      <ellipse cx="12" cy="7" rx="6" ry="2" fill="none" stroke={C} />
      <path d="M6 7v10M18 7v10" stroke={C} />
      <ellipse cx="12" cy="17" rx="6" ry="2" fill="none" stroke={C} />
      <path d="M6 13a6 2 0 0 0 12 0v4a6 2 0 0 1-12 0z" fill="color-mix(in srgb, var(--accent-primary) 45%, transparent)" />
    </>
  ),
  disk: (
    <>
      <ellipse cx="12" cy="6" rx="6" ry="2" fill="none" stroke={N} />
      <ellipse cx="12" cy="10" rx="5.5" ry="1.8" fill="none" stroke={N} opacity="0.7" />
      <ellipse cx="12" cy="14" rx="5.5" ry="1.8" fill="none" stroke={N} opacity="0.7" />
      <path d="M6 6v12M18 6v12" stroke={N} />
      <ellipse cx="12" cy="18" rx="6" ry="2" fill="none" stroke={N} />
    </>
  ),
  port: <rect x="9" y="9" width="6" height="6" rx="1" fill={C} />,
  service: <polygon points="12,4 19,8 19,16 12,20 5,16 5,8" fill="none" stroke={C} strokeWidth="1.3" />,
  ingress: <path d="M5 20V5h14v15M8 20V8h8v12" fill="none" stroke={C} strokeWidth="1.4" />,
  internet: (
    <>
      <circle cx="12" cy="12" r="7" fill="none" stroke={C} />
      <path d="M5 12h14M12 5c3 3 3 11 0 14M12 5c-3 3-3 11 0 14" fill="none" stroke={C} strokeWidth="0.7" />
    </>
  ),
  network: <path d="M3 12h18" stroke={C} strokeWidth="2" />,
  overlay: <path d="M3 12h18" stroke={C} strokeWidth="2" strokeDasharray="4 3" />,
  routing: <path d="M3 12h18" stroke={A} strokeWidth="2" strokeDasharray="2 2" />,
  mount: <path d="M3 12h18" stroke={N} strokeWidth="2" />,
};
const SOLIDS = ["cluster", "node", "namespace", "workload", "pod", "container", "volume", "disk", "port", "service", "ingress", "internet"] as const;
const LINES = ["network", "overlay", "routing", "mount"] as const;

const Glyph = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" aria-hidden="true">
    {GLYPHS[name]}
  </svg>
);

/**
 * The display menu in the bottom bar: the legend of the 3D view (what each shape and line means), the layers to show
 * (the network, storage, the logical groupings), and the filters — which models, statuses and names show. In the bar
 * (`inBar`) the popup opens upward from it, not as a floating panel.
 */
export function DisplayMenu({
  layers,
  onLayers,
  filters,
  onFilters,
  scene,
  inBar,
}: {
  layers: Layers;
  onLayers: (l: Layers) => void;
  filters?: ViewFilters;
  onFilters?: (f: ViewFilters) => void;
  scene?: TwinScene;
  inBar?: boolean;
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
  const count = scene ? String([...scene.byId.values()].filter((v) => !v.of).length) : "";
  const setFilter = (change: (f: ViewFilters) => ViewFilters) => onFilters?.(change(filters ?? { hiddenModels: new Set() }));
  return (
    <div ref={box} className={inBar ? "relative" : "twin-legend"}>
      <button type="button" className="legend-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        {t("twin:legend.title")} <span className="text-fg-muted">· {count}</span>
      </button>
      {open && (
        <div className={`menu-popup w-80 p-3 ${inBar ? "bottom-full start-0 mb-2" : "start-0"}`} role="dialog" aria-label={t("twin:legend.title")}>
          {filters && onFilters && (
            <>
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
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
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
              <p className="section-header mt-3">{t("twin:legend.layers")}</p>
            </>
          )}
          {!filters && <p className="section-header">{t("twin:legend.layers")}</p>}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {(["network", "storage", "logical"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={layers[k]} onChange={(e) => onLayers({ ...layers, [k]: e.target.checked })} />
                {t(`twin:legend.layer.${k}`)}
              </label>
            ))}
          </div>
          <p className="section-header mt-3">{t("twin:legend.solids")}</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {SOLIDS.map((k) => (
              <li key={k} className="flex items-center gap-2">
                <Glyph name={k} />
                {t(`twin:legend.solid.${k}`)}
              </li>
            ))}
          </ul>
          <p className="section-header mt-3">{t("twin:legend.lines")}</p>
          <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {LINES.map((k) => (
              <li key={k} className="flex items-center gap-2">
                <Glyph name={k} />
                {t(`twin:legend.line.${k}`)}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-fg-muted">{t("twin:legend.hint")}</p>
        </div>
      )}
    </div>
  );
}
