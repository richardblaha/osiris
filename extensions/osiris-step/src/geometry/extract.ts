/**
 * Extract a lightweight wireframe + point cloud from a parsed {@link StepModel}.
 *
 * This is intentionally shallow: it reads `CARTESIAN_POINT` coordinates and
 * connects them along `POLYLINE`, `B_SPLINE_CURVE*` control polygons and
 * `POLY_LOOP` / `EDGE_LOOP` vertex rings. It does NOT tessellate NURBS or B-rep
 * surfaces — the goal is a recognizable preview, not an analysis mesh.
 */
import type { StepValue, StepGeometry, Vec3 } from '@osiris/shared-core';
import type { StepModel } from '../parser/stepParser.js';

const ZERO_BBOX = (): StepGeometry['bbox'] => ({
  min: { x: 0, y: 0, z: 0 },
  max: { x: 0, y: 0, z: 0 },
});

function refId(value: StepValue | undefined): number | undefined {
  return value?.kind === 'ref' ? value.id : undefined;
}

function numberAt(value: StepValue | undefined): number | undefined {
  if (value?.kind === 'number') {
    return value.value;
  }
  if (value?.kind === 'typed') {
    return numberAt(value.value);
  }
  return undefined;
}

function refsOf(value: StepValue | undefined): number[] {
  if (value?.kind === 'list') {
    return value.items.map(refId).filter((id): id is number => id !== undefined);
  }
  return [];
}

function cartesianPoint(model: StepModel, id: number): Vec3 | undefined {
  const entity = model.getEntity(id);
  if (!entity || entity.type.toUpperCase() !== 'CARTESIAN_POINT') {
    return undefined;
  }
  const coords = entity.parameters[1];
  if (coords?.kind !== 'list') {
    return undefined;
  }
  const [x, y, z] = coords.items.map(numberAt);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y, z: z ?? 0 };
}

/**
 * Follow VERTEX_POINT → CARTESIAN_POINT, returning the *cartesian point id* so
 * callers key the point cloud consistently (a vertex and the point it names
 * collapse to one entry).
 */
function resolvePoint(model: StepModel, id: number): { id: number; vec: Vec3 } | undefined {
  const entity = model.getEntity(id);
  if (!entity) {
    return undefined;
  }
  const type = entity.type.toUpperCase();
  if (type === 'CARTESIAN_POINT') {
    const vec = cartesianPoint(model, id);
    return vec ? { id, vec } : undefined;
  }
  if (type === 'VERTEX_POINT') {
    const target = refId(entity.parameters[1]);
    if (target === undefined) {
      return undefined;
    }
    const vec = cartesianPoint(model, target);
    return vec ? { id: target, vec } : undefined;
  }
  return undefined;
}

export function extractGeometry(model: StepModel): StepGeometry {
  const points: Vec3[] = [];
  const pointIndex = new Map<number, number>();
  const lineSegments: [number, number][] = [];

  const indexOfPoint = (id: number, vec: Vec3): number => {
    let existing = pointIndex.get(id);
    if (existing === undefined) {
      existing = points.length;
      points.push(vec);
      pointIndex.set(id, existing);
    }
    return existing;
  };

  // Every CARTESIAN_POINT becomes part of the cloud.
  for (const entity of model.byType('CARTESIAN_POINT')) {
    const vec = cartesianPoint(model, entity.id);
    if (vec) {
      indexOfPoint(entity.id, vec);
    }
  }

  const connectRing = (ids: number[], closed: boolean): void => {
    const resolved = ids
      .map((id) => {
        const point = resolvePoint(model, id);
        return point ? indexOfPoint(point.id, point.vec) : undefined;
      })
      .filter((idx): idx is number => idx !== undefined);
    for (let k = 0; k < resolved.length - 1; k++) {
      lineSegments.push([resolved[k]!, resolved[k + 1]!]);
    }
    if (closed && resolved.length > 2) {
      lineSegments.push([resolved[resolved.length - 1]!, resolved[0]!]);
    }
  };

  for (const polyline of model.byType('POLYLINE')) {
    connectRing(refsOf(polyline.parameters[1]), false);
  }
  for (const type of [
    'B_SPLINE_CURVE',
    'B_SPLINE_CURVE_WITH_KNOTS',
    'BEZIER_CURVE',
    'RATIONAL_B_SPLINE_CURVE',
  ]) {
    for (const curve of model.byType(type)) {
      connectRing(refsOf(curve.parameters[2]), false);
    }
  }
  for (const loop of model.byType('POLY_LOOP')) {
    connectRing(refsOf(loop.parameters[1]), true);
  }
  for (const edge of model.byType('EDGE_CURVE')) {
    const a = refId(edge.parameters[1]);
    const b = refId(edge.parameters[2]);
    const pa = a !== undefined ? resolvePoint(model, a) : undefined;
    const pb = b !== undefined ? resolvePoint(model, b) : undefined;
    if (pa && pb) {
      lineSegments.push([indexOfPoint(pa.id, pa.vec), indexOfPoint(pb.id, pb.vec)]);
    }
  }

  return { points, lineSegments, bbox: computeBBox(points) };
}

export function computeBBox(points: Vec3[]): StepGeometry['bbox'] {
  if (points.length === 0) {
    return ZERO_BBOX();
  }
  const min = { ...points[0]! };
  const max = { ...points[0]! };
  for (const p of points) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}
