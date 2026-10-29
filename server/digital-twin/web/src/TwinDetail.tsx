import type { TwinChange } from "@osiris/shared";
import { localized, resolveContents, type DtdlProperty, type DtdlRelationship, type DtdlSchema } from "@osiris/shared/dtdl.ts";
import { t } from "i18next";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { currentLocale, formatBytesRate, formatDateTime, formatNumber } from "./i18n.ts";
import type { TwinScene, TwinView } from "./scene.ts";

const WEEK = 7 * 24 * 3_600_000;
const statusClass = (s: TwinView["status"]) => (s === "error" ? "text-error" : s === "warn" ? "text-warning" : "text-fg-secondary");
/** The properties every twin has (the base Entity's), shown in the header rather than the list. */
const HEADER = new Set(["name", "status", "otelResource"]);

/** A property's value as its DTDL schema says: numbers, yes/no, an enum's display name, maps as key = value. */
function formatValue(value: unknown, schema: DtdlSchema): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof schema === "string") {
    if (schema === "boolean") return value ? t("twin:yes") : t("twin:no");
    if (typeof value === "number") return formatNumber(value);
    if (schema === "dateTime" && typeof value === "string") return formatDateTime(value);
    return String(value);
  }
  if (schema["@type"] === "Enum") return localized(schema.enumValues.find((v) => v.enumValue === value)?.displayName, currentLocale()) ?? String(value);
  if (schema["@type"] === "Map" && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k} = ${String(v)}`).join("\n");
  return JSON.stringify(value);
}

/**
 * The selected twin's properties panel, purely from its DTDL model: its status, the properties the model declares
 * (their display names and schemas), the relationships it declares (to other twins, which can be selected) and the
 * twin's history.
 */
export function TwinDetail({ node, scene, onSelect }: { node: TwinView; scene: TwinScene; onSelect: (id: string) => void }) {
  const locale = currentLocale();
  const contents = resolveContents(node.model, scene.models);
  const properties = contents.filter((c): c is DtdlProperty => c["@type"] === "Property" && !HEADER.has(c.name));
  const declared = new Map(contents.filter((c): c is DtdlRelationship => c["@type"] === "Relationship").map((r) => [r.name, r]));
  const name = (id: string) => scene.byId.get(id)?.name ?? id;
  // Relationships other than containment (the 3D view shows that), both ways; and what contains the twin.
  const outgoing = scene.relationships.filter((r) => r.$sourceId === node.id && r.$relationshipName !== "contains");
  const incoming = scene.relationships.filter((r) => r.$targetId === node.id && r.$relationshipName !== "contains");
  const relName = (rel: string, model?: string) => {
    const d = model ? resolveContents(model, scene.models).find((c) => c["@type"] === "Relationship" && c.name === rel) : declared.get(rel);
    return localized(d?.displayName, locale) ?? rel;
  };

  // The week of changes up to the time shown, the twin's and its descendants'; nothing when the history is off.
  const [changes, setChanges] = useState<TwinChange[]>();
  useEffect(() => {
    const to = scene.at ?? Date.now();
    let current = true;
    void api.history(node.id, { from: to - WEEK, to, limit: 30 }).then(
      (list) => current && setChanges(list),
      () => current && setChanges(undefined),
    );
    return () => {
      current = false;
    };
  }, [node.id, scene.at]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1 ${statusClass(node.status)}`}>
            <span aria-hidden="true">●</span> {t(`twin:status.${node.status}`)}
          </span>
          {node.errors > 0 && (
            <span className="badge badge-accent" title={t("twin:errors15m")}>
              {formatNumber(node.errors)}×
            </span>
          )}
          {node.network !== undefined && <span className="text-fg-secondary">{formatBytesRate(node.network)}</span>}
          {node.parent && (
            <span className="text-fg-muted">
              {t("twin:inside")}{" "}
              <button type="button" className="link" onClick={() => onSelect(node.parent!.id)}>
                {node.parent.name}
              </button>
            </span>
          )}
      </div>
      <div>
        {properties.length > 0 && (
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
            {properties.map((p) => (
              <div key={p.name} className="contents">
                <dt className="text-fg-muted" title={localized(p.description, locale) ?? p.name}>
                  {localized(p.displayName, locale) ?? p.name}
                </dt>
                <dd className="whitespace-pre-line break-all">{formatValue(node.twin[p.name], p.schema)}</dd>
              </div>
            ))}
          </dl>
        )}
        {(outgoing.length > 0 || incoming.length > 0) && (
          <section className="mt-4">
            <h3 className="section-header mb-1">{t("twin:relationships")}</h3>
            <ul className="space-y-0.5 text-xs">
              {outgoing.map((r) => (
                <li key={`o:${r.$relationshipId}`}>
                  <span className="text-fg-muted">{relName(r.$relationshipName)} → </span>
                  <button type="button" className="link" onClick={() => onSelect(r.$targetId)}>
                    {name(r.$targetId)}
                  </button>
                </li>
              ))}
              {incoming.slice(0, 50).map((r) => (
                <li key={`i:${r.$sourceId}:${r.$relationshipId}`}>
                  <button type="button" className="link" onClick={() => onSelect(r.$sourceId)}>
                    {name(r.$sourceId)}
                  </button>
                  <span className="text-fg-muted"> → {relName(r.$relationshipName, scene.byId.get(r.$sourceId)?.model)}</span>
                </li>
              ))}
              {incoming.length > 50 && <li className="text-fg-muted">{t("twin:more", { count: incoming.length - 50 })}</li>}
            </ul>
          </section>
        )}
        {changes && (
          <section className="mt-4">
            <h3 className="section-header mb-1">{t("twin:history.title")}</h3>
            {changes.length === 0 ? (
              <p className="text-xs text-fg-muted">{t("twin:history.empty")}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {changes.map((c) => (
                  <li key={`${c.ts}:${c.dtId}:${c.change}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-fg-muted">{formatDateTime(c.ts)}</span>
                    <span className="truncate" title={c.dtId}>
                      {c.dtId === node.id ? "" : `${c.name} · `}
                      {t(`twin:history.change.${c.change}`)}
                    </span>
                    {c.previousStatus && c.previousStatus !== c.status ? (
                      <span>
                        <span className={statusClass(c.previousStatus)}>{t(`twin:status.${c.previousStatus}`)}</span> → <span className={statusClass(c.status)}>{t(`twin:status.${c.status}`)}</span>
                      </span>
                    ) : null}
                    {c.changed.filter((k) => k !== "status").length > 0 && <span className="text-fg-muted">{c.changed.filter((k) => k !== "status").join(", ")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <p className="mt-4 break-all font-mono text-[10px] text-fg-muted" title={t("twin:model")}>
          {node.model}
          <br />
          {node.id}
        </p>
      </div>
    </>
  );
}
