#!/usr/bin/env node
/**
 * The default `build` task for the desktop app is a light readiness check so
 * `turbo run build` stays fast and green across the monorepo. The heavy upstream
 * build is `build:shell` (run by CI or explicitly), which needs `prepare:shell`
 * first.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './lib.mjs';

const prepared = existsSync(path.join(appRoot, '.build', 'vscodium', '.git'));
if (prepared) {
  console.log(
    '[osiris-desktop] shell checkout present — run `pnpm --filter @osiris/desktop build:shell` to compile it.',
  );
} else {
  console.log(
    '[osiris-desktop] shell not prepared (expected in CI/dev only). ' +
      'Run `pnpm --filter @osiris/desktop run prepare:shell` then `build:shell` to produce installers.',
  );
}
