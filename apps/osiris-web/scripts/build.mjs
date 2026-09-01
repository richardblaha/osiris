#!/usr/bin/env node
/**
 * Build the branded OpenVSCode Server checkout. Network- and toolchain-heavy;
 * exercised by `.github/workflows/build-web.yml`, not by unit tests.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readUpstreamConfig } from './lib.mjs';

const { checkoutDir } = await readUpstreamConfig();
if (!existsSync(checkoutDir)) {
  throw new Error('Run: pnpm --filter @osiris/web run prepare:shell');
}

const env = { ...process.env, OSIRIS_TELEMETRY: 'off', NODE_OPTIONS: '--max-old-space-size=8192' };

console.log('[osiris-web] installing upstream deps + building web server…');
execFileSync('npm', ['ci'], { cwd: checkoutDir, stdio: 'inherit', env });
execFileSync('npm', ['run', 'gulp', 'vscode-reh-web-linux-x64-min'], {
  cwd: checkoutDir,
  stdio: 'inherit',
  env,
});
console.log('[osiris-web] build finished — see the checkout for the server bundle.');
