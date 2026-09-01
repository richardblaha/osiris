import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOk } from '@osiris/shared-core';
import { parseStep } from '../src/parser/stepParser.js';
import { computeBBox, extractGeometry } from '../src/geometry/extract.js';
import { computeStats } from '../src/stats.js';

const source = readFileSync(
  fileURLToPath(new URL('./fixtures/cube-wireframe.step', import.meta.url)),
  'utf8',
);

function model() {
  const result = parseStep(source);
  if (!isOk(result)) throw new Error('parse failed');
  return result.value;
}

describe('extractGeometry', () => {
  it('collects every cartesian point into the cloud', () => {
    const geo = extractGeometry(model());
    expect(geo.points).toHaveLength(8);
  });

  it('connects polyline vertices into line segments', () => {
    const geo = extractGeometry(model());
    // two 5-vertex polylines => 4 + 4 segments, plus one EDGE_CURVE pillar
    expect(geo.lineSegments.length).toBeGreaterThanOrEqual(8);
  });

  it('computes a bounding box over the unit cube', () => {
    const geo = extractGeometry(model());
    expect(geo.bbox.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(geo.bbox.max).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('computeBBox returns a zero box for no points', () => {
    expect(computeBBox([])).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  });
});

describe('computeStats', () => {
  it('summarizes entity types', () => {
    const stats = computeStats(model());
    expect(stats.entityCount).toBe(16);
    expect(stats.schemaIdentifiers).toEqual(['AUTOMOTIVE_DESIGN { 1 0 10303 214 }']);
    expect(stats.topTypes[0]).toEqual({ type: 'CARTESIAN_POINT', count: 8 });
  });
});
