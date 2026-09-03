/**
 * Lay out the shared wrapper root that both `pack-appimage.mjs` and
 * `pack-snap.mjs` squash: the branded app tree under `usr/share/osiris/`, plus a
 * `.desktop` entry and a PNG icon at a caller-chosen spot.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PREFIX, desktopEntry } from './pack-linux.mjs';

const generatedIcon = fileURLToPath(
  new URL('../../../packages/branding/assets/generated/linux/code.png', import.meta.url),
);

/**
 * @param {string} sourceTree  a branded VSCodium prebuilt tree (contains `osiris`,
 *                             `bin/osiris`, `resources/app/product.json`, …)
 * @param {string} root        the wrapper root to populate (created if missing)
 * @returns {Promise<{appDir: string, icon: string}>}
 */
export async function buildWrapperRoot(sourceTree, root) {
  if (!existsSync(path.join(sourceTree, 'resources', 'app', 'product.json'))) {
    throw new Error(`[osiris-desktop] ${sourceTree} is not a branded prebuilt tree`);
  }
  if (!existsSync(generatedIcon)) {
    throw new Error(`[osiris-desktop] missing icon ${generatedIcon} — run branding render:icons`);
  }

  const appDir = path.join(root, APP_PREFIX);
  await mkdir(appDir, { recursive: true });
  await cp(sourceTree, appDir, { recursive: true });

  await writeFile(path.join(root, 'osiris.desktop'), desktopEntry());
  await mkdir(path.join(root, 'usr', 'share', 'applications'), { recursive: true });
  await writeFile(path.join(root, 'usr', 'share', 'applications', 'osiris.desktop'), desktopEntry());

  const iconTarget = path.join(root, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
  await mkdir(iconTarget, { recursive: true });
  const icon = await readFile(generatedIcon);
  await writeFile(path.join(iconTarget, 'osiris.png'), icon);
  await writeFile(path.join(root, 'osiris.png'), icon);

  return { appDir, icon: path.join(root, 'osiris.png') };
}
