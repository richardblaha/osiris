import { t } from "i18next";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { BUILTIN_LOOKS, LOOKS, PRESENTATION_CONTEXT, PRESENTATION_LAYERS, type DtdlContent, type DtdlInterface, type DtdlModelData, type DtdlPresentation, type Localized, PRIMITIVE_SCHEMAS, type DtdlSchema } from "@osiris/shared/dtdl.ts";
import { api, type ComponentInfo } from "./api.ts";
import { VisualEditor } from "./VisualEditor.tsx";
import { attempt, ErrorNotice } from "./ui.tsx";
import { currentLocale } from "./i18n.ts";

/** Monaco, fetched the first time the DTDL or TSX tab opens so the twin itself stays small. */
const CodeEditor = lazy(() => import("./CodeEditor.tsx"));
const VisualPreview = lazy(() => import("./VisualPreview.tsx"));

const SCHEMAS = [...PRIMITIVE_SCHEMAS, "Enum", "Map", "Object", "Array"] as const;

/**
 * The twin's DTDL models, edited (admins only): a list of the interfaces and an editor with a visual form (contents,
 * and the `presentation` section that says how the 3D view draws the model's twins: shape, color, icon, label, layer)
 * and the raw DTDL. "Náhled" swaps the model in the view locally, "Uložit" sends it (validated on the server).
 */
