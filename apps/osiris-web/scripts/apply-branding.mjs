#!/usr/bin/env node
/** Merge the Osiris product.json overlay + assets into the OpenVSCode Server checkout. */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { copyBrandingIntoCheckout } from '@osiris/branding/apply-to-checkout';
import { mergeDeep, readProductOverlay, readUpstreamConfig } from './lib.mjs';

const { checkoutDir } = await readUpstreamConfig();
if (!existsSync(checkoutDir)) {
  throw new Error('Run clone-upstream.mjs first.');
}

const productPath = path.join(checkoutDir, 'product.json');
const base = existsSync(productPath) ? JSON.parse(await readFile(productPath, 'utf8')) : {};
const overlay = await readProductOverlay();

// The web build must keep serverApplicationName sane and telemetry off.
const merged = mergeDeep(base, {
  ...overlay,
  serverApplicationName: 'osiris-server',
  serverDataFolderName: '.osiris-server',
  enableTelemetry: false,
});
await writeFile(productPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`[osiris-web] product.json overlaid (${Object.keys(overlay).length} base keys)`);

// Icons (server favicon + PWA), the empty-editor watermark and the bundled
// Fira Code face (@font-face appended to the workbench stylesheet).
await copyBrandingIntoCheckout(checkoutDir, { kind: 'web' });

console.log('[osiris-web] branding applied.');
