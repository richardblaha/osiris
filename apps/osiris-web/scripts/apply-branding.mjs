#!/usr/bin/env node
/** Merge the Osiris product.json overlay into the OpenVSCode Server checkout. */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mergeDeep, readProductOverlay, readUpstreamConfig, repoRoot } from './lib.mjs';

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

const svg = path.join(repoRoot, 'packages', 'branding', 'assets', 'osiris.svg');
const mediaDir = path.join(checkoutDir, 'src', 'vs', 'server', 'browser', 'media');
if (existsSync(svg)) {
  await mkdir(mediaDir, { recursive: true });
  await copyFile(svg, path.join(mediaDir, 'osiris.svg')).catch(() => {
    console.warn('[osiris-web] could not place branding svg (upstream layout changed); continuing');
  });
}

console.log('[osiris-web] branding applied.');
