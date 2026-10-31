/**
 * DTDL (Digital Twins Definition Language) v3, the part the digital twin uses: interfaces with properties, telemetry,
 * relationships and commands, `extends`, and the schemas Enum, Map, Object and Array. DTDL defines models only; the
 * instances follow the shape of the Azure Digital Twins REST API, DTDL's de facto instance format: a twin is
 * `{ $dtId, $etag, $metadata: { $model }, ...properties }`, a relationship `{ $relationshipId, $sourceId,
 * $relationshipName, $targetId }`.
 */

export const DTDL_CONTEXT = "dtmi:dtdl:context;3";
/** The context that allows a `presentation` section on an interface: how the twin's views draw its twins. */
export const PRESENTATION_CONTEXT = "dtmi:osiris:presentation;1";
/** The context of a model's data profiles: where its twins' telemetry comes from (`dataProfiles`). */
export const DATA_CONTEXT = "dtmi:osiris:data;1";

/** A DTDL string for people: one text, or a language map (`{ "en": "Pod", "cs": "Pod" }`). */
export type Localized = string | Record<string, string>;

/** The text of a localized string in `locale` (a language subtag), else English, else any. */
export const localized = (v: Localized | undefined, locale: string): string | undefined =>
  v === undefined ? undefined : typeof v === "string" ? v : (v[locale] ?? v.en ?? Object.values(v)[0]);

export const PRIMITIVE_SCHEMAS = ["boolean", "date", "dateTime", "double", "duration", "float", "integer", "long", "string", "time"] as const;
export type PrimitiveSchema = (typeof PRIMITIVE_SCHEMAS)[number];

export interface DtdlEnum {
  "@type": "Enum";
  valueSchema: "integer" | "string";
  enumValues: { name: string; enumValue: string | number; displayName?: Localized; description?: Localized }[];
}
export interface DtdlMap {
  "@type": "Map";
  mapKey: { name: string; schema: "string" };
  mapValue: { name: string; schema: DtdlSchema };
}
export interface DtdlObject {
  "@type": "Object";
  fields: { name: string; schema: DtdlSchema; displayName?: Localized; description?: Localized }[];
}
export interface DtdlArray {
  "@type": "Array";
  elementSchema: DtdlSchema;
}
export type DtdlSchema = PrimitiveSchema | DtdlEnum | DtdlMap | DtdlObject | DtdlArray;

interface Content {
  name: string;
  displayName?: Localized;
  description?: Localized;
}
export interface DtdlProperty extends Content {
  "@type": "Property";
  schema: DtdlSchema;
  writable?: boolean;
}
export interface DtdlTelemetry extends Content {
  "@type": "Telemetry";
  schema: DtdlSchema;
}
export interface DtdlRelationship extends Content {
  "@type": "Relationship";
  target?: string;
}
export interface DtdlCommand extends Content {
  "@type": "Command";
}
export type DtdlContent = DtdlProperty | DtdlTelemetry | DtdlRelationship | DtdlCommand;

export interface DtdlInterface {
  "@context": string | string[];
  "@id": string;
  "@type": "Interface";
  displayName?: Localized;
  description?: Localized;
  extends?: string | string[];
  contents?: DtdlContent[];
  /** How the views draw this model's twins; needs {@link PRESENTATION_CONTEXT} in `@context`. */
  presentation?: DtdlPresentation;
  /** Where its twins' telemetry comes from, by profile (live, simulation…); needs {@link DATA_CONTEXT}. */
  dataProfiles?: DataProfile[];
}

/**
 * A data profile of a model: one way its twins get their telemetry — the real system's (`live`), a simulation, a
 * replay of recorded data. A twin instance runs one profile at a time. Each binding fills one of the model's
 * Telemetry (or Property) contents from a connection (the instance's, by id: its address and credentials live
 * there, never in the model) with the connector's own, non-secret parameters (a query, a topic, a generator).
 * A simulation profile may also name a simulator: a connection to the simulation's own tools (a simulated
 * Kubernetes cluster…) with the scenario it runs.
 */
