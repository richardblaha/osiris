/**
 * DTDL (Digital Twins Definition Language) v3, the part the digital twin uses: interfaces with properties, telemetry,
 * relationships and commands, `extends`, and the schemas Enum, Map, Object and Array. DTDL defines models only; the
 * instances follow the shape of the Azure Digital Twins REST API, DTDL's de facto instance format: a twin is
 * `{ $dtId, $etag, $metadata: { $model }, ...properties }`, a relationship `{ $relationshipId, $sourceId,
 * $relationshipName, $targetId }`.
 */

export const DTDL_CONTEXT = "dtmi:dtdl:context;3";

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
  return errors;
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
