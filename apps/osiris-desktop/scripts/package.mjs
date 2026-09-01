#!/usr/bin/env node
/**
 * Wrap the built app with electron-builder to produce OS installers.
 * Expects `scripts/build.mjs` (or the CI job) to have produced the app under
 * `.build/vscodium/VSCode-<platform>` per the upstream layout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { appRoot, assertPrepared } from './lib.mjs';

assertPrepared();

const configPath = path.join(appRoot, 'electron-builder.yml');
if (!existsSync(configPath)) {
  throw new Error('electron-builder.yml missing');
}

const targetFlag =
  process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux';

console.log(`[osiris-desktop] electron-builder ${targetFlag}`);
execFileSync(
  'npx',
  ['--yes', 'electron-builder', targetFlag, '--config', configPath, '--publish', 'never'],
  { cwd: appRoot, stdio: 'inherit' },
);
console.log('[osiris-desktop] installers written to dist_electron/');
