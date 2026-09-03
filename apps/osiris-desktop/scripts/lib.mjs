import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The four platform/arch targets Osiris desktop rebrands. */
export const PLATFORM_KEYS = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

/** Where a prepared platform is unpacked: `.build/<platform-key>/`. */
export function stageDir(platformKey) {
  return path.join(appRoot, '.build', platformKey);
}

/** Platform keys currently unpacked under `.build/` (ignores `_cache` etc.). */
export async function listStaged() {
  const buildDir = path.join(appRoot, '.build');
  if (!existsSync(buildDir)) return [];
  const entries = await readdir(buildDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && PLATFORM_KEYS.includes(e.name))
    .map((e) => e.name);
}

/** This machine's platform key, or undefined on an unsupported host. */
export function hostPlatformKey() {
  const key = `${process.platform}-${process.arch}`;
  return PLATFORM_KEYS.includes(key) ? key : undefined;
}

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

/** Load `apps/osiris-desktop/config/upstream.json` and resolve a platform's asset name. */
export async function readUpstreamConfig() {
  const raw = await readFile(path.join(appRoot, 'config', 'upstream.json'), 'utf8');
  const config = JSON.parse(raw);
  const platforms = Object.fromEntries(
    Object.entries(config.platforms).map(([key, entry]) => [
      key,
      { ...entry, asset: entry.asset.replaceAll('{release}', config.release) },
    ]),
  );
  return {
    repository: config.repository,
    release: config.release,
    platforms,
    downloadUrl: (key) =>
      `https://github.com/${config.repository}/releases/download/${config.release}/${platforms[key].asset}`,
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

/**
 * Locate the application root inside an unpacked prebuilt — the directory that
 * holds `resources/app/product.json` (Linux/Windows, flat archives) or a
 * `*.app` bundle with `Contents/Resources/app/product.json` (macOS).
 */
export async function findAppLayout(stage) {
  if (existsSync(path.join(stage, 'resources', 'app', 'product.json'))) {
    return {
      kind: 'electron',
      appDir: stage,
      productJson: path.join(stage, 'resources', 'app', 'product.json'),
    };
  }
  for (const entry of await readdir(stage, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    const bundle = path.join(stage, entry.name);
    const product = path.join(bundle, 'Contents', 'Resources', 'app', 'product.json');
    if (existsSync(product)) return { kind: 'darwin', appDir: bundle, productJson: product };
  }
  throw new Error(`[osiris-desktop] no product.json found under ${stage} — archive layout changed`);
}

export function assertPrepared(platformKey) {
  const dir = stageDir(platformKey);
  if (!existsSync(dir)) {
    throw new Error(
      `Prebuilt for ${platformKey} not prepared. Run: pnpm --filter @osiris/desktop run prepare:shell`,
    );
  }
  return dir;
}
