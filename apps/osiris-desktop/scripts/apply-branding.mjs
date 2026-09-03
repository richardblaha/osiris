#!/usr/bin/env node
/**
 * Rebrand the staged VSCodium prebuilt(s) in place:
 *   1. overlay the Osiris identity onto `product.json`,
 *   2. swap the window / app icons,
 *   3. rename the `codium` executable + shims to `osiris`,
 *   4. patch the macOS `Info.plist` display name + bundle name.
 *
 * Operates on whatever `scripts/fetch-prebuilt.mjs` unpacked under `.build/<key>/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generatedDir, renderIcons } from '@osiris/branding/render-icons';
import { findAppLayout, listStaged, mergeDeep, readProductOverlay, stageDir } from './lib.mjs';
import {
  binaryRenames,
  brandProductJson,
  launcherScripts,
  patchLauncherScript,
} from './rebrand.mjs';

const stagedKeys = await listStaged();
if (stagedKeys.length === 0) {
  throw new Error('Nothing staged. Run: pnpm --filter @osiris/desktop run prepare:shell');
}

if (!existsSync(path.join(generatedDir, 'linux', 'code.png'))) await renderIcons();
const overlay = await readProductOverlay();

for (const key of stagedKeys) {
  const stage = stageDir(key);
  const layout = await findAppLayout(stage);
  console.log(`[osiris-desktop] ${key}: branding ${path.relative(stage, layout.productJson)}`);

  const upstream = JSON.parse(await readFile(layout.productJson, 'utf8'));
  const branded = brandProductJson(upstream, overlay, mergeDeep);
  await writeFile(layout.productJson, `${JSON.stringify(branded, null, '\t')}\n`);

  await swapIcons(key, layout);

  for (const [from, to] of binaryRenames(key)) {
    const src = path.join(layout.appDir, from);
    if (existsSync(src)) {
      await rename(src, path.join(layout.appDir, to));
      console.log(`[osiris-desktop] ${key}: ${from} → ${to}`);
    }
  }

  for (const rel of launcherScripts(key)) {
    const file = path.join(layout.appDir, rel);
    if (existsSync(file)) {
      await writeFile(file, patchLauncherScript(await readFile(file, 'utf8')));
      console.log(`[osiris-desktop] ${key}: patched ${rel}`);
    }
  }

  if (layout.kind === 'darwin') await brandMacBundle(stage, layout);
  console.log(`[osiris-desktop] ${key}: branded`);
}

async function swapIcons(key, layout) {
  const g = (...p) => path.join(generatedDir, ...p);
  const A = (...p) => path.join(layout.appDir, ...p);
  const targets = key.startsWith('darwin')
    ? [
        [g('darwin', 'code.icns'), A('Contents', 'Resources', 'code.icns')],
        [g('darwin', 'code.icns'), A('Contents', 'Resources', 'Code.icns')],
      ]
    : [[g('linux', 'code.png'), A('resources', 'app', 'resources', 'linux', 'code.png')]];
  for (const [from, to] of targets) {
    if (existsSync(from) && existsSync(path.dirname(to))) {
      await copyFile(from, to);
      console.log(`[osiris-desktop] ${key}: icon → ${path.relative(layout.appDir, to)}`);
    }
  }
}

async function brandMacBundle(stage, layout) {
  const plist = path.join(layout.appDir, 'Contents', 'Info.plist');
  if (existsSync(plist)) {
    const xml = (await readFile(plist, 'utf8'))
      .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*/, '$1Osiris IDE')
      .replace(/(<key>CFBundleName<\/key>\s*<string>)[^<]*/, '$1Osiris');
    await writeFile(plist, xml);
    console.log('[osiris-desktop] darwin: Info.plist → Osiris IDE');
  }
  const osiris = path.join(stage, 'Osiris.app');
  if (path.basename(layout.appDir) !== 'Osiris.app') {
    await rename(layout.appDir, osiris);
    console.log('[osiris-desktop] darwin: VSCodium.app → Osiris.app');
  }
  try {
    execFileSync('xattr', ['-cr', osiris], { stdio: 'ignore' });
  } catch {
    /* only runs on a macOS host; the packaging step re-clears there */
  }
}