export interface DataProfile {
  name: string;
  kind: DataProfileKind;
  description?: string;
  bindings: DataBinding[];
  simulator?: { connection: string; scenario?: Record<string, unknown> };
}
export type DataProfileKind = "live" | "simulation" | "replay";
export const DATA_PROFILE_KINDS: readonly DataProfileKind[] = ["live", "simulation", "replay"];
export interface DataBinding {
  /** The model's Telemetry or Property it fills. */
  telemetry: string;
  /** The instance's connection it reads, by id. */
  connection: string;
  /** How often to ask, for connectors that are asked (seconds; streams push). */
  every?: number;
  /** The connector's own parameters (a query, a topic, a JSON path, a generator's pattern). */
  [parameter: string]: unknown;
}
/** An id: a profile's name or a connection's. */
export const DATA_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Placeholders a binding's parameters may use: the twin's id, its name, a property, an OpenTelemetry attribute. */
export const DATA_PLACEHOLDER = /\{(id|name|twin\.[A-Za-z][A-Za-z0-9_]{0,63}|otel\.[A-Za-z0-9_.]{1,100})\}/g;

/** How a kind of twin is drawn: a solid of its own shape, so a node, a pod, a disk and a Service are told apart
 * before any label is read. */
export type Look = "cluster" | "node" | "workload" | "pod" | "container" | "cylinder" | "disk" | "port" | "hex" | "gate" | "ceph" | "box";
export const LOOKS: readonly Look[] = ["cluster", "node", "workload", "pod", "container", "cylinder", "disk", "port", "hex", "gate", "ceph", "box"];
/** The built-in looks by model DTMI without the version, for models without a `presentation`. */
export const BUILTIN_LOOKS: Record<string, Look> = {
  "dtmi:osiris:k8s:Cluster": "cluster",
  "dtmi:osiris:k8s:Node": "node",
  "dtmi:osiris:k8s:Workload": "workload",
  "dtmi:osiris:k8s:Pod": "pod",
  "dtmi:osiris:k8s:Container": "container",
  "dtmi:osiris:k8s:PersistentVolumeClaim": "cylinder",
  "dtmi:osiris:ceph:Cluster": "ceph",
  "dtmi:osiris:ceph:Pool": "cylinder",
  "dtmi:osiris:ceph:Osd": "disk",
  "dtmi:osiris:net:Interface": "port",
  "dtmi:osiris:k8s:Service": "hex",
  "dtmi:osiris:k8s:Ingress": "gate",
};

/**
 * The view's layer a model belongs to (the display menu's switches): `base` always shows (the cluster, nodes, pods,
 * containers), `network` the low-level network (interfaces, bridges, routers, tunnels and their wiring), `services`
 * the network services (Services, Ingresses, LoadBalancer and public addresses, their routing), `storage` the
 * storage (volume claims, Ceph with its pools and disks), `logical` the groupings (namespaces, workloads).
 */
export type PresentationLayer = "base" | "network" | "services" | "storage" | "logical";
export const PRESENTATION_LAYERS: readonly PresentationLayer[] = ["base", "network", "services", "storage", "logical"];
/** The built-in layers by model DTMI without the version, for models whose presentation names none. */
export const BUILTIN_LAYERS: Record<string, PresentationLayer> = {
  "dtmi:osiris:net:Interface": "network",
  "dtmi:osiris:k8s:Service": "services",
  "dtmi:osiris:k8s:Ingress": "services",
  "dtmi:osiris:k8s:PersistentVolumeClaim": "storage",
  "dtmi:osiris:ceph:Cluster": "storage",
  "dtmi:osiris:ceph:Pool": "storage",
  "dtmi:osiris:ceph:Osd": "storage",
  "dtmi:osiris:ceph:Monitor": "storage",
  "dtmi:osiris:k8s:Namespace": "logical",
  "dtmi:osiris:k8s:Workload": "logical",
};

/**
 * A model's `presentation` section (`dtmi:osiris:presentation;1`): how the twin's views draw its twins. Everything
 * optional; what a model doesn't say, the views decide as before.
 */
