import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Deep-merge `source` onto `target`; arrays are replaced. */
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

export async function readUpstreamConfig() {
  const raw = await readFile(path.join(appRoot, 'config', 'upstream.json'), 'utf8');
  const config = JSON.parse(raw);
  return {
    repository: config.repository,
    tag: config.tag,
    checkoutDir: path.resolve(appRoot, config.checkoutDir ?? '.build/server'),
  };
}

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

/** Resolve the built server entrypoint inside the checkout, if present. */
export function findServerEntrypoint(checkoutDir) {
  const candidates = [
    'out/server-main.js',
    'server.js',
    'bin/openvscode-server',
    'scripts/code-server.sh',
  ].map((rel) => path.join(checkoutDir, rel));
  return candidates.find((candidate) => existsSync(candidate));
}
