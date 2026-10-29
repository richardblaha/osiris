import type { TwinNode } from "@osiris/shared";
import { t } from "i18next";
import { formatNumber } from "./i18n.ts";

/** The selected node's own panel: what it is, its properties, and the telemetry pages it opens. */
export function TwinDetail({ node, onOpen }: { node: TwinNode; onOpen: (page: "logs" | "metrics" | "traces") => void }) {
  const entries = Object.entries(node.properties);
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