export interface DtdlPresentation {
  /** The solid's shape; else the built-in look of the model's DTMI, else a box. */
  look?: Look;
  /** The solid's own color (`#rrggbb`), else the status colors. */
  color?: string;
  /** The label's icon (a Kubernetes icon id, or a custom one the views know). */
  icon?: string;
  /** The property whose value is the label; else `name`. */
  label?: string;
  /** The layer the solid is switched with (the legend); else base. */
  layer?: PresentationLayer;
  /** Whether the model's twins show at all; else yes. */
  visible?: boolean;
}

/** A model as the Azure Digital Twins API lists it (`GET /models?includeModelDefinition=true`). */
export interface DtdlModelData {
  id: string;
  displayName?: Record<string, string>;
  description?: Record<string, string>;
  uploadTime: string;
  decommissioned: boolean;
  model: DtdlInterface;
}

export interface DigitalTwin {
  $dtId: string;
  $etag?: string;
  $metadata: { $model: string; $lastUpdateTime?: string };
  [property: string]: unknown;
}

export interface DigitalTwinRelationship {
  $relationshipId: string;
  $etag?: string;
  $sourceId: string;
  $relationshipName: string;
  $targetId: string;
  [property: string]: unknown;
}

/** A DTMI: `dtmi:<segments separated by colons>;<version>`. */
export const DTMI = /^dtmi:[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?(?::[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?)*(?:;[1-9][0-9]{0,8}(?:\.[1-9][0-9]{0,5})?)?$/;
const NAME = /^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/;
const CONTENT_TYPES = ["Property", "Telemetry", "Relationship", "Command"] as const;

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function schemaErrors(schema: unknown, at: string): string[] {
  if (typeof schema === "string") return (PRIMITIVE_SCHEMAS as readonly string[]).includes(schema) ? [] : [`${at}: unknown schema ${schema}`];
  if (!schema || typeof schema !== "object") return [`${at}: missing schema`];
  const s = schema as Record<string, unknown>;
  switch (s["@type"]) {
    case "Enum": {
      const errors = s.valueSchema === "string" || s.valueSchema === "integer" ? [] : [`${at}: Enum needs valueSchema string or integer`];
      const values = Array.isArray(s.enumValues) ? (s.enumValues as Record<string, unknown>[]) : [];
      if (!values.length) errors.push(`${at}: Enum needs enumValues`);
      for (const v of values) {
        if (typeof v.name !== "string" || !NAME.test(v.name)) errors.push(`${at}: bad enum value name ${String(v.name)}`);
        if (typeof v.enumValue !== (s.valueSchema === "integer" ? "number" : "string")) errors.push(`${at}: enumValue of ${String(v.name)} must be a ${String(s.valueSchema)}`);
      }
      return errors;
    }
    case "Map": {
      const key = s.mapKey as Record<string, unknown> | undefined;
      const value = s.mapValue as Record<string, unknown> | undefined;
      const errors = key?.schema === "string" && typeof key.name === "string" && NAME.test(key.name) ? [] : [`${at}: Map needs a mapKey named, of schema string`];
      if (!value || typeof value.name !== "string" || !NAME.test(value.name)) errors.push(`${at}: Map needs a named mapValue`);
      return [...errors, ...schemaErrors(value?.schema, `${at}.mapValue`)];
    }
    case "Object": {
      const fields = Array.isArray(s.fields) ? (s.fields as Record<string, unknown>[]) : [];
      if (!fields.length) return [`${at}: Object needs fields`];
      return fields.flatMap((f) => [...(typeof f.name === "string" && NAME.test(f.name) ? [] : [`${at}: bad field name ${String(f.name)}`]), ...schemaErrors(f.schema, `${at}.${String(f.name)}`)]);
    }
    case "Array":
      return schemaErrors(s.elementSchema, `${at}[]`);
    default:
      return [`${at}: unknown complex schema ${String(s["@type"])}`];
  }
}

/** What's wrong with an interface document (empty when it is valid DTDL v3 of the supported part). */
export function interfaceErrors(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return ["not an object"];
  const d = doc as Record<string, unknown>;
  const id = typeof d["@id"] === "string" ? d["@id"] : "?";
  const errors: string[] = [];
  if (!list(d["@context"] as string | string[]).includes(DTDL_CONTEXT)) errors.push(`${id}: @context must include ${DTDL_CONTEXT}`);
  if (!DTMI.test(id)) errors.push(`${id}: @id is not a DTMI`);
  if (d["@type"] !== "Interface") errors.push(`${id}: @type must be Interface`);
  for (const e of list(d.extends as string | string[])) if (typeof e !== "string" || !DTMI.test(e)) errors.push(`${id}: extends ${String(e)} is not a DTMI`);
  const names = new Set<string>();
  for (const c of (Array.isArray(d.contents) ? d.contents : []) as Record<string, unknown>[]) {
    const name = String(c.name);
    const at = `${id}.${name}`;
    if (!NAME.test(name)) errors.push(`${at}: bad name`);
    if (names.has(name)) errors.push(`${at}: duplicate name`);
    names.add(name);
    if (!(CONTENT_TYPES as readonly unknown[]).includes(c["@type"])) errors.push(`${at}: unknown @type ${String(c["@type"])}`);
    if (c["@type"] === "Property" || c["@type"] === "Telemetry") errors.push(...schemaErrors(c.schema, at));
    if (c["@type"] === "Relationship" && c.target !== undefined && (typeof c.target !== "string" || !DTMI.test(c.target))) errors.push(`${at}: target is not a DTMI`);
  }
  if (d.dataProfiles !== undefined) {
    if (!list(d["@context"] as string | string[]).includes(DATA_CONTEXT)) errors.push(`${id}: dataProfiles needs ${DATA_CONTEXT} in @context`);
    errors.push(...dataProfileShapeErrors(id, d.dataProfiles));
  }
  if (d.presentation !== undefined) {
    if (!list(d["@context"] as string | string[]).includes(PRESENTATION_CONTEXT)) errors.push(`${id}: presentation needs ${PRESENTATION_CONTEXT} in @context`);
    errors.push(...presentationShapeErrors(id, d.presentation));
  }
  return errors;
}

/** What's wrong with a `dataProfiles` section itself (not against the model's contents or the connections). */
function dataProfileShapeErrors(id: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [`${id}: dataProfiles must be an array`];
  if (raw.length > 10) return [`${id}: at most 10 data profiles`];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [i, p] of (raw as unknown[]).entries()) {
    const at = `${id}: dataProfiles[${i}]`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const o = p as Record<string, unknown>;
    if (typeof o.name !== "string" || !DATA_ID.test(o.name)) errors.push(`${at}.name must be a short id (a-z, 0-9, -)`);
    else if (names.has(o.name)) errors.push(`${at}.name ${o.name} is there twice`);
    else names.add(o.name);
    if (!DATA_PROFILE_KINDS.includes(o.kind as DataProfileKind)) errors.push(`${at}.kind is not one of ${DATA_PROFILE_KINDS.join(", ")}`);
    if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > 500)) errors.push(`${at}.description must be a short text`);
    if (o.simulator !== undefined) {
      const sim = o.simulator as Record<string, unknown> | null;
      if (o.kind !== "simulation") errors.push(`${at}.simulator belongs to a simulation profile only`);
      if (!sim || typeof sim !== "object" || typeof sim.connection !== "string" || !DATA_ID.test(sim.connection)) errors.push(`${at}.simulator.connection must be a connection id`);
      else if (sim.scenario !== undefined && (typeof sim.scenario !== "object" || sim.scenario === null || Array.isArray(sim.scenario))) errors.push(`${at}.simulator.scenario must be an object`);
    }
    if (!Array.isArray(o.bindings)) {
      errors.push(`${at}.bindings must be an array`);
      continue;
    }
    if (o.bindings.length > 100) errors.push(`${at}: at most 100 bindings`);
    for (const [j, b] of (o.bindings as unknown[]).entries()) {
      const bt = `${at}.bindings[${j}]`;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        errors.push(`${bt} must be an object`);
        continue;
      }
      const x = b as Record<string, unknown>;
      if (typeof x.telemetry !== "string" || !NAME.test(x.telemetry)) errors.push(`${bt}.telemetry must name a content`);
      if (typeof x.connection !== "string" || !DATA_ID.test(x.connection)) errors.push(`${bt}.connection must be a connection id`);
      if (x.every !== undefined && (typeof x.every !== "number" || x.every < 5 || x.every > 86_400)) errors.push(`${bt}.every must be 5 to 86400 seconds`);
      if (JSON.stringify(x).length > 4000) errors.push(`${bt} is too large`);
    }
  }
  return errors;
}

