#!/usr/bin/env node
/**
 * Rasterise the whole Osiris icon set from the master SVG.
 *
 * `assets/osiris-icon.svg` (the padded app-icon variant of `assets/osiris.svg`)
 * is the single source of truth; every PNG / ICO / ICNS target below is derived
 * from it so the pipeline never carries stale binaries. Output lands in
 * `assets/generated/` (git-ignored). Run directly (`node scripts/render-icons.mjs`)
 * or import `renderIcons()` — `apply-branding.mjs` calls it when the folder is missing.
 *
 * CI (`build-desktop`, `build-web`) runs this before `prepare:shell`.
 */
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { Icns, IcnsImage } from '@fiahfy/icns';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assetsDir = path.join(packageRoot, 'assets');
const masterIcon = path.join(assetsDir, 'osiris-icon.svg');
export const generatedDir = path.join(assetsDir, 'generated');

/** ICO needs its member sizes; ICNS maps sizes to OSTypes. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
];

const png = (size, src = masterIcon) =>
  sharp(src, { density: 384 }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

async function writePng(size, dest) {
  await writeFile(dest, await png(size));
}

async function buildIco(dest, sizes = ICO_SIZES) {
  const buffers = await Promise.all(sizes.map((s) => png(s)));
  await writeFile(dest, await pngToIco(buffers));
}

async function buildIcns(dest) {
  const icns = new Icns();
  for (const [osType, size] of ICNS_TYPES) {
    try {
      icns.append(IcnsImage.fromPNG(await png(size), osType));
    } catch (err) {
      console.warn(`[branding] skipped ICNS ${osType}@${size}: ${err.message}`);
    }
  }
  await writeFile(dest, icns.data);
}

/** Recolour the master pyramid to a single tone for the empty-editor watermark. */
const LETTERPRESS = ['letterpress-dark.svg', 'letterpress-light.svg', 'letterpress-hc.svg'];

export async function renderIcons({ clean = true } = {}) {
  if (!existsSync(masterIcon)) throw new Error(`missing master icon: ${masterIcon}`);
  if (clean) await rm(generatedDir, { recursive: true, force: true });

  for (const sub of ['png', 'linux', 'win32', 'darwin', 'server', 'electron/icons']) {
    await mkdir(path.join(generatedDir, sub), { recursive: true });
  }

  // Generic PNG ladder (used by the web PWA manifest, docs, and as ICO/ICNS input).
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await writePng(size, path.join(generatedDir, 'png', `icon-${size}.png`));
  }

  // Linux desktop icon.
  await writePng(512, path.join(generatedDir, 'linux', 'code.png'));

  // Windows executable + installer tiles.
  await buildIco(path.join(generatedDir, 'win32', 'code.ico'));
  await writePng(70, path.join(generatedDir, 'win32', 'code_70x70.png'));
  await writePng(150, path.join(generatedDir, 'win32', 'code_150x150.png'));

  // macOS bundle icon.
  await buildIcns(path.join(generatedDir, 'darwin', 'code.icns'));

  // Server: browser favicon + PWA manifest icons.
  await buildIco(path.join(generatedDir, 'server', 'favicon.ico'), [16, 32, 48]);
  await writePng(192, path.join(generatedDir, 'server', 'code-192.png'));
  await writePng(512, path.join(generatedDir, 'server', 'code-512.png'));

  // electron-builder resources (apps/osiris-desktop/build/).
  await buildIco(path.join(generatedDir, 'electron', 'icon.ico'));
  await buildIcns(path.join(generatedDir, 'electron', 'icon.icns'));
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    await writePng(size, path.join(generatedDir, 'electron', 'icons', `${size}x${size}.png`));
  }

  // Empty-editor watermarks — copied straight through (already single-tone SVG).
  for (const name of LETTERPRESS) {
    await copyFile(path.join(assetsDir, name), path.join(generatedDir, name));
  }

  console.log(`[branding] icon set rendered → ${path.relative(process.cwd(), generatedDir)}`);
  return generatedDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await renderIcons();
}
