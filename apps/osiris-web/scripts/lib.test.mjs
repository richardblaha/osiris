import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeDeep, readProductOverlay, findServerEntrypoint, rehBuildDir } from './lib.mjs';

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

test('rehBuildDir is a platform/arch-suffixed sibling of the checkout', () => {
  const dir = rehBuildDir('/x/.build/server');
  assert.equal(dir, path.join('/x/.build', `vscode-reh-web-${process.platform}-${process.arch}`));
});

test('findServerEntrypoint prefers the built REH bundle over the source checkout', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'osiris-reh-'));
  const checkoutDir = path.join(root, '.build', 'server');
  mkdirSync(path.join(checkoutDir, 'scripts'), { recursive: true });
  writeFileSync(path.join(checkoutDir, 'scripts', 'code-server.sh'), '#!/bin/sh\n');
  // only the source checkout exists yet
  assert.equal(
    findServerEntrypoint(checkoutDir),
    path.join(checkoutDir, 'scripts', 'code-server.sh'),
  );

  // once the bundle is built, its launcher wins
  const built = rehBuildDir(checkoutDir);
  const launcher = path.join(
    built,
    'bin',
    process.platform === 'win32' ? 'osiris-server.cmd' : 'osiris-server',
  );
  mkdirSync(path.dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/usr/bin/env sh\n');
  assert.equal(findServerEntrypoint(checkoutDir), launcher);
});
