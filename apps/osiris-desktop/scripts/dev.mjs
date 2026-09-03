#!/usr/bin/env node
/** Launch the branded prebuilt for this host straight from its stage dir. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertPrepared, findAppLayout, hostPlatformKey } from './lib.mjs';

const key = hostPlatformKey();
if (!key) throw new Error(`Unsupported host ${process.platform}-${process.arch}`);

const stage = assertPrepared(key);
const layout = await findAppLayout(stage);

const bin = key.startsWith('darwin')
  ? path.join(layout.appDir, 'Contents', 'MacOS', 'Electron')
  : path.join(layout.appDir, key.startsWith('win32') ? 'Osiris.exe' : 'osiris');

if (!existsSync(bin)) throw new Error(`launcher not found: ${bin} — run prepare:shell first`);

console.log(`[osiris-desktop] launching ${path.relative(stage, bin)} (Ctrl+C to stop)…`);
execFileSync(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, OSIRIS_TELEMETRY: 'off' },
});
