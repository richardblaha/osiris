import type { Twin, TwinEntity, TwinGraph, TwinNode, TwinRelationship, TwinStatus } from "@osiris/shared";

/** The relationship whose instances make the tree the 3D view shows. */
export const CONTAINS = "contains";

/** What an adapter reads from its system: entities with their own status, and the relationships between them. */
export interface SourceSnapshot {
  root: string;
  entities: TwinEntity[];
  relationships: TwinRelationship[];
}

/**
 * An adapter: one kind of system the twin can mirror (Kubernetes, and later Docker, MQTT devices, a CMDB…). It
 * defines its entities' interfaces in DTDL and reads a snapshot of the system; everything else (error counts from
 * the telemetry, the tree, caching, the API, the views) is the same for every source.
 */
export interface TwinSource {
  /** The adapter's name ("kubernetes"), in the graph and the cache keys. */
  name: string;
  /** The DTDL interfaces its entities instantiate. */
  models(): unknown[];
  snapshot(): Promise<SourceSnapshot>;
  /**
   * The OpenTelemetry resource attributes that name an entity's own logs (`k8s.namespace.name`, `k8s.pod.name`):
   * entities whose `telemetry` holds exactly these get their error count (a pod, not its containers or namespace,
   * which roll their children's up instead). None: the twin has no error counts.
   */
  errorAttributes?: string[];
}

/** Error log counts by the values of the source's error attributes, joined with {@link errorKey}. */
export type ErrorCounts = Map<string, number>;
export const errorKey = (values: string[]) => values.join("\u0000");

const worse = (a: TwinStatus, b: TwinStatus): TwinStatus => (a === "error" || b === "error" ? "error" : a === "warn" || b === "warn" ? "warn" : "ok");

/** The snapshot as a graph, with each entity's own error count from the telemetry. */
export function graphOf(source: TwinSource, snapshot: SourceSnapshot, counts: ErrorCounts = new Map(), ts = Date.now()): TwinGraph {
  const attributes = source.errorAttributes ?? [];
  const entities = snapshot.entities.map((e) => {
    const keys = Object.keys(e.telemetry ?? {});
    const exact = attributes.length > 0 && keys.length === attributes.length && attributes.every((a) => e.telemetry?.[a]);
    const own = exact ? (counts.get(errorKey(attributes.map((a) => e.telemetry![a]!))) ?? 0) : 0;
    return { ...e, errors: e.errors + own };
  });
  return { source: source.name, root: snapshot.root, entities, relationships: snapshot.relationships, ts };
}

/**
 * The graph's containment tree from its root, statuses and error counts rolled up: a node is as bad as its worst
 * child. Entities outside the tree (a Kubernetes node: pods run on it, nothing contains it) stay in the graph only;
 * a cycle or a second parent never repeats a node.
 */
export function treeOf(graph: TwinGraph): Twin {
  const byId = new Map(graph.entities.map((e) => [e.id, e]));
  const children = new Map<string, string[]>();
  for (const r of graph.relationships) {
    if (r.name !== CONTAINS || !byId.has(r.source) || !byId.has(r.target)) continue;
    children.set(r.source, [...(children.get(r.source) ?? []), r.target]);
  }
  const seen = new Set<string>();
  const build = (id: string): TwinNode => {
    seen.add(id);
    const kids = (children.get(id) ?? []).filter((c) => !seen.has(c)).map(build);
    const node: TwinNode = { ...byId.get(id)!, children: kids };
    node.errors += kids.reduce((n, c) => n + c.errors, 0);
    node.status = kids.reduce((s, c) => worse(s, c.status), node.status);
    return node;
  };
  if (!byId.has(graph.root)) throw new Error(`The twin's root ${graph.root} is not one of its entities`);
  return { cluster: build(graph.root), ts: graph.ts };
}
