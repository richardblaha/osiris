import type { TwinChange, TwinNode } from "@osiris/shared";
import { t } from "i18next";
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { formatDateTime, formatNumber } from "./i18n.ts";

const WEEK = 7 * 24 * 3_600_000;
const statusClass = (s: TwinNode["status"]) => (s === "error" ? "text-error" : s === "warn" ? "text-warning" : "text-fg-secondary");

/** The selected node's own panel: what it is, its properties, and the telemetry pages it opens. */
export function TwinDetail({ node, at, onOpen }: { node: TwinNode; at: number | null; onOpen: (page: "logs" | "metrics" | "traces") => void }) {
  const entries = Object.entries(node.properties);
  // The week of changes up to the time shown, the node's and its descendants'; nothing when the history is off.
  const [changes, setChanges] = useState<TwinChange[]>();
  useEffect(() => {
    const to = at ?? Date.now();
    let current = true;
    void api.history({ entity: node.id, from: to - WEEK, to, limit: 30 }).then(
      (list) => current && setChanges(list),
      () => current && setChanges(undefined),
    );
    return () => {
      current = false;
    };
  }, [node.id, at]);
  return (
    <aside className="flex w-96 shrink-0 flex-col border-s border-line" aria-label={t("twin:properties")}>
      <div className="border-b border-line px-4 py-3">
        <span className="section-header block">{t(`twin:kinds.${node.kind}` as "twin:kinds.pod", { defaultValue: node.kind })}</span>
        <h2 className="mt-0.5 truncate font-semibold" title={node.name}>
          {node.name}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center gap-1 ${node.status === "error" ? "text-error" : node.status === "warn" ? "text-warning" : "text-fg-secondary"}`}>
            <span aria-hidden="true">●</span> {t(`twin:status.${node.status}`)}
          </span>
          {node.errors > 0 && (
            <span className="badge badge-accent" title={t("twin:errors15m")}>
              {formatNumber(node.errors)}×
            </span>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {entries.length > 0 && (
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
            {entries.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-fg-muted">{key}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {changes && (
          <section className="mt-4">
            <h3 className="section-header mb-1">{t("twin:history.title")}</h3>
            {changes.length === 0 ? (
              <p className="text-xs text-fg-muted">{t("twin:history.empty")}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {changes.map((c) => (
                  <li key={`${c.ts}:${c.entityId}:${c.change}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-fg-muted">{formatDateTime(c.ts)}</span>
                    <span className="truncate" title={c.entityId}>
                      {c.entityId === node.id ? "" : `${c.name} · `}
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
      <div className="flex gap-2 border-t border-line px-4 py-3">
        {(["logs", "metrics", "traces"] as const).map((page) => (
          <button key={page} type="button" className="btn-secondary flex-1 py-1 text-sm" onClick={() => onOpen(page)}>
            {t(`twin:open.${page}`)}
          </button>
        ))}
      </div>
    </aside>
  );
}