/** A model's data profiles: its own over what it extends (a profile of the same name wins). */
export function dataProfilesOf(id: string, models: Map<string, DtdlInterface>, seen = new Set<string>()): DataProfile[] {
  const m = models.get(id);
  if (!m || seen.has(id)) return [];
  seen.add(id);
  const inherited = list(m.extends).flatMap((e) => dataProfilesOf(e, models, seen));
  const own = m.dataProfiles ?? [];
  return [...inherited.filter((p) => !own.some((o) => o.name === p.name)), ...own];
}

/** What's wrong with a model's data profiles against its contents: each binding fills a Telemetry or Property it has. */
export function dataProfileErrors(id: string, models: Map<string, DtdlInterface>): string[] {
  const profiles = models.get(id)?.dataProfiles ?? [];
  if (!profiles.length) return [];
  const fillable = new Set(resolveContents(id, models).filter((c) => c["@type"] === "Telemetry" || c["@type"] === "Property").map((c) => c.name));
  return profiles.flatMap((p) => p.bindings.filter((b) => !fillable.has(b.telemetry)).map((b) => `${id}: profile ${p.name} fills ${b.telemetry}, which is no Telemetry or Property of the model`));
}

/** What's wrong with a `presentation` section itself (not against the model's contents). */
function presentationShapeErrors(id: string, p: unknown): string[] {
  if (!p || typeof p !== "object" || Array.isArray(p)) return [`${id}: presentation must be an object`];
  const o = p as Record<string, unknown>;
  const errors: string[] = [];
  if (o.look !== undefined && !LOOKS.includes(o.look as Look)) errors.push(`${id}: presentation.look ${String(o.look)} is not one of ${LOOKS.join(", ")}`);
  if (o.color !== undefined && (typeof o.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(o.color))) errors.push(`${id}: presentation.color must be #rrggbb`);
  if (o.icon !== undefined && (typeof o.icon !== "string" || o.icon.length > 60)) errors.push(`${id}: presentation.icon must be a short string`);
  if (o.label !== undefined && (typeof o.label !== "string" || !NAME.test(o.label))) errors.push(`${id}: presentation.label must be a property name`);
  if (o.layer !== undefined && !PRESENTATION_LAYERS.includes(o.layer as PresentationLayer)) errors.push(`${id}: presentation.layer is not one of ${PRESENTATION_LAYERS.join(", ")}`);
  if (o.visible !== undefined && typeof o.visible !== "boolean") errors.push(`${id}: presentation.visible must be a boolean`);
  return errors;
}

