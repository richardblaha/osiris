#!/usr/bin/env node
/**
 * Apply Osiris branding to the cloned VSCodium checkout:
 *   1. deep-merge the product.json overlay,
 *   2. copy branding assets into the upstream tree,
 *   3. apply every tracked patch in `patches/`.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  copyBrandingIntoCheckout,
  copyElectronBuilderIcons,
} from '@osiris/branding/apply-to-checkout';
import { appRoot, mergeDeep, readProductOverlay, readUpstreamConfig } from './lib.mjs';

const { checkoutDir } = await readUpstreamConfig();
if (!existsSync(checkoutDir)) {
  throw new Error('Run clone-upstream.mjs first.');
}

// 1. product.json overlay -----------------------------------------------------
const productPath = path.join(checkoutDir, 'product.json');
const baseProduct = existsSync(productPath) ? JSON.parse(await readFile(productPath, 'utf8')) : {};
const overlay = await readProductOverlay();
const merged = mergeDeep(baseProduct, overlay);
await writeFile(productPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`[osiris-desktop] product.json: ${Object.keys(overlay).length} keys overlaid`);

// 2. branding assets — icons, empty-editor watermark, bundled Fira Code -------
await copyBrandingIntoCheckout(checkoutDir, { kind: 'desktop' });
await copyElectronBuilderIcons(path.join(appRoot, 'build'));

// 3. patches --------------------------------------------------------------
const patchesDir = path.join(appRoot, 'patches');
if (existsSync(patchesDir)) {
  const patches = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
  for (const patch of patches) {
    const patchPath = path.join(patchesDir, patch);
    try {
      execFileSync('git', ['apply', '--check', '--3way', patchPath], { cwd: checkoutDir });
      execFileSync('git', ['apply', '--3way', patchPath], { cwd: checkoutDir, stdio: 'inherit' });
      console.log(`[osiris-desktop] applied ${patch}`);
    } catch {
      console.warn(`[osiris-desktop] SKIPPED ${patch} (does not apply against this upstream tag)`);
    }
  }
}

console.log('[osiris-desktop] branding applied.');
