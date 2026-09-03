#!/usr/bin/env node
/**
 * The default `build` task is a light readiness check so `turbo run build` stays
 * fast and green across the monorepo. The real work is `prepare:shell` (fetch +
 * rebrand the VSCodium prebuilt) then `package` (repack), run by CI or by hand.
 */
import { hostPlatformKey, listStaged } from './lib.mjs';

const staged = await listStaged();
if (staged.length > 0) {
  console.log(
    `[osiris-desktop] staged: ${staged.join(', ')} — run \`pnpm --filter @osiris/desktop package\` to repack.`,
  );
} else {
  const host = hostPlatformKey();
  console.log(
    `[osiris-desktop] nothing staged (expected in CI/dev only).\n` +
      `  pnpm --filter @osiris/desktop run prepare:shell${host ? '' : ' -- <platform-key>'}\n` +
      `  pnpm --filter @osiris/desktop package`,
  );
}
