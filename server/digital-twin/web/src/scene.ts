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
  /**
   * A projection: the part of a grouping twin (a namespace, a workload) that lies inside this container — its id is
   * `of`, the twin it projects. Projections roll up only what they hold here.
   */
  of?: string;
  /** Drawn with dashed edges: a band (a namespace), a grouping rather than a thing. */
  dashed?: boolean;
  /** The outermost group this twin belongs to (a namespace's id): its band across the containers. */
  band?: string;
  /** A band itself: one solid across the containers around what belongs to the group (`of`). */
  isBand?: boolean;
}

/** Everything the views draw: the models, every twin by id, the tree's top and every relationship. */
export interface TwinScene {
  models: Map<string, DtdlInterface>;
  byId: Map<string, TwinView>;
  /** The outermost boxes of the 3D view: the twins nothing contains but which contain others (a cluster). */
  top: TwinView[];
  /** The bands: one per outermost group (a namespace) and outermost twin, across the containers in it. */
  bands: TwinView[];
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
  const roots = [...byId.values()].filter((v) => !v.parent && v.children.length).sort((a, b) => a.name.localeCompare(b.name));
  const bands = project(roots, byId, relationships);
  const roll = (v: TwinView, depth: number) => {
    v.depth = depth;
    for (const c of v.children) {
      roll(c, depth + 1);
      v.status = worse(v.status, c.status);
      v.errors += c.errors;
    }
    // A projection's traffic is what goes to what it holds here; a twin without its own counter (a node whose kubelet
    // reports no node network) carries its children's.
    const known = v.children.filter((c) => c.network !== undefined);
    if ((v.of || v.network === undefined) && known.length) v.network = known.reduce((n, c) => n + c.network!, 0);
    v.children.sort((a, b) => a.name.localeCompare(b.name));
  };
  // The cluster carries its nodes' traffic too: its traffic to the internet, as near as the counters tell (they count
  // traffic between nodes as well).
  for (const r of roots) roll(r, 0);
  // A band's state is its members': the worst status, their errors and traffic.
  const members = (band: TwinView) => {
    const out: TwinView[] = [];
    const walk = (v: TwinView) => (v.band === band.of && !v.isBand ? out.push(v) : v.children.forEach(walk));
    walk(band.parent!);
    return out;
  };
  for (const b of bands) {
    const list = members(b);
    for (const m of list) (b.status = worse(b.status, m.status)), (b.errors += m.errors);
    const known = list.filter((m) => m.network !== undefined);
    if (known.length) b.network = known.reduce((n, m) => n + m.network!, 0);
    b.depth = 1;
  }
  return { models: modelMap, byId, top: roots, bands, relationships, at };
}

/**
 * The groupings inside each container: a twin outside the containment tree that relates to a twin inside it (a
 * workload `hasPod`, a namespace `hasWorkload`, `hasClaim`) groups it, and its own group groups it further. Each
 * container gets a projection of each group for the children it holds of it (a node: a namespace, in it a
 * StatefulSet, in that its pods), nested the way the groups are. A group already around the container (the pod's
 * namespace around its volume claim) isn't repeated, and a group of one child of its own name (a lone pod's
 * workload) is left out.
 */
