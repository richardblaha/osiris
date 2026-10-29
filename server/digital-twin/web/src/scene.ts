import { TWIN_CONTAINS, type TwinStatus } from "@osiris/shared";
import { localized, type DigitalTwin, type DigitalTwinRelationship, type DtdlInterface, type DtdlModelData } from "@osiris/shared/dtdl.ts";
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
  depth: number;
  parent?: TwinView;
  children: TwinView[];
}

/** Everything the views draw: the models, every twin by id, the tree's top and every relationship. */
export interface TwinScene {
  models: Map<string, DtdlInterface>;
  byId: Map<string, TwinView>;
  /** The boxes at the top of the 3D view: a single root's children, or the roots themselves. */
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
 * contain others. Twins outside the tree (a Kubernetes node: pods run on it) are in `byId` for the detail.
 */
export function buildScene(models: DtdlModelData[], twins: DigitalTwin[], relationships: DigitalTwinRelationship[], errors: Record<string, number>, at: number | null): TwinScene {
  const modelMap = new Map(models.map((m) => [m.id, m.model]));
  const byId = new Map<string, TwinView>(
    twins.map((t) => {
      const own = statusOf(t);
      const ownErrors = errors[t.$dtId] ?? 0;
      return [t.$dtId, { id: t.$dtId, twin: t, model: t.$metadata.$model, modelName: modelName(t.$metadata.$model, modelMap), name: String(t.name ?? t.$dtId), ownStatus: own, status: own, ownErrors, errors: ownErrors, depth: 0, children: [] }];
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
  for (const r of roots) roll(r, 0);
  return { models: modelMap, byId, top: roots.length === 1 ? roots[0]!.children : roots, relationships, at };
}
