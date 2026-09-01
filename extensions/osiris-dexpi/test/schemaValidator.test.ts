import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOk } from '@osiris/shared-core';
import { parseDexpi } from '../src/parser/dexpiParser.js';
import { summarize, validateDexpi } from '../src/parser/schemaValidator.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

function modelOf(name: string) {
  const result = parseDexpi(fixture(name));
  if (!isOk(result)) throw new Error('fixture did not parse');
  return result.value;
}

describe('validateDexpi', () => {
  it('reports no errors for a clean file', () => {
    const issues = validateDexpi(modelOf('simple-valid.dexpi'));
    expect(summarize(issues).errors).toBe(0);
  });

  it('flags duplicate IDs (DEXPI002)', () => {
    const issues = validateDexpi(modelOf('broken.dexpi'));
    expect(issues.some((i) => i.code === 'DEXPI002')).toBe(true);
  });

  it('flags missing required equipment attributes (DEXPI003)', () => {
    const issues = validateDexpi(modelOf('broken.dexpi'));
    const missingClass = issues.find((i) => i.code === 'DEXPI003');
    expect(missingClass?.severity).toBe('error');
    expect(missingClass?.message).toMatch(/ComponentClass/);
  });

  it('flags equipment with no position (DEXPI004)', () => {
    const issues = validateDexpi(modelOf('broken.dexpi'));
    expect(issues.some((i) => i.code === 'DEXPI004')).toBe(true);
  });

  it('flags unresolved connection references (DEXPI008) and dangling ends (DEXPI007)', () => {
    const issues = validateDexpi(modelOf('broken.dexpi'));
    expect(issues.some((i) => i.code === 'DEXPI008' && i.message.includes('DOES-NOT-EXIST'))).toBe(
      true,
    );
    expect(issues.some((i) => i.code === 'DEXPI007')).toBe(true);
  });

  it('reports a segment with no connections (DEXPI006)', () => {
    const issues = validateDexpi(modelOf('broken.dexpi'));
    expect(issues.some((i) => i.code === 'DEXPI006')).toBe(true);
  });
});
