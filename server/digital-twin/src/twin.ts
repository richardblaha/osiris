import { createHash } from "node:crypto";
import type { DigitalTwinRelationship, DtdlInterface } from "@osiris/shared/dtdl.ts";
import { TWIN_CONTAINS } from "@osiris/shared";

export { TWIN_CONTAINS as CONTAINS };

/** A twin as an adapter reads it: an ADT twin without what the store adds (`$etag`, `$lastUpdateTime`). */
export interface SourceTwin {
  $dtId: string;
  $metadata: { $model: string };
  [property: string]: unknown;
}
/** A relationship as an adapter reads it: its id comes from the store. */
export interface SourceRelationship {
  name: string;
  source: string;
  target: string;
}

/** What an adapter reads from its system: the twins and the relationships between them. */
export interface SourceSnapshot {
  twins: SourceTwin[];
  relationships: SourceRelationship[];
}

/**
 * An adapter: one kind of system the twin mirrors (Kubernetes, and later Docker, MQTT devices, a CMDB…). It defines
 * its twins' interfaces in DTDL and reads a snapshot of the system; the store (SQLite), the history (OpenTelemetry),
 * the telemetry (ClickHouse), the API and the views are the same for every source.
 */
export interface TwinSource {
  /** The adapter's name ("kubernetes"): its twins in the store are its own. */
  name: string;
  /** The DTDL interfaces its twins instantiate. */
  models(): DtdlInterface[];
  snapshot(): Promise<SourceSnapshot>;
  /**
   * The OpenTelemetry resource attributes that name a twin's own logs (`k8s.namespace.name`, `k8s.pod.name`): twins
   * whose `otelResource` holds exactly these get their error count (a pod, not its containers or namespace, which roll
   * their children's up instead). None: no error counts.
   */
  errorAttributes?: string[];
  /**
   * The monotonic byte counters of the twins' network traffic (models' Telemetry `network`): each metric's rate goes
   * to the twins whose `otelResource` holds exactly its attributes (a node by its name, a pod by namespace and pod).
   */
  networkMetrics?: { metric: string; attributes: string[] }[];
}

/** A relationship's id (ADT's `$relationshipId`, unique per source twin): its name and its target, hashed. */
export const relationshipId = (name: string, target: string) => `${name}-${createHash("sha256").update(target).digest("hex").slice(0, 16)}`;

export const toRelationship = (r: SourceRelationship): DigitalTwinRelationship => ({
  $relationshipId: relationshipId(r.name, r.target),
  $sourceId: r.source,
  $relationshipName: r.name,
  $targetId: r.target,
});

/** The twin's own OpenTelemetry resource attributes. */
export const otelResourceOf = (t: { otelResource?: unknown }) =>
  t.otelResource && typeof t.otelResource === "object" ? (t.otelResource as Record<string, string>) : {};

/** Error log counts by the values of the source's error attributes, joined with {@link errorKey}. */
export type ErrorCounts = Map<string, number>;
export const errorKey = (values: string[]) => values.join("\u0000");

/** Each twin's own error count: the twins named by exactly the source's error attributes. */
export const errorsByTwin = (twins: { $dtId: string; otelResource?: unknown }[], attributes: string[] | undefined, counts: ErrorCounts) => valuesByTwin(twins, attributes, counts);

/** Values keyed by attribute values ({@link errorKey}) given to the twins whose `otelResource` holds exactly those attributes. */
export function valuesByTwin(twins: { $dtId: string; otelResource?: unknown }[], attributes: string[] | undefined, counts: Map<string, number>, out: Record<string, number> = {}): Record<string, number> {
  if (!attributes?.length) return out;
  for (const t of twins) {
    const r = otelResourceOf(t);
    if (Object.keys(r).length !== attributes.length || !attributes.every((a) => r[a])) continue;
    const n = counts.get(errorKey(attributes.map((a) => r[a]!)));
    if (n) out[t.$dtId] = n;
  }
  return out;
}
