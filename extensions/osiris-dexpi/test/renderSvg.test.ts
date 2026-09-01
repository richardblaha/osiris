import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOk } from '@osiris/shared-core';
import { parseDexpi } from '../src/parser/dexpiParser.js';
import { renderDexpiSvg } from '../src/preview/renderSvg.js';

const xml = readFileSync(
  fileURLToPath(new URL('./fixtures/simple-valid.dexpi', import.meta.url)),
  'utf8',
);

describe('renderDexpiSvg', () => {
  it('produces a well-formed SVG with one rect per equipment and a path per segment', () => {
    const parsed = parseDexpi(xml);
    if (!isOk(parsed)) throw new Error('parse failed');
    const svg = renderDexpiSvg(parsed.value);

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(3); // background + 2 equipment
    expect(svg).toContain('<path ');
    expect(svg).toContain('data-id="E-100"');
  });

  it('highlights the requested ids with the alt accent colour', () => {
    const parsed = parseDexpi(xml);
    if (!isOk(parsed)) throw new Error('parse failed');
    const svg = renderDexpiSvg(parsed.value, { highlight: ['E-100'], accentAlt: '#FF00FF' });
    const rectForE100 = svg.split('\n').find((l) => l.includes('data-id="E-100"'));
    expect(rectForE100).toContain('#FF00FF');
  });

  it('does not throw on an empty model', () => {
    expect(() =>
      renderDexpiSvg({
        plantInformation: { attributes: {} },
        equipment: [],
        segments: [],
        instrumentation: [],
        index: {},
      }),
    ).not.toThrow();
  });
});
