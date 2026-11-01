import { dataProfilesOf, localized, resolveContents, SOURCE_CONNECTION, type DataBinding, type DtdlInterface } from "@osiris/shared/dtdl.ts";
import { t } from "i18next";
import { currentLocale } from "./i18n.ts";

/** A binding's own parameters, beside what every binding has (a query, a topic, a JSON path, a formula). */
const OWN = new Set(["telemetry", "connection", "every", "reads", "metric", "by", "formula", "query", "path", "from"]);

/**
 * Where a twin's values come from, by its model's data profiles: each telemetry or property with its origin — the
 * twin's own source (the Kubernetes adapter: the cluster's API, a reading of its telemetry in ClickHouse with the very
 * query it runs, the Ceph manager's metrics) or a connection of the instance (its connector's parameters and how
 * often it asks). Nothing when the model says nothing.
 */
export function DataOrigins({ model, models, active }: { model: string; models: Map<string, DtdlInterface>; active?: string }) {
  const locale = currentLocale();
  const contents = resolveContents(model, models);
  const label = (name: string) => localized(contents.find((c) => c.name === name)?.displayName, locale) ?? name;
  // The source's own readings, then the active profile's (a simulation, a replay, live data of a connection).
  const profiles = dataProfilesOf(model, models).filter((p) => p.bindings.every((b) => b.connection === SOURCE_CONNECTION) || !active || p.name === active);
  const rows = profiles.flatMap((p) => p.bindings.map((b) => ({ profile: p.name, b })));
  if (!rows.length) return null;
  return (
    <section className="mt-4">
      <h3 className="section-header mb-1">{t("twin:origin.title")}</h3>
      <ul className="space-y-1.5 text-xs">
        {rows.map(({ profile, b }) => (
          <li key={`${profile}:${b.telemetry}`}>
            <details>
              <summary className="cursor-pointer">
                <span>{label(b.telemetry)}</span>
                <span className="text-fg-muted"> ← {originOf(b)}</span>
              </summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 ps-3">
                {typeof b.metric === "string" && <Row name={t("twin:origin.metric")} value={b.metric} />}
                {typeof b.by === "string" && <Row name={t("twin:origin.by")} value={b.by} />}
                {typeof b.formula === "string" && <Row name={t("twin:origin.formula")} value={b.formula} />}
                {typeof b.path === "string" && <Row name={t("twin:origin.path")} value={b.path} />}
                {typeof b.from === "string" && <Row name={t("twin:origin.from")} value={b.from} />}
                {b.connection !== SOURCE_CONNECTION && <Row name={t("twin:origin.every")} value={t("twin:origin.seconds", { count: b.every ?? 30 })} />}
                {Object.entries(b)
                  .filter(([k]) => !OWN.has(k))
                  .map(([k, v]) => (
                    <Row key={k} name={k} value={typeof v === "string" ? v : JSON.stringify(v)} code={k === "sql" || k === "query"} />
                  ))}
              </dl>
              {typeof b.query === "string" && <pre className="mt-1 max-h-56 overflow-auto whitespace-pre rounded bg-bg-panel p-2 font-mono text-[10px] leading-snug">{b.query}</pre>}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where one value comes from, in a few words: the source and what of it, or the connection. */
function originOf(b: DataBinding): string {
  if (b.connection !== SOURCE_CONNECTION) return t("twin:origin.connection", { name: b.connection });
  const reads = typeof b.reads === "string" ? b.reads : "";
  return t(`twin:origin.reads.${reads}`, { defaultValue: t("twin:origin.source") });
}

function Row({ name, value, code }: { name: string; value: string; code?: boolean }) {
  return (
    <>
      <dt className="text-fg-muted">{name}</dt>
      <dd className={`break-all ${code ? "whitespace-pre-wrap font-mono text-[10px]" : ""}`}>{value}</dd>
    </>
  );
}
