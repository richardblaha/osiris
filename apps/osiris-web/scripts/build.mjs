#!/usr/bin/env node
/**
 * Build the branded OpenVSCode Server checkout. Network- and toolchain-heavy;
 * exercised by `.github/workflows/build-web.yml`, not by unit tests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readUpstreamConfig } from './lib.mjs';

const { checkoutDir } = await readUpstreamConfig();
if (!existsSync(checkoutDir)) {
  throw new Error('Run: pnpm --filter @osiris/web run prepare:shell');
}

const env = { ...process.env, OSIRIS_TELEMETRY: 'off', NODE_OPTIONS: '--max-old-space-size=8192' };
const run = (cmd, args, cwd = checkoutDir) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env });

const rehTarget = `vscode-reh-web-${process.platform}-${process.arch}-min`;

console.log('[osiris-web] installing upstream deps…');
run('npm', ['ci']);

reconcileRemoteTree();

console.log(`[osiris-web] building ${rehTarget}…`);
run('npm', ['run', 'gulp', rehTarget]);
console.log('[osiris-web] build finished — output in .build/vscode-reh-web-<platform>-<arch>/');

/**
 * The gulp `*-min-ci` step runs `npm ls --all --omit=dev --parseable` inside
 * `remote/` and aborts on any problem it does not explicitly tolerate. npm's
 * dependency resolver drifts between major versions, so driving the build with
 * this repo's Node (>=22) rather than the checkout's `.nvmrc` (Node 20) can
 * leave the `remote/` tree with a missing peer (`tslib`) or an extraneous
 * package (`@parcel/node-addon-api`). Reconcile only when the tree is actually
 * broken, so a matching toolchain is left untouched.
 */
function reconcileRemoteTree() {
  const remoteDir = path.join(checkoutDir, 'remote');
  const ls = spawnSync('npm', ['ls', '--all', '--omit=dev', '--parseable'], {
    cwd: remoteDir,
    env,
    encoding: 'utf8',
  });
  if (ls.status === 0) return;

  // Same classes the upstream build's `getNpmProductionDependencies` tolerates.
  const problems = `${ls.stdout}\n${ls.stderr}`
    .split(/\r?\n/)
    .filter((line) => /^npm (ERR!|error)/.test(line))
    .filter((line) => !/ELSPROBLEMS|invalid: xterm|A complete log of this run/.test(line));
  if (problems.length === 0) return;

  console.log('[osiris-web] reconciling remote/ dependency tree:');
  for (const line of problems) console.log(`  ${line}`);
  run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], remoteDir);
  run('npm', ['prune'], remoteDir); // drop extraneous packages
}
