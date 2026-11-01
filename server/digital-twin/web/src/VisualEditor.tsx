import { t } from "i18next";
import { lazy, Suspense, useEffect, useState } from "react";
import { VISUAL_AXES, VISUAL_COLORS, VISUAL_PRESETS, VISUAL_SHAPES, visualErrors, type DtdlInterface, type DtdlVisual, type VisualPart } from "@osiris/shared/dtdl.ts";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";

/** The preview, with three.js, fetched the first time a drawing is edited. */
const VisualPreview = lazy(() => import("./VisualPreview.tsx"));

type V3 = [number, number, number];
/** The solid's proportions to try a drawing on: as wide as deep and lower, a cube, or upright. */
const PROPORTIONS = { flat: [4, 1.2, 4], cube: [3, 3, 3], tall: [2, 4, 2] } as const satisfies Record<string, V3>;
const vecText = (v: V3 | undefined) => (v ? v.join(", ") : "");
/** Three numbers from "x, y, z"; undefined when empty or not three numbers. */
const parseVec = (s: string): V3 | undefined => {
  const n = s.split(/[,\s]+/).filter(Boolean).map(Number);
  return n.length === 3 && n.every(Number.isFinite) ? (n as V3) : undefined;
};
/** A part without its keys left empty. */
const clean = (p: VisualPart): VisualPart => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "")) as VisualPart;

/**
 * A model's own drawing edited (`presentation.visual`): a preset to start from, over the look or instead of it, and
 * the parts — each a shape (or a 3D asset) placed in the solid's frame as fractions of its size, with its colour and
 * what it follows — beside a preview of one solid of the model drawn by the 3D view's own components. Errors show as
 * the server would answer them.
 */