/**
 * What's wrong with a model's presentation against its contents: `label` must name one of the model's properties
 * (its own or an inherited one).
 */
export function presentationErrors(id: string, models: Map<string, DtdlInterface>): string[] {
  const p = models.get(id)?.presentation;
  if (!p?.label) return [];
  return resolveContents(id, models).some((c) => c["@type"] === "Property" && c.name === p.label) ? [] : [`${id}: presentation.label ${p.label} is no property of the model`];
}

/** A model's presentation: its own merged over what it extends (an own key wins). */
export function presentationOf(id: string, models: Map<string, DtdlInterface>, seen = new Set<string>()): DtdlPresentation {
  const doc = models.get(id);
  if (!doc || seen.has(id)) return {};
  seen.add(id);
  const inherited: DtdlPresentation = {};
  for (const parent of list(doc.extends)) Object.assign(inherited, presentationOf(parent, models, seen));
  return { ...inherited, ...doc.presentation };
}

/** An interface with what it extends folded in: every content it has, its own last (an own one wins by name). */
export function resolveContents(id: string, models: Map<string, DtdlInterface>, seen = new Set<string>()): DtdlContent[] {
  const doc = models.get(id);
  if (!doc || seen.has(id)) return [];
  seen.add(id);
  const byName = new Map<string, DtdlContent>();
  for (const parent of list(doc.extends)) for (const c of resolveContents(parent, models, seen)) byName.set(c.name, c);
  for (const c of doc.contents ?? []) byName.set(c.name, c);
  return [...byName.values()];
}