export function Models({ models, onChanged, onPreview }: { models: DtdlModelData[]; onChanged: () => void; onPreview?: (doc: DtdlInterface) => void }) {
  const [id, setId] = useState<string>();
  const [tab, setTab] = useState<"visual" | "tsx" | "json">("visual");
  const [json, setJson] = useState("");
  const [components, setComponents] = useState<ComponentInfo[]>([]);
  const [tsxCode, setTsxCode] = useState("");
  const [previewSha256, setPreviewSha256] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = models.find((m) => m.id === id) ?? models[0];
  const draft = useMemo(() => {
    if (!selected) return undefined;
    try {
      return JSON.parse(json || JSON.stringify(selected.model, null, 2)) as DtdlInterface;
    } catch {
      return undefined;
    }
  }, [selected, json]);

  const loadComponents = () => {
    void api.components().then(setComponents).catch(() => {});
  };
  useEffect(loadComponents, [models]);

  const defaultTsxFor = (m: DtdlModelData, comps: ComponentInfo[]) => {
    const custom = comps.find((c) => c.target === m.id);
    if (custom) return { code: custom.code, sha256: custom.sha256, custom: !custom.builtIn };
    if (m.model.presentation?.component) return { code: m.model.presentation.component, sha256: undefined, custom: true };
    const look = m.model.presentation?.look ?? BUILTIN_LOOKS[m.id.replace(/;.*$/, "")] ?? "box";
    const fallback = comps.find((c) => c.target === look) ?? comps.find((c) => c.target === "box");
    return { code: fallback?.code ?? "", sha256: fallback?.sha256, custom: false };
  };

  useEffect(() => {
    if (!selected || !components.length) return;
    const def = defaultTsxFor(selected, components);
    setTsxCode(def.code);
    setPreviewSha256(def.sha256);
  }, [selected?.id, components]);

  const pick = (m: DtdlModelData) => {
    setId(m.id);
    setJson(JSON.stringify(m.model, null, 2));
    setError(undefined);
    setTab("visual");
    if (components.length) {
      const def = defaultTsxFor(m, components);
      setTsxCode(def.code);
      setPreviewSha256(def.sha256);
    }
  };

  const update = (change: (d: DtdlInterface) => DtdlInterface) => {
    if (!draft) return;
    setJson(JSON.stringify(change(draft), null, 2));
    setError(undefined);
  };
  const setLocalized = (key: "displayName" | "description", lang: "en" | "cs", value: string) =>
    update((d) => {
      const prev = d[key];
      const map: Record<string, string> = typeof prev === "string" ? { en: prev } : { ...(prev ?? {}) };
      if (value) map[lang] = value;
      else delete map[lang];
      return { ...d, [key]: Object.keys(map).length ? map : undefined };
    });
  const setPresentation = (change: (p: DtdlPresentation) => DtdlPresentation) =>
    update((d) => {
      const p = change({ ...(d.presentation ?? {}) });
      const contexts = Array.isArray(d["@context"]) ? [...d["@context"]] : [d["@context"]];
      return { ...d, "@context": [...new Set([...contexts, PRESENTATION_CONTEXT])], presentation: Object.keys(p).length ? p : undefined };
    });
  const contentChange = (i: number, change: (c: DtdlContent) => DtdlContent) =>
    update((d) => ({ ...d, contents: (d.contents ?? []).map((c, j) => (j === i ? change(c) : c)) }));
  const addContent = (type: DtdlContent["@type"]) =>
    update((d) => {
      const base = { name: type === "Relationship" ? "relatesTo" : type === "Telemetry" ? "telemetry" : "property", displayName: undefined as Localized | undefined };
      const c: DtdlContent =
        type === "Property" ? { "@type": "Property", ...base, schema: "string" }
        : type === "Telemetry" ? { "@type": "Telemetry", ...base, schema: "string" }
        : type === "Relationship" ? { "@type": "Relationship", ...base }
        : { "@type": "Command", ...base };
      return { ...d, contents: [...(d.contents ?? []), c] };
    });

  const save = () =>
    attempt(setBusy, setError, async () => {
      if (tab === "tsx" && selected) {
        const saved = await api.putComponent(selected.id, { kind: "model", code: tsxCode });
        setPreviewSha256(saved.sha256);
        loadComponents();
        onChanged();
        return;
      }
      if (!draft) throw new Error(t("twin:models.badJson"));
      await api.putModel(draft["@id"], draft);
      onChanged();
    });
  const resetComponent = () =>
    attempt(setBusy, setError, async () => {
      if (!selected) return;
      await api.deleteComponent(selected.id).catch(() => {});
      loadComponents();
      onChanged();
    });
  const remove = () =>
    attempt(setBusy, setError, async () => {
      if (!selected) return;
      await api.deleteModel(selected.id);
      setId(undefined);
      setJson("");
      onChanged();
    });
  const preview = () => {
    if (tab === "tsx") {
      void attempt(setBusy, setError, async () => {
        const res = await api.compileComponent(tsxCode);
        if (res.errors.length) throw new Error(res.errors.join("; "));
        setPreviewSha256(res.sha256);
      });
      return;
    }
    if (draft && onPreview) onPreview(draft);
  };
  const newModel = () => {
    const id = prompt(t("twin:models.newId"));
    if (!id) return;
    const doc: DtdlInterface = { "@context": "dtmi:dtdl:context;3", "@id": id, "@type": "Interface", displayName: { en: id.split(":").pop()?.replace(/;.*$/, "") ?? id } as Localized, extends: "dtmi:osiris:twin:Entity;1", contents: [] };
    setId(id);
    setJson(JSON.stringify(doc, null, 2));
    setTab("json");
    setError(undefined);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-72 shrink-0 overflow-y-auto border-e border-line p-3">
        <div className="flex items-center justify-between">
          <p className="section-header">{t("twin:models.title")}</p>
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={newModel}>
            {t("twin:models.new")}
          </button>
        </div>
        <ul className="mt-2 space-y-1">
          {models.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => pick(m)}
                className={`w-full break-all rounded px-2 py-1.5 text-start text-xs ${selected?.id === m.id ? "bg-accent/20 text-fg" : "text-fg-secondary hover:bg-line/40"}`}
                title={m.id}
              >
                {typeof m.model.displayName === "object" ? (m.model.displayName[currentLocale()] ?? m.model.displayName.en) : m.model.displayName ?? m.id.split(":").pop()}
                <span className="block break-all text-[10px] text-fg-muted">{m.id}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        <ErrorNotice error={error} />
        {!selected || (!draft && tab !== "json") ? (
          <p className="text-sm text-fg-muted">{json && !draft ? t("twin:models.badJson") : t("twin:models.pickOne")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-all text-sm font-semibold">{selected.id}</h2>
              <span className="flex gap-1">
                {(["visual", "tsx", "json"] as const).map((k) => (
                  <button key={k} type="button" className={tab === k ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"} onClick={() => setTab(k)}>
                    {k === "tsx" ? "R3F (.tsx)" : t(`twin:models.tab.${k}`)}
                  </button>
                ))}
              </span>
              <span className="flex-1" />
              {tab === "tsx" && components.some((c) => c.target === selected.id && !c.builtIn) && (
                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={resetComponent} disabled={busy}>
                  Obnovit výchozí
                </button>
              )}
              <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={preview} disabled={busy}>
                {t("twin:models.preview")}
              </button>
              <button type="button" className="btn-secondary px-2 py-1 text-xs text-error" onClick={remove} disabled={busy}>
                {t("twin:models.delete")}
              </button>
              <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={save} disabled={busy || (!draft && tab !== "tsx")}>
                {t("twin:models.save")}
              </button>
            </div>

            {tab === "tsx" ? (
              <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <Suspense fallback={<p className="text-sm text-fg-muted">{t("common:loading")}</p>}>
                    <CodeEditor language="typescript" path="component.tsx" value={tsxCode} onChange={setTsxCode} height="calc(100vh - var(--app-bar) - 12rem)" />
                  </Suspense>
                </div>
                <div className="flex flex-col gap-2">
                  <p className="section-header">3D Náhled (@react-three/fiber)</p>
                  <div className="h-72 overflow-hidden rounded-md border border-line bg-bg-sidebar">
                    <Suspense fallback={<p className="p-3 text-xs text-fg-muted">{t("common:loading")}</p>}>
                      {draft && <VisualPreview model={draft} visual={draft.presentation?.visual} size={[2.2, 1.6, 2.2]} componentSha256={previewSha256} />}
                    </Suspense>
                  </div>
                  <p className="text-xs text-fg-muted">
                    Komponenta dostává v <code className="font-mono">props</code> rozměry (<code className="font-mono">width, height, depth</code>), stav (<code className="font-mono">status, color</code>), DTDL vlastnosti (<code className="font-mono">twin</code>) a živé hodnoty ze zdrojů dat v Redis (<code className="font-mono">values</code>).
                  </p>
                </div>
              </div>
            ) : tab === "json" ? (
              <div className="mt-3">
                <Suspense fallback={<p className="text-sm text-fg-muted">{t("common:loading")}</p>}>
                  <CodeEditor value={json || JSON.stringify(selected.model, null, 2)} onChange={setJson} height="calc(100vh - var(--app-bar) - 12rem)" />
                </Suspense>
                {!draft && <p className="mt-1 text-xs text-error">{t("twin:models.badJson")}</p>}
              </div>
            ) : !draft ? null : (
              <div className="mt-3 max-w-3xl space-y-4">
                <section>
                  <p className="section-header">{t("twin:models.identity")}</p>
                  <label className="mt-1 flex items-center gap-2 text-xs text-fg-secondary">
                    {t("twin:models.nameEn")}
                    <input className="field flex-1 px-2 py-1 text-sm" value={localizedOf(draft.displayName, "en")} onChange={(e) => setLocalized("displayName", "en", e.target.value)} />
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-xs text-fg-secondary">
                    {t("twin:models.nameCs")}
                    <input className="field flex-1 px-2 py-1 text-sm" value={localizedOf(draft.displayName, "cs")} onChange={(e) => setLocalized("displayName", "cs", e.target.value)} />
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-xs text-fg-secondary">
                    {t("twin:models.extends")}
                    <input
                      className="field flex-1 px-2 py-1 font-mono text-sm"
                      value={Array.isArray(draft.extends) ? draft.extends.join(", ") : (draft.extends ?? "")}
                      onChange={(e) => update((d) => ({ ...d, extends: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))}
                    />
                  </label>
                </section>

                <section>
                  <p className="section-header">{t("twin:models.contents")}</p>
                  <ul className="mt-1 space-y-1">
                    {(draft.contents ?? []).map((c, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-1 rounded border border-line px-2 py-1 text-xs">
                        <select className="field py-0.5" value={c["@type"]} onChange={(e) => {
                            const t2 = e.target.value as DtdlContent["@type"];
                            contentChange(i, (c) => {
                              const base = { name: c.name, displayName: c.displayName, description: c.description };
                              return (t2 === "Property" || t2 === "Telemetry" ? { "@type": t2, ...base, schema: "schema" in c ? c.schema : "string" } : t2 === "Relationship" ? { "@type": t2, ...base, ...("target" in c ? { target: c.target } : {}) } : { "@type": t2, ...base }) as DtdlContent;
                            });
                          }}>
                          {["Property", "Telemetry", "Relationship", "Command"].map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                        <input className="field w-32 px-1 py-0.5 font-mono" value={c.name} onChange={(e) => contentChange(i, (c) => ({ ...c, name: e.target.value }))} aria-label="name" />
                        {(c["@type"] === "Property" || c["@type"] === "Telemetry") && (
                          <select className="field py-0.5" value={schemaName(c.schema)} onChange={(e) => contentChange(i, (c) => ({ ...c, schema: e.target.value === "Enum" ? enumSchema() : e.target.value === "Map" ? mapSchema() : e.target.value === "Object" ? objectSchema() : e.target.value === "Array" ? arraySchema() : (e.target.value as DtdlSchema) }))}>
                            {SCHEMAS.map((x) => (
                              <option key={x}>{x}</option>
                            ))}
                          </select>
                        )}
                        {c["@type"] === "Relationship" && (
                          <input
                            className="field w-56 px-1 py-0.5 font-mono"
                            placeholder="target DTMI"
                            value={("target" in c && typeof c.target === "string" ? c.target : "") ?? ""}
                            onChange={(e) => contentChange(i, (c) => ({ ...c, target: e.target.value || undefined }))}
                          />
                        )}
                        <span className="text-fg-muted">{localizedOf(c.displayName, currentLocale())}</span>
                        <button type="button" className="btn-link ms-auto px-1" onClick={() => update((d) => ({ ...d, contents: (d.contents ?? []).filter((_, j) => j !== i) }))}>
                          {t("twin:models.remove")}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 flex gap-1">
                    {(["Property", "Telemetry", "Relationship"] as const).map((x) => (
                      <button key={x} type="button" className="btn-secondary px-2 py-0.5 text-xs" onClick={() => addContent(x)}>
                        + {x}
                      </button>
                    ))}
                  </div>
                </section>

                <section>
                  <p className="section-header">{t("twin:models.presentation")}</p>
                  <div className="mt-1 grid max-w-xl grid-cols-2 gap-2 text-xs">
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.look")}
                      <select className="field flex-1 py-1" value={draft.presentation?.look ?? ""} onChange={(e) => setPresentation((p) => ({ ...p, look: (e.target.value || undefined) as DtdlPresentation["look"] }))}>
                        <option value="">—</option>
                        {LOOKS.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.color")}
                      <input type="color" className="h-7 w-10" value={draft.presentation?.color ?? "#00c8ff"} onChange={(e) => setPresentation((p) => ({ ...p, color: e.target.value }))} />
                      <input className="field flex-1 px-1 py-0.5 font-mono" value={draft.presentation?.color ?? ""} placeholder="#rrggbb" onChange={(e) => setPresentation((p) => ({ ...p, color: e.target.value || undefined }))} />
                    </label>
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.label")}
                      <select className="field flex-1 py-1" value={draft.presentation?.label ?? ""} onChange={(e) => setPresentation((p) => ({ ...p, label: e.target.value || undefined }))}>
                        <option value="">name</option>
                        {(draft.contents ?? []).filter((c) => c["@type"] === "Property").map((c) => (
                          <option key={c.name}>{c.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.layer")}
                      <select className="field flex-1 py-1" value={draft.presentation?.layer ?? ""} onChange={(e) => setPresentation((p) => ({ ...p, layer: (e.target.value || undefined) as DtdlPresentation["layer"] }))}>
                        <option value="">—</option>
                        {PRESENTATION_LAYERS.filter((l) => l !== "logical" || draft.presentation?.layer === "logical").map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.icon")}
                      <input className="field flex-1 px-1 py-0.5 font-mono" value={draft.presentation?.icon ?? ""} placeholder="pod, svc…" onChange={(e) => setPresentation((p) => ({ ...p, icon: e.target.value || undefined }))} />
                    </label>
                    <label className="flex items-center gap-2 text-fg-secondary">
                      {t("twin:models.visible")}
                      <input type="checkbox" checked={draft.presentation?.visible ?? true} onChange={(e) => setPresentation((p) => ({ ...p, visible: e.target.checked }))} />
                    </label>
                  </div>
                </section>

                <VisualEditor model={draft} visual={draft.presentation?.visual} onChange={(visual) => setPresentation((p) => ({ ...p, visual }))} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const localizedOf = (v: Localized | undefined, locale: string) => (v === undefined ? "" : typeof v === "string" ? v : (v[locale] ?? v.en ?? ""));
const schemaName = (s: DtdlSchema) => (typeof s === "string" ? s : s["@type"]);
const enumSchema = (): DtdlSchema => ({ "@type": "Enum", valueSchema: "string", enumValues: [{ name: "a", enumValue: "a" }] });
const mapSchema = (): DtdlSchema => ({ "@type": "Map", mapKey: { name: "key", schema: "string" }, mapValue: { name: "value", schema: "string" } });
const objectSchema = (): DtdlSchema => ({ "@type": "Object", fields: [{ name: "field", schema: "string" }] });
const arraySchema = (): DtdlSchema => ({ "@type": "Array", elementSchema: "string" });
