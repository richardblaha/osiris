import { TWIN_CONTAINS, type TwinStatus } from "@osiris/shared";
import { localized, resolveContents, type DigitalTwin, type DigitalTwinRelationship, type DtdlInterface, type DtdlModelData } from "@osiris/shared/dtdl.ts";
import { currentLocale } from "./i18n.ts";

/** A twin in the view: the twin itself, its model, and its place in the containment tree with rolled-up status. */
export interface TwinView {
  id: string;
  twin: DigitalTwin;
  model: string;
  /** The model's displayName, else the last part of its DTMI. */
  modelName: string;
  name: string;
  /** The twin's own status (its `status` property), and the worst of it and its descendants'. */
  ownStatus: TwinStatus;
  status: TwinStatus;
  /** The twin's own `errorLogs`, and with its descendants'. */
  ownErrors: number;
  errors: number;
  /** Bytes per second through the twin's network (its `network` telemetry); undefined without it. */
  network?: number;
  /** The storage's filesystem (its `used` and `fsCapacity` telemetry); undefined without it. */
  storage?: { used: number; fsCapacity: number };
  depth: number;
  parent?: TwinView;
  children: TwinView[];
}

/** Everything the views draw: the models, every twin by id, the tree's top and every relationship. */
export interface TwinScene {
  models: Map<string, DtdlInterface>;
  byId: Map<string, TwinView>;
  /** The outermost boxes of the 3D view: the twins nothing contains but which contain others (a cluster). */
  top: TwinView[];
  relationships: DigitalTwinRelationship[];
  /** The past time the scene shows; null when live. */
  at: number | null;
}

const STATUSES: TwinStatus[] = ["ok", "warn", "error"];
const worse = (a: TwinStatus, b: TwinStatus) => (STATUSES.indexOf(a) >= STATUSES.indexOf(b) ? a : b);
const statusOf = (t: DigitalTwin): TwinStatus => (STATUSES.includes(t.status as TwinStatus) ? (t.status as TwinStatus) : "ok");

/** A model's name for people: its displayName in the UI's language, else the DTMI's last segment. */
export const modelName = (id: string, models: Map<string, DtdlInterface>) =>
  localized(models.get(id)?.displayName, currentLocale()) ?? id.replace(/;.*$/, "").split(":").pop() ?? id;

/**
 * The scene of a set of twins, purely from DTDL: `contains` relationships nest twins (the first parent wins, a cycle
 * never repeats one), statuses and error counts roll up, and the roots are the twins nothing contains but which
 * contain others. Twins outside the tree (a Kubernetes namespace: it's related to its pods) are in `byId` for the
 * detail.
 */
export function buildScene(
  models: DtdlModelData[],
  twins: DigitalTwin[],
  relationships: DigitalTwinRelationship[],
  errors: Record<string, number>,
  network: Record<string, number>,
  storage: Record<string, { used: number; fsCapacity: number }>,
  at: number | null,
): TwinScene {
  const modelMap = new Map(models.map((m) => [m.id, m.model]));
  const byId = new Map<string, TwinView>(
    twins.map((t) => {
      const own = statusOf(t);
      const ownErrors = errors[t.$dtId] ?? 0;
      return [t.$dtId, { id: t.$dtId, twin: t, model: t.$metadata.$model, modelName: modelName(t.$metadata.$model, modelMap), name: String(t.name ?? t.$dtId), ownStatus: own, status: own, ownErrors, errors: ownErrors, network: network[t.$dtId], storage: storage[t.$dtId], depth: 0, children: [] }];
    }),
  );
  for (const r of relationships) {
    if (r.$relationshipName !== TWIN_CONTAINS) continue;
    const parent = byId.get(r.$sourceId);
    const child = byId.get(r.$targetId);
    if (!parent || !child || child.parent || child === parent) continue;
    // A cycle: the child is already above the parent.
    let up: TwinView | undefined = parent;
    while (up && up !== child) up = up.parent;
    if (up) continue;
    child.parent = parent;
    parent.children.push(child);
  }
  const roll = (v: TwinView, depth: number) => {
    v.depth = depth;
    for (const c of v.children) {
      roll(c, depth + 1);
      v.status = worse(v.status, c.status);
      v.errors += c.errors;
    }
    v.children.sort((a, b) => a.name.localeCompare(b.name));
  };
  const roots = [...byId.values()].filter((v) => !v.parent && v.children.length).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of roots) {
    roll(r, 0);
    // An outermost twin without its own network (a cluster) carries its children's: its traffic to the internet,
    // as near as the nodes' counters tell (they count traffic between nodes too).
    const known = r.children.filter((c) => c.network !== undefined);
    if (r.network === undefined && known.length) r.network = known.reduce((n, c) => n + c.network!, 0);
  }
  return { models: modelMap, byId, top: roots, relationships, at };
}

/** Whether a twin's model declares the `network` telemetry: its box gets a link to its container's network. */
export const hasNetwork = (node: TwinView, models: Map<string, DtdlInterface>) =>
  resolveContents(node.model, models).some((c) => c["@type"] === "Telemetry" && c.name === "network");

/** Whose telemetry a twin's `otelResource` names, as the telemetry API filters it. */
export function scopeOf(node: TwinView): { namespace?: string; pod?: string; node?: string; container?: string; claim?: string } {
  const r = (node.twin.otelResource ?? {}) as Record<string, string>;
  return { namespace: r["k8s.namespace.name"], pod: r["k8s.pod.name"], node: r["k8s.node.name"], container: r["k8s.container.name"], claim: r["k8s.persistentvolumeclaim.name"] };
}

/** Whether a twin is storage (its model declares the `used` telemetry): the view draws it as a cylinder filled so far. */
export const isStorage = (node: TwinView, models: Map<string, DtdlInterface>) =>
  resolveContents(node.model, models).some((c) => c["@type"] === "Telemetry" && c.name === "used");

/** How full a storage twin is, 0 to 1; undefined without its telemetry. */
export const fillOf = (node: TwinView) => (node.storage && node.storage.fsCapacity > 0 ? Math.min(1, node.storage.used / node.storage.fsCapacity) : undefined);

/**
 * The interfaces between twins in one container: every relationship but containment whose two ends sit side by side
 * (a container mounting its pod's volume claim), as pairs of ids.
 */
export function interfacesOf(scene: Pick<TwinScene, "byId" | "relationships">): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const r of scene.relationships) {
    if (r.$relationshipName === TWIN_CONTAINS) continue;
    const a = scene.byId.get(r.$sourceId);
    const b = scene.byId.get(r.$targetId);
    if (!a?.parent || a.parent !== b?.parent) continue;
    const key = [a.id, b.id].sort().join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a.id, b.id]);
  }
  return out;
}