export function VisualEditor({ model, visual, onChange }: { model: DtdlInterface; visual?: DtdlVisual; onChange: (v: DtdlVisual | undefined) => void }) {
  const [proportions, setProportions] = useState<keyof typeof PROPORTIONS>("flat");
  const [assets, setAssets] = useState<string[]>([]);
  useEffect(() => void api.assets().then((a) => setAssets(a.map((x) => x.name)), () => {}), []);
  const parts = visual?.parts ?? [];
  const set = (change: Partial<DtdlVisual>) => {
    const next = { ...(visual ?? {}), ...change };
    const empty = !next.preset && !next.parts?.length && !next.mode;
    onChange(empty ? undefined : (Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as DtdlVisual));
  };
  const setPart = (i: number, change: Partial<VisualPart>) => set({ parts: parts.map((p, j) => (j === i ? clean({ ...p, ...change }) : p)) });
  const errors = visual ? visualErrors("", visual).map((e) => e.replace(/^: /, "")) : [];
  return (
    <section>
      <p className="section-header">{t("twin:visual.title")}</p>
      <p className="mt-1 max-w-3xl text-xs text-fg-muted">{t("twin:visual.help")}</p>
      <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-fg-secondary">
              {t("twin:visual.preset")}
              <select className="field py-1" value={visual?.preset ?? ""} onChange={(e) => set({ preset: e.target.value || undefined })}>
                <option value="">—</option>
                {Object.keys(VISUAL_PRESETS).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            {visual?.preset && (
              <button type="button" className="btn-link" onClick={() => set({ preset: undefined, parts: [...(VISUAL_PRESETS[visual.preset!]?.parts ?? []), ...parts] })}>
                {t("twin:visual.copyPreset")}
              </button>
            )}
            <label className="flex items-center gap-2 text-fg-secondary">
              {t("twin:visual.mode")}
              <select className="field py-1" value={visual?.mode ?? "add"} onChange={(e) => set({ mode: e.target.value === "replace" ? "replace" : undefined })}>
                <option value="add">{t("twin:visual.add")}</option>
                <option value="replace">{t("twin:visual.replace")}</option>
              </select>
            </label>
          </div>
          <ol className="space-y-2">
            {parts.map((p, i) => (
              <li key={i} className="rounded border border-line p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-fg-muted">{i + 1}.</span>
                  <select className="field py-0.5" value={p.shape} onChange={(e) => setPart(i, { shape: e.target.value as VisualPart["shape"], asset: e.target.value === "gltf" ? (p.asset ?? assets[0]) : undefined })}>
                    {VISUAL_SHAPES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  {p.shape === "gltf" && (
                    <select className="field py-0.5 font-mono" value={p.asset ?? ""} onChange={(e) => setPart(i, { asset: e.target.value })}>
                      <option value="">—</option>
                      {[...new Set([...assets, ...(p.asset ? [p.asset] : [])])].map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  )}
                  <select className="field py-0.5" value={p.color && !p.color.startsWith("#") ? p.color : p.color ? "#" : ""} onChange={(e) => setPart(i, { color: e.target.value === "#" ? "#00c8ff" : (e.target.value as VisualPart["color"]) || undefined })}>
                    <option value="">{t("twin:visual.colorDefault")}</option>
                    {VISUAL_COLORS.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                    <option value="#">#rrggbb</option>
                  </select>
                  {p.color?.startsWith("#") && <input type="color" className="h-6 w-8" value={p.color} onChange={(e) => setPart(i, { color: e.target.value as VisualPart["color"] })} />}
                  <label className="flex items-center gap-1">
                    {t("twin:visual.opacity")}
                    <input className="field w-14 px-1 py-0.5" type="number" min={0} max={1} step={0.05} value={p.opacity ?? ""} onChange={(e) => setPart(i, { opacity: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={!!p.outline} onChange={(e) => setPart(i, { outline: e.target.checked || undefined })} />
                    {t("twin:visual.outline")}
                  </label>
                  <span className="ms-auto flex gap-1">
                    <button type="button" className="btn-link" title={t("twin:visual.duplicate")} aria-label={t("twin:visual.duplicate")} onClick={() => set({ parts: [...parts.slice(0, i + 1), { ...p }, ...parts.slice(i + 1)] })}>
                      <Icon name="add" className="h-4 w-4" />
                    </button>
                    <button type="button" className="btn-link" title={t("twin:visual.remove")} aria-label={t("twin:visual.remove")} onClick={() => set({ parts: parts.filter((_, j) => j !== i) })}>
                      <Icon name="delete" className="h-4 w-4" />
                    </button>
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-3 gap-y-1">
                  <VecField label={t("twin:visual.at")} value={p.at} onChange={(at) => setPart(i, { at })} />
                  <VecField label={t("twin:visual.size")} value={p.size} onChange={(size) => setPart(i, { size })} />
                  <VecField label={t("twin:visual.rotate")} value={p.rotate} onChange={(rotate) => setPart(i, { rotate })} />
                  <TextField label={t("twin:visual.when")} value={p.when} placeholder="status=error" onChange={(when) => setPart(i, { when })} />
                  <label className="flex items-center gap-1">
                    <span className="w-14 text-fg-muted">{t("twin:visual.fill")}</span>
                    <input className="field w-20 px-1 py-0.5 font-mono" value={p.fill?.value ?? ""} placeholder="load" onChange={(e) => setPart(i, { fill: e.target.value ? { value: e.target.value, ...(p.fill?.axis ? { axis: p.fill.axis } : {}) } : undefined })} />
                    <select className="field py-0.5" value={p.fill?.axis ?? "y"} disabled={!p.fill} onChange={(e) => p.fill && setPart(i, { fill: { value: p.fill.value, axis: e.target.value as "x" | "y" | "z" } })}>
                      {VISUAL_AXES.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                  </label>
                  <TextField label={t("twin:visual.blink")} value={p.blink} placeholder="io, network" onChange={(blink) => setPart(i, { blink })} />
                  <TextField label={t("twin:visual.spin")} value={p.spin === undefined ? undefined : String(p.spin)} placeholder="0.5" onChange={(s) => setPart(i, { spin: s === undefined ? undefined : Number.isFinite(Number(s)) ? Number(s) : s })} />
                  <label className="flex items-center gap-1">
                    <span className="w-14 text-fg-muted">{t("twin:visual.repeat")}</span>
                    <input className="field w-14 px-1 py-0.5 font-mono" value={p.repeat?.count ?? ""} placeholder="4" onChange={(e) => setPart(i, { repeat: e.target.value ? { step: p.repeat?.step ?? 0.25, ...(p.repeat?.axis ? { axis: p.repeat.axis } : {}), count: Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : e.target.value } : undefined })} />
                    <select className="field py-0.5" value={p.repeat?.axis ?? "x"} disabled={!p.repeat} onChange={(e) => p.repeat && setPart(i, { repeat: { ...p.repeat, axis: e.target.value as "x" | "y" | "z" } })}>
                      {VISUAL_AXES.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                    <input className="field w-14 px-1 py-0.5" type="number" step={0.05} value={p.repeat?.step ?? ""} disabled={!p.repeat} onChange={(e) => p.repeat && setPart(i, { repeat: { ...p.repeat, step: Number(e.target.value) } })} />
                  </label>
                </div>
              </li>
            ))}
          </ol>
          <button type="button" className="btn-secondary px-2 py-0.5" onClick={() => set({ parts: [...parts, { shape: "box", size: [0.5, 0.5, 0.5] }] })}>
            + {t("twin:visual.addPart")}
          </button>
          {errors.length > 0 && (
            <ul className="notice notice-error px-3 py-2">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="h-64 overflow-hidden rounded border border-line bg-bg-editor">
            <Suspense fallback={null}>
              <VisualPreview model={model} visual={errors.length ? undefined : visual} size={PROPORTIONS[proportions]} />
            </Suspense>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
            {t("twin:visual.proportions")}
            {(Object.keys(PROPORTIONS) as (keyof typeof PROPORTIONS)[]).map((k) => (
              <button key={k} type="button" className={proportions === k ? "btn-primary px-2 py-0.5" : "btn-secondary px-2 py-0.5"} onClick={() => setProportions(k)}>
                {t(`twin:visual.shape.${k}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function VecField({ label, value, onChange }: { label: string; value?: V3; onChange: (v: V3 | undefined) => void }) {
  const [text, setText] = useState(vecText(value));
  useEffect(() => setText(vecText(value)), [value?.join()]);
  return (
    <label className="flex items-center gap-1">
      <span className="w-14 text-fg-muted">{label}</span>
      <input
        className="field w-28 px-1 py-0.5 font-mono"
        value={text}
        placeholder="x, y, z"
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) onChange(undefined);
          else {
            const v = parseVec(e.target.value);
            if (v) onChange(v);
          }
        }}
      />
    </label>
  );
}

function TextField({ label, value, placeholder, onChange }: { label: string; value?: string; placeholder?: string; onChange: (v: string | undefined) => void }) {
  return (
    <label className="flex items-center gap-1">
      <span className="w-14 text-fg-muted">{label}</span>
      <input className="field w-28 px-1 py-0.5 font-mono" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value || undefined)} />
    </label>
  );
}
