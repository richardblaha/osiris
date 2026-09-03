import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDeep } from './lib.mjs';
import {
  artifactName,
  binaryRenames,
  brandProductJson,
  curateOverlayForPrebuilt,
  patchLauncherScript,
  PREBUILT_PROTECTED_KEYS,
} from './rebrand.mjs';

test('curateOverlayForPrebuilt drops upstream-owned keys', () => {
  const overlay = {
    nameLong: 'Osiris IDE',
    builtInExtensions: [],
    extensionsGallery: { serviceUrl: 'x' },
    checksums: { a: 'b' },
    enableTelemetry: false,
  };
  const out = curateOverlayForPrebuilt(overlay);
  assert.equal(out.nameLong, 'Osiris IDE');
  assert.equal(out.enableTelemetry, false);
  for (const k of PREBUILT_PROTECTED_KEYS) assert.ok(!(k in out), `${k} should be dropped`);
});

test('brandProductJson keeps the prebuilt bundled extensions + checksums', () => {
  const upstream = {
    nameShort: 'VSCodium',
    nameLong: 'VSCodium',
    applicationName: 'codium',
    builtInExtensions: [{ name: 'ms-vscode.js-debug', version: '1.0.0' }],
    checksums: { 'vs/x': 'deadbeef' },
    extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' },
  };
  const overlay = {
    nameShort: 'Osiris',
    nameLong: 'Osiris IDE',
    applicationName: 'osiris',
    builtInExtensions: [],
    checksums: {},
    enableTelemetry: false,
  };

  const branded = brandProductJson(upstream, overlay, mergeDeep);

  assert.equal(branded.nameLong, 'Osiris IDE');
  assert.equal(branded.applicationName, 'osiris');
  assert.equal(branded.enableTelemetry, false);
  assert.deepEqual(branded.builtInExtensions, upstream.builtInExtensions, 'bundled set preserved');
  assert.deepEqual(branded.checksums, upstream.checksums, 'integrity metadata preserved');
});

test('binaryRenames are platform-specific', () => {
  assert.deepEqual(binaryRenames('linux-x64')[0], ['codium', 'osiris']);
  assert.ok(binaryRenames('win32-x64').some(([from]) => from === 'VSCodium.exe'));
  assert.deepEqual(binaryRenames('darwin-arm64'), [], 'macOS bundle left intact');
});

test('artifactName', () => {
  assert.equal(artifactName('linux-x64', '1.94.2.24286'), 'Osiris-linux-x64-1.94.2.24286');
});

test('patchLauncherScript retargets the renamed binary', () => {
  const linux = patchLauncherScript(
    'ELECTRON="$VSCODE_PATH/codium"\nVSCODE_PATH="/usr/share/codium"',
  );
  assert.match(linux, /\$VSCODE_PATH\/osiris/);
  assert.match(linux, /\/usr\/share\/osiris/);
  assert.doesNotMatch(linux, /codium/);

  const win = patchLauncherScript('NAME="VSCodium"\nSERVERDATAFOLDER=".vscodium-server"');
  assert.match(win, /NAME="Osiris"/);
  assert.match(win, /\.osiris-server/);
});
