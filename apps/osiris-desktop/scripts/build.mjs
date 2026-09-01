#!/usr/bin/env node
/**
 * Build the branded VSCodium checkout for the current platform. This delegates
 * to the upstream VSCodium build scripts (which themselves drive the Code - OSS
 * gulp pipeline) — it is network- and toolchain-heavy and is exercised in CI
 * (`.github/workflows/build-desktop.yml`), not in unit tests.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertPrepared } from './lib.mjs';

const checkoutDir = assertPrepared();

const isWin = process.platform === 'win32';
const buildScript = isWin
  ? path.join(checkoutDir, 'build.sh') // VSCodium ships a bash entrypoint; use Git Bash / WSL on Windows
  : path.join(checkoutDir, 'build.sh');

if (!existsSync(buildScript)) {
  console.warn(
    `[osiris-desktop] ${path.basename(buildScript)} not found in the upstream checkout. ` +
      'Refer to VSCodium docs for the current build entrypoint; this wrapper only sets Osiris env.',
  );
}

const env = {
  ...process.env,
  APP_NAME: 'Osiris',
  ASSETS_REPOSITORY: 'osiris-ide/osiris-releases',
  BINARY_NAME: 'osiris',
  ORG_NAME: 'osiris-ide',
  DISABLE_UPDATE: 'yes',
  CI_BUILD: process.env.CI ? 'yes' : 'no',
  SHOULD_BUILD: 'yes',
};

console.log('[osiris-desktop] starting upstream build (this takes a while)…');
execFileSync('bash', [buildScript], { cwd: checkoutDir, stdio: 'inherit', env });
console.log('[osiris-desktop] upstream build finished.');
