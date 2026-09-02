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

/**
 * Directory the gulp `vscode-reh-web-<platform>-<arch>-min` task writes the
 * built server into — a sibling of the source checkout, e.g.
 * `.build/vscode-reh-web-linux-x64`.
 */
export function rehBuildDir(checkoutDir) {
  return path.join(path.dirname(checkoutDir), `vscode-reh-web-${process.platform}-${process.arch}`);
}

/**
 * Resolve the server entrypoint to run. Prefers the built REH bundle (its
 * `bin/` launcher execs the bundled Node), then falls back to the source
 * checkout so `dev`-style runs still work. Returns `undefined` when nothing
 * has been built yet.
 */
export function findServerEntrypoint(checkoutDir) {
  const isWin = process.platform === 'win32';
  const built = rehBuildDir(checkoutDir);
  const candidates = [
    path.join(built, 'bin', isWin ? 'osiris-server.cmd' : 'osiris-server'),
    path.join(built, 'bin', isWin ? 'openvscode-server.cmd' : 'openvscode-server'),
    path.join(built, 'out', 'server-main.js'),
    path.join(checkoutDir, 'out', 'server-main.js'),
    path.join(checkoutDir, 'server.js'),
    path.join(checkoutDir, 'scripts', 'code-server.sh'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
