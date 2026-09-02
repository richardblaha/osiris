import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export { metadata } from './metadata.js';
export type { OsirisMetadata, OsirisColors } from './metadata.js';

/** Absolute path to the package root (works from `dist/` after compilation). */
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export const assetsDir = join(packageRoot, 'assets');
/** Rasterised icon set produced by `scripts/render-icons.mjs` (git-ignored, built in CI). */
export const generatedIconsDir = join(assetsDir, 'generated');

export type IconTarget = 'svg' | 'png' | 'ico' | 'icns';

const ICONS: Record<IconTarget, string> = {
  svg: 'assets/osiris.svg',
  png: 'assets/generated/png/icon-1024.png',
  ico: 'assets/generated/electron/icon.ico',
  icns: 'assets/generated/electron/icon.icns',
};

/** Resolve an absolute path to a branding icon asset (rasters require `render-icons` to have run). */
export function resolveIcon(target: IconTarget): string {
  return join(packageRoot, ICONS[target]);
}

/** The master app-icon SVG every raster target is derived from. */
export const masterIconPath = join(assetsDir, 'osiris-icon.svg');

/** Single-tone empty-editor watermarks, keyed by workbench theme kind. */
export const letterpressPaths = {
  dark: join(assetsDir, 'letterpress-dark.svg'),
  light: join(assetsDir, 'letterpress-light.svg'),
  hc: join(assetsDir, 'letterpress-hc.svg'),
} as const;

/** Bundled Fira Code — shipped so a fresh install needs no system font. */
export const fontPaths = {
  firaCodeWoff2: join(assetsDir, 'fonts', 'FiraCode-VF.woff2'),
  license: join(assetsDir, 'fonts', 'OFL.txt'),
} as const;

export const themePaths = {
  dark: join(packageRoot, 'themes/osiris-dark.json'),
  light: join(packageRoot, 'themes/osiris-light.json'),
} as const;

export const productOverlayPath = join(packageRoot, 'product.overlay.json');

/** Load the VSCodium `product.json` overlay as a plain object. */
export async function loadProductOverlay(): Promise<Record<string, unknown>> {
  const raw = await readFile(productOverlayPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  delete parsed.$comment;
  return parsed;
}
