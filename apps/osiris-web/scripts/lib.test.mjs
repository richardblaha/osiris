import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeep, readProductOverlay, findServerEntrypoint } from './lib.mjs';

test('mergeDeep merges nested objects, replaces arrays', () => {
  assert.deepEqual(mergeDeep({ a: { b: 1 }, list: [1] }, { a: { c: 2 }, list: [9, 9] }), {
    a: { b: 1, c: 2 },
    list: [9, 9],
  });
});

test('overlay forces telemetry off and Open VSX', async () => {
  const overlay = await readProductOverlay();
  assert.equal(overlay.enableTelemetry, false);
  assert.match(overlay.extensionsGallery.itemUrl, /open-vsx\.org/);
});

test('findServerEntrypoint returns undefined for an empty dir', () => {
  assert.equal(findServerEntrypoint('/tmp/definitely-not-a-checkout-xyz'), undefined);
});
