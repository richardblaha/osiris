/**
 * Tolerant DEXPI / Proteus XML parser.
 *
 * DEXPI files describe a P&ID as a `<PlantModel>` tree. This parser normalizes
 * the parts Osiris cares about — plant metadata, equipment + nozzles, and piping
 * network segments — into the flat {@link DexpiModel} shape from `@osiris/shared-core`.
 * It is deliberately lenient: unknown elements are ignored, missing coordinates
 * become `undefined` rather than throwing.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  err,
  ok,
  type DexpiEquipment,
  type DexpiModel,
  type DexpiNode,
  type DexpiNozzle,
  type DexpiPosition,
  type DexpiSegment,
  type Result,
} from '@osiris/shared-core';

export class DexpiParseError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = 'DexpiParseError';
  }
}

const ALWAYS_ARRAY = new Set([
  'Equipment',
  'Nozzle',
  'PipingNetworkSystem',
  'PipingNetworkSegment',
  'PipingComponent',
  'ProcessInstrument',
  'ProcessInstrumentationFunction',
  'GenericAttribute',
  'Connection',
  'Coordinate',
  'Node',
]);

interface XmlNode {
  [key: string]: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Collect every `@_`-prefixed attribute of a node into a flat string bag. */
function attributesOf(node: XmlNode): Record<string, string> {
  const bag: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) {
      bag[key.slice(2)] = String(value);
    }
  }
  // DEXPI GenericAttributes → merge as Name/Value pairs.
  const container = node.GenericAttributes as XmlNode | undefined;
  const generics = (container?.GenericAttribute ?? node.GenericAttribute) as XmlNode[] | undefined;
  if (Array.isArray(generics)) {
    for (const g of generics) {
      const name = g['@_Name'];
      const value = g['@_Value'];
      if (typeof name === 'string') {
        bag[name] = value === undefined ? '' : String(value);
      }
    }
  }
  return bag;
}

function positionOf(node: XmlNode): DexpiPosition | undefined {
  const position = node.Position as XmlNode | undefined;
  const location = position?.Location as XmlNode | undefined;
  if (!location) {
    return undefined;
  }
  const x = num(location['@_X']);
  const y = num(location['@_Y']);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  const z = num(location['@_Z']);
  return z === undefined ? { x, y } : { x, y, z };
}

function baseNode(tag: string, raw: XmlNode): DexpiNode {
  const attributes = attributesOf(raw);
  const node: DexpiNode = { tag, attributes };
  if (attributes.ID) {
    node.id = attributes.ID;
  }
  if (attributes.ComponentClass) {
    node.componentClass = attributes.ComponentClass;
  }
  if (attributes.ComponentName || attributes.TagName) {
    node.componentName = attributes.ComponentName ?? attributes.TagName;
  }
  const pos = positionOf(raw);
  if (pos) {
    node.position = pos;
  }
  const extent = raw.Extent as XmlNode | undefined;
  const max = extent?.Max as XmlNode | undefined;
  if (max) {
    const width = num(max['@_X']);
    const height = num(max['@_Y']);
    if (width !== undefined && height !== undefined) {
      node.extent = { width, height };
    }
  }
  return node;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseNozzles(equipmentRaw: XmlNode): DexpiNozzle[] {
  return toArray(equipmentRaw.Nozzle as XmlNode | XmlNode[] | undefined).map((raw) => {
    const node = baseNode('Nozzle', raw) as DexpiNozzle;
    node.tag = 'Nozzle';
    node.ownerId = String((equipmentRaw as XmlNode)['@_ID'] ?? '') || undefined;
    return node;
  });
}

function parseSegments(plant: XmlNode): DexpiSegment[] {
  const systems = toArray(plant.PipingNetworkSystem as XmlNode | XmlNode[] | undefined);
  const segments: DexpiSegment[] = [];
  for (const system of systems) {
    for (const raw of toArray(system.PipingNetworkSegment as XmlNode | XmlNode[] | undefined)) {
      const node = baseNode('PipingNetworkSegment', raw) as DexpiSegment;
      node.tag = 'PipingNetworkSegment';
      node.connections = toArray(raw.Connection as XmlNode | XmlNode[] | undefined).map((c) => ({
        fromId: (c['@_FromID'] as string) ?? undefined,
        toId: (c['@_ToID'] as string) ?? undefined,
      }));
      const centerLine = raw.CenterLine as XmlNode | undefined;
      node.centerLine = toArray(centerLine?.Coordinate as XmlNode | XmlNode[] | undefined)
        .map((coord) => {
          const x = num(coord['@_X']);
          const y = num(coord['@_Y']);
          if (x === undefined || y === undefined) {
            return undefined;
          }
          const z = num(coord['@_Z']);
          return z === undefined ? { x, y } : { x, y, z };
        })
        .filter((p): p is DexpiPosition => p !== undefined);
      segments.push(node);
    }
  }
  return segments;
}

export function parseDexpi(xml: string): Result<DexpiModel, DexpiParseError> {
  if (!xml || !xml.trim()) {
    return err(new DexpiParseError('Empty document'));
  }

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    const e = validation.err;
    return err(new DexpiParseError(`Malformed XML: ${e.msg}`, e.line, e.col));
  }

  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (cause) {
    return err(new DexpiParseError(`XML parse failed: ${(cause as Error).message}`));
  }

  const plant = (doc.PlantModel ?? doc.Proteus ?? doc) as XmlNode;
  const info = (plant.PlantInformation ?? {}) as XmlNode;
  const infoAttrs = attributesOf(info);

  const equipment: DexpiEquipment[] = toArray(
    plant.Equipment as XmlNode | XmlNode[] | undefined,
  ).map((raw) => {
    const node = baseNode('Equipment', raw) as DexpiEquipment;
    node.tag = 'Equipment';
    node.nozzles = parseNozzles(raw);
    return node;
  });

  const segments = parseSegments(plant);

  const instrumentation: DexpiNode[] = [
    ...toArray(plant.ProcessInstrumentationFunction as XmlNode | XmlNode[] | undefined),
    ...toArray(plant.ProcessInstrument as XmlNode | XmlNode[] | undefined),
  ].map((raw) => baseNode('Instrumentation', raw));

  const index: Record<string, DexpiNode> = {};
  const register = (node: DexpiNode): void => {
    if (node.id) {
      index[node.id] = node;
    }
  };
  for (const eq of equipment) {
    register(eq);
    eq.nozzles.forEach(register);
  }
  segments.forEach(register);
  instrumentation.forEach(register);

  const model: DexpiModel = {
    plantInformation: {
      schemaVersion: infoAttrs.SchemaVersion ?? infoAttrs.OriginatingSystemVersion,
      originatingSystem: infoAttrs.OriginatingSystem,
      date: infoAttrs.Date,
      attributes: infoAttrs,
    },
    equipment,
    segments,
    instrumentation,
    index,
  };

  return ok(model);
}
