import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@osiris/shared-core';
import { parseDexpi } from '../src/parser/dexpiParser.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseDexpi', () => {
  it('parses equipment, nozzles and segments from a valid file', () => {
    const result = parseDexpi(fixture('simple-valid.dexpi'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const model = result.value;

    expect(model.plantInformation.originatingSystem).toBe('Osiris Test');
    expect(model.equipment).toHaveLength(2);

    const tank = model.equipment.find((e) => e.id === 'E-100');
    expect(tank?.componentClass).toBe('Tank');
    expect(tank?.componentName).toBe('Feed Tank');
    expect(tank?.position).toEqual({ x: 100, y: 200, z: 0 });
    expect(tank?.extent).toEqual({ width: 60, height: 80 });
    expect(tank?.nozzles).toHaveLength(2);

    expect(model.segments).toHaveLength(1);
    expect(model.segments[0]?.centerLine).toHaveLength(4);
    expect(model.segments[0]?.connections[0]).toEqual({ fromId: 'E-100-N2', toId: 'P-200-N1' });
  });

  it('indexes every element with an ID', () => {
    const result = parseDexpi(fixture('simple-valid.dexpi'));
    if (!isOk(result)) throw new Error('expected ok');
    expect(Object.keys(result.value.index).sort()).toEqual(
      ['E-100', 'E-100-N1', 'E-100-N2', 'P-200', 'P-200-N1', 'SEG-1'].sort(),
    );
  });

  it('returns an error with a line number for malformed XML', () => {
    const result = parseDexpi(fixture('malformed.dexpi'));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.message).toMatch(/Malformed XML/);
    expect(result.error.line).toBeGreaterThan(0);
  });

  it('rejects an empty document', () => {
    expect(isErr(parseDexpi('   '))).toBe(true);
  });
});
