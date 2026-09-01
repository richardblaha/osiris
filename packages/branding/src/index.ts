import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export { metadata } from './metadata.js';
export type { OsirisMetadata, OsirisColors } from './metadata.js';

/** Absolute path to the package root (works from `dist/` after compilation). */
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

export type IconTarget = 'svg' | 'png' | 'ico' | 'icns';

const ICONS: Record<IconTarget, string> = {
  svg: 'assets/osiris.svg',
  png: 'assets/icon-1024.png',
  ico: 'assets/osiris.ico',
  icns: 'assets/osiris.icns',
};

/** Resolve an absolute path to a branding icon asset. */
export function resolveIcon(target: IconTarget): string {
  return join(packageRoot, ICONS[target]);
}

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
