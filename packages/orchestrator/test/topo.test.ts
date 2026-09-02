import { describe, expect, it } from 'vitest';
import { topoSort } from '../src/topo.js';
import type { ServiceSpec } from '../src/stack.js';

const svc = (name: string, dependsOn?: string[]): ServiceSpec => ({
  name,
  image: 'scratch',
  dependsOn,
});

describe('topoSort', () => {
  it('orders dependencies before their dependents', () => {
    const order = topoSort([svc('a', ['b']), svc('b'), svc('c', ['a'])]).map((s) => s.name);
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
  });

  it('keeps every service', () => {
    expect(topoSort([svc('a'), svc('b'), svc('c')])).toHaveLength(3);
  });

  it('throws on an unknown dependency', () => {
    expect(() => topoSort([svc('a', ['ghost'])])).toThrow(/unknown/);
  });

  it('throws on a cycle', () => {
    expect(() => topoSort([svc('a', ['b']), svc('b', ['a'])])).toThrow(/cycle/);
  });
});
