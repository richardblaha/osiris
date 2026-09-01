import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Deep-merge `source` onto `target` (arrays are replaced, not concatenated). */
export function mergeDeep(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeDeep(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Load `apps/osiris-desktop/config/upstream.json`. */
export async function readUpstreamConfig() {
  const raw = await readFile(path.join(appRoot, 'config', 'upstream.json'), 'utf8');
  const config = JSON.parse(raw);
  return {
    repository: config.repository,
    tag: config.tag,
    checkoutDir: path.resolve(appRoot, config.checkoutDir ?? '.build/vscodium'),
  };
}

/** Load the Osiris product.json overlay from @osiris/branding. */
export async function readProductOverlay() {
  const require = createRequire(import.meta.url);
  let overlayPath;
  try {
    overlayPath = require.resolve('@osiris/branding/product-overlay');
  } catch {
    overlayPath = path.join(repoRoot, 'packages', 'branding', 'product.overlay.json');
  }
  const overlay = JSON.parse(await readFile(overlayPath, 'utf8'));
  delete overlay.$comment;
  return overlay;
}

export function assertPrepared() {
  const dir = path.resolve(appRoot, '.build/vscodium');
  if (!existsSync(dir)) {
    throw new Error(
      'Upstream shell not prepared. Run: pnpm --filter @osiris/desktop run prepare:shell',
    );
  }
  return dir;
}
