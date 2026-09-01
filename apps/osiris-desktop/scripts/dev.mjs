#!/usr/bin/env node
/** Run the branded upstream checkout in watch/dev mode. */
import { execFileSync } from 'node:child_process';
import { assertPrepared } from './lib.mjs';

const checkoutDir = assertPrepared();

console.log('[osiris-desktop] launching upstream dev host (Ctrl+C to stop)…');
try {
  execFileSync('bash', ['-lc', 'yarn watch & ./scripts/code.sh'], {
    cwd: checkoutDir,
    stdio: 'inherit',
    env: { ...process.env, NAME_LONG: 'Osiris IDE', OSIRIS_TELEMETRY: 'off' },
  });
} catch (error) {
  console.error(
    '[osiris-desktop] dev host exited. Make sure the upstream toolchain (node-gyp, yarn) is installed.',
  );
  process.exitCode = 1;
  void error;
}
