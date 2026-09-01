import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@osiris/shared-core';
import { parseStep } from '../src/parser/stepParser.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseStep', () => {
  it('parses the header block', () => {
    const result = parseStep(fixture('cube-wireframe.step'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const h = result.value.header;
    expect(h.name).toBe('cube-wireframe.step');
    expect(h.description).toEqual(['Osiris test wireframe', 'tiny']);
    expect(h.schemaIdentifiers).toEqual(['AUTOMOTIVE_DESIGN { 1 0 10303 214 }']);
    expect(result.value.schemaIdentifiers).toEqual(h.schemaIdentifiers);
  });

  it('indexes every DATA entity and resolves forward references', () => {
    const result = parseStep(fixture('cube-wireframe.step'));
    if (!isOk(result)) throw new Error('parse failed');
    const model = result.value;

    expect(model.entities.size).toBe(16);
    expect(model.byType('CARTESIAN_POINT')).toHaveLength(8);

    const polyline = model.getEntity(20);
    expect(polyline?.type).toBe('POLYLINE');
    const list = polyline?.parameters[1];
    expect(list?.kind).toBe('list');
    if (list?.kind === 'list') {
      // forward reference #10 resolves to a real entity
      const firstRef = list.items[0];
      expect(firstRef).toEqual({ kind: 'ref', id: 10 });
      expect(model.getEntity(10)?.type).toBe('CARTESIAN_POINT');
    }
  });

  it('merges complex instances into a single entity', () => {
    const result = parseStep(fixture('complex-instance.step'));
    if (!isOk(result)) throw new Error('parse failed');
    const unit = result.value.getEntity(2);
    expect(unit).toBeDefined();
    expect(unit?.type).toBe('NAMED_UNIT');
    // the remaining typed records are appended as typed parameters
    expect(unit?.parameters.some((p) => p.kind === 'typed' && p.typeName === 'SI_UNIT')).toBe(true);
  });

  it('parses typed parameters like LENGTH_MEASURE(1.5E1)', () => {
    const result = parseStep(fixture('complex-instance.step'));
    if (!isOk(result)) throw new Error('parse failed');
    const measure = result.value.getEntity(3);
    const typed = measure?.parameters[1];
    expect(typed).toEqual({
      kind: 'typed',
      typeName: 'LENGTH_MEASURE',
      value: { kind: 'number', value: 15 },
    });
  });

  it('reports a parse error with position for a malformed file', () => {
    const result = parseStep(fixture('broken.step'));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.line).toBeGreaterThan(0);
  });

  it('rejects a file without the ISO-10303-21 preamble', () => {
    expect(isErr(parseStep('HEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;'))).toBe(true);
  });
});
