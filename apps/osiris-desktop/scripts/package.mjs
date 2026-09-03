#!/usr/bin/env node
/**
 * Repack the branded prebuilt(s) into `dist_electron/`:
 *   - linux-x64  → Osiris-linux-x64-<release>.tar.gz
 *   - win32-x64  → Osiris-win32-x64-<release>.zip
 *   - darwin-*   → Osiris-darwin-<arch>-<release>.zip   (Osiris.app inside)
 *
 * No installers / code-signing yet — these are portable archives for the alpha.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, findAppLayout, listStaged, readUpstreamConfig, stageDir } from './lib.mjs';
import { artifactName } from './rebrand.mjs';
import { packAppImage } from './pack-appimage.mjs';
import { packSnap } from './pack-snap.mjs';

const staged = await listStaged();
if (staged.length === 0) {
  throw new Error('Nothing staged. Run: pnpm --filter @osiris/desktop run prepare:shell');
}

const { release } = await readUpstreamConfig();
const outDir = path.join(appRoot, 'dist_electron');
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const key of staged) {
  const stage = stageDir(key);
  await findAppLayout(stage); // sanity-check it was branded / has a product.json
  const base = artifactName(key, release);

  if (key.startsWith('linux')) {
    const out = path.join(outDir, `${base}.tar.gz`);
    execFileSync('tar', ['czf', out, '-C', stage, '.'], { stdio: 'inherit' });
    report(out);

    // AppImage + snap are best-effort: skip (don't fail the repack) if the
    // host lacks mksquashfs / can't fetch appimagetool. CI installs both.
    if (key === 'linux-x64') {
      await tryPack('AppImage', () => packAppImage(stage, path.join(outDir, `${base}.AppImage`)));
      await tryPack('snap', () => packSnap(stage, path.join(outDir, `${base}.snap`)));
    }
  } else {
    const out = path.join(outDir, `${base}.zip`);
    execFileSync('zip', ['-qry', out, '.'], { cwd: stage, stdio: 'inherit' });
    report(out);
  }
}

async function tryPack(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.warn(`[osiris-desktop] ${label}: skipped — ${err.message}`);
  }
}

function report(file) {
  const bytes = Number(execFileSync('stat', ['-c', '%s', file]).toString().trim());
  console.log(`[osiris-desktop] ${path.relative(appRoot, file)}  (${(bytes / 1e6).toFixed(1)} MB)`);
}