/** Whether `id` is `base` or extends it (directly or through others). */
export function extendsModel(id: string, base: string, models: Map<string, DtdlInterface>, seen = new Set<string>()): boolean {
  if (id === base) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  return list(models.get(id)?.extends).some((p) => extendsModel(p, base, models, seen));
}

function valueErrors(value: unknown, schema: DtdlSchema, at: string): string[] {
  if (typeof schema === "string") {
    const ok =
      schema === "boolean" ? typeof value === "boolean"
      : schema === "integer" || schema === "long" ? Number.isInteger(value)
      : schema === "double" || schema === "float" ? typeof value === "number"
      : typeof value === "string";
    return ok ? [] : [`${at}: expected ${schema}, got ${JSON.stringify(value)}`];
  }
  switch (schema["@type"]) {
    case "Enum":
      return schema.enumValues.some((v) => v.enumValue === value) ? [] : [`${at}: ${JSON.stringify(value)} is not one of the enum's values`];
    case "Map":
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).flatMap(([k, v]) => valueErrors(v, schema.mapValue.schema, `${at}.${k}`))
        : [`${at}: expected a map`];
    case "Object":
      return value && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).flatMap(([k, v]) => {
            const field = schema.fields.find((f) => f.name === k);
            return field ? valueErrors(v, field.schema, `${at}.${k}`) : [`${at}: unknown field ${k}`];
          })
        : [`${at}: expected an object`];
    case "Array":
      return Array.isArray(value) ? value.flatMap((v, i) => valueErrors(v, schema.elementSchema, `${at}[${i}]`)) : [`${at}: expected an array`];
  }
}

/** What's wrong with a twin against its model: unknown model, properties the model lacks, values of the wrong type. */
export function twinErrors(twin: DigitalTwin, models: Map<string, DtdlInterface>): string[] {
  const model = twin.$metadata?.$model;
  if (!models.has(model)) return [`${twin.$dtId}: unknown model ${model}`];
  const properties = new Map(resolveContents(model, models).filter((c): c is DtdlProperty => c["@type"] === "Property").map((p) => [p.name, p]));
  return Object.entries(twin)
    .filter(([k]) => !k.startsWith("$"))
    .flatMap(([k, v]) => {
      const p = properties.get(k);
      return p ? valueErrors(v, p.schema, `${twin.$dtId}.${k}`) : [`${twin.$dtId}: ${model} has no property ${k}`];
    });
}

/** What's wrong with a relationship: its source model doesn't declare it, or its target isn't of the declared model. */
export function relationshipErrors(r: DigitalTwinRelationship, twins: Map<string, DigitalTwin>, models: Map<string, DtdlInterface>): string[] {
  const source = twins.get(r.$sourceId);
  const target = twins.get(r.$targetId);
  if (!source || !target) return [`${r.$relationshipId}: source or target twin missing`];
  const declared = resolveContents(source.$metadata.$model, models).find((c): c is DtdlRelationship => c["@type"] === "Relationship" && c.name === r.$relationshipName);
  if (!declared) return [`${r.$relationshipId}: ${source.$metadata.$model} declares no relationship ${r.$relationshipName}`];
  if (declared.target && !extendsModel(target.$metadata.$model, declared.target, models)) return [`${r.$relationshipId}: target ${target.$metadata.$model} is not a ${declared.target}`];
  return [];
}
