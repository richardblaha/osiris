#!/usr/bin/env node
/**
 * Default `build` task for the web app: a light readiness check so
 * `turbo run build` stays green. The heavy upstream build is `build:shell`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { appRoot } from './lib.mjs';

const prepared = existsSync(path.join(appRoot, '.build', 'server', '.git'));
console.log(
  prepared
    ? '[osiris-web] shell checkout present — run `pnpm --filter @osiris/web build:shell` to compile the server bundle.'
    : '[osiris-web] shell not prepared. Run `pnpm --filter @osiris/web run prepare:shell` then `build:shell`.',
);