function project(roots: TwinView[], byId: Map<string, TwinView>, relationships: DigitalTwinRelationship[]) {
  const inTree = new Set<string>();
  const mark = (v: TwinView) => (inTree.add(v.id), v.children.forEach(mark));
  roots.forEach(mark);
  const groupOf = new Map<string, string>();
  for (const r of relationships)
    if (r.$relationshipName !== TWIN_CONTAINS && !inTree.has(r.$sourceId) && byId.has(r.$sourceId) && !groupOf.has(r.$targetId)) groupOf.set(r.$targetId, r.$sourceId);
  /** A twin's groups, outermost first. */
  const chainOf = (id: string) => {
    const chain: string[] = [];
    for (let g = groupOf.get(id); g && chain.length < 6 && !chain.includes(g); g = groupOf.get(g)) chain.unshift(g);
    return chain;
  };

  const bands = new Map<string, TwinView>();
  /** The band of `group` across `root`: one per group and outermost twin. */
  const bandOf = (root: TwinView, group: string) => {
    const id = `${root.id}~${group}`;
    let band = bands.get(id);
    if (!band) {
      const g = byId.get(group)!;
      band = { id, twin: g.twin, model: g.model, modelName: g.modelName, name: g.name, ownStatus: "ok", status: "ok", ownErrors: 0, errors: 0, depth: 1, parent: root, children: [], of: group, dashed: true, isBand: true };
      bands.set(id, band);
      byId.set(id, band);
    }
    return band;
  };
  const rootOf = (v: TwinView) => {
    let r = v;
    while (r.parent) r = r.parent;
    return r;
  };

  const walk = (container: TwinView, around: Set<string>) => {
    const kids = container.children;
    container.children = [];
    const slices = new Map<string, TwinView>();
    for (const child of kids) {
      let chain = chainOf(child.id).filter((g) => !around.has(g));
      const innermost = chain.at(-1) && byId.get(chain.at(-1)!);
      if (innermost && innermost.name === child.name) chain = chain.slice(0, -1);
      // The outermost group (a namespace) is a band across the containers, not a box in each.
      let band: string | undefined;
      if (chain.length && !groupOf.has(chain[0]!)) {
        band = chain[0];
        bandOf(rootOf(container), band!);
        chain = chain.slice(1);
      }
      let parent = container;
      for (const g of chain) {
        const key = `${parent.id}>${g}`;
        let slice = slices.get(key);
        if (!slice) {
          const group = byId.get(g)!;
          slice = {
            id: key,
            twin: group.twin,
            model: group.model,
            modelName: group.modelName,
            name: group.name,
            ownStatus: "ok",
            status: "ok",
            ownErrors: 0,
            errors: 0,
            depth: 0,
            parent,
            children: [],
            of: g,
            band,
          };
          slices.set(key, slice);
          parent.children.push(slice);
        }
        parent = slice;
      }
      if (parent === container && band) child.band = band;
      child.parent = parent;
      parent.children.push(child);
      walk(child, new Set([...around, ...chainOf(child.id)]));
    }
    for (const slice of slices.values()) byId.set(slice.id, slice);
  };
  for (const r of roots) walk(r, new Set());
  return [...bands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The twin a view shows: itself, or for a projection the grouping twin it projects. */
export const twinIdOf = (node: TwinView) => node.of ?? node.id;

/**
 * Whether a twin has a network (its model declares the `network` telemetry), or a projection holds something that
 * has: its box gets a link to its container's network.
 */
export const hasNetwork = (node: TwinView, models: Map<string, DtdlInterface>): boolean =>
  node.of ? node.children.some((c) => hasNetwork(c, models)) : resolveContents(node.model, models).some((c) => c["@type"] === "Telemetry" && c.name === "network");

/**
 * Whose telemetry a twin's `otelResource` names, as the telemetry API filters it; a projection's is its group's
 * within the real twin around it (a namespace on one node).
 */
export function scopeOf(node: TwinView): { namespace?: string; pod?: string; node?: string; container?: string; claim?: string } {
  let host = node.parent;
  while (node.of && host?.of) host = host.parent;
  const r = { ...(node.of ? ((host?.twin.otelResource ?? {}) as Record<string, string>) : {}), ...((node.twin.otelResource ?? {}) as Record<string, string>) };
  return { namespace: r["k8s.namespace.name"], pod: r["k8s.pod.name"], node: r["k8s.node.name"], container: r["k8s.container.name"], claim: r["k8s.persistentvolumeclaim.name"] };
}

/**
 * Whether a twin is storage (its model declares `used`, as telemetry or a property, or a `fill`): a disk, a pool, a
 * volume claim. The view draws such a leaf as a cylinder filled as far as it is full.
 */
export const isStorage = (node: TwinView, models: Map<string, DtdlInterface>) =>
  !node.isBand && resolveContents(node.model, models).some((c) => (c["@type"] === "Telemetry" || c["@type"] === "Property") && (c.name === "used" || c.name === "fill"));

/** A storage twin's bytes: used of its size (its telemetry, else its properties); undefined when only a share is known. */
export function storageOf(node: TwinView): { used: number; size: number } | undefined {
  if (node.storage && node.storage.fsCapacity > 0) return { used: node.storage.used, size: node.storage.fsCapacity };
  const { used, size } = node.twin as { used?: unknown; size?: unknown };
  return typeof used === "number" && typeof size === "number" && size > 0 ? { used, size } : undefined;
}

/** How full a storage twin is, 0 to 1: its storage telemetry, else its `used` of its `size`, else its `fill`. */
export function fillOf(node: TwinView): number | undefined {
  if (node.storage && node.storage.fsCapacity > 0) return Math.min(1, node.storage.used / node.storage.fsCapacity);
  const { used, size, fill } = node.twin as { used?: unknown; size?: unknown; fill?: unknown };
  if (typeof used === "number" && typeof size === "number" && size > 0) return Math.min(1, used / size);
  return typeof fill === "number" ? Math.min(1, Math.max(0, fill)) : undefined;
}

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
