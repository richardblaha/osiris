import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeep, readProductOverlay } from './lib.mjs';

test('mergeDeep merges nested objects and replaces arrays', () => {
  const result = mergeDeep(
    { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] },
    { a: 2, nested: { y: 9, z: 3 }, list: [9] },
  );
  assert.deepEqual(result, { a: 2, nested: { x: 1, y: 9, z: 3 }, list: [9] });
});

test('mergeDeep does not mutate its inputs', () => {
  const target = { nested: { x: 1 } };
  mergeDeep(target, { nested: { x: 2 } });
  assert.equal(target.nested.x, 1);
});

test('product overlay loads and targets Open VSX', async () => {
  const overlay = await readProductOverlay();
  assert.equal(overlay.nameLong, 'Osiris IDE');
  assert.equal(overlay.enableTelemetry, false);
  assert.match(overlay.extensionsGallery.serviceUrl, /open-vsx\.org/);
});
