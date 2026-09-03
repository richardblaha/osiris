#!/usr/bin/env node
/**
 * Wrap a branded linux-x64 prebuilt tree into an AppImage.
 *
 *   node scripts/pack-appimage.mjs                       # .build/linux-x64 → dist_electron/
 *   node scripts/pack-appimage.mjs <sourceTree> <out>    # explicit paths
 *
 * Needs `appimagetool` on PATH or at $APPIMAGETOOL; otherwise it downloads the
 * pinned static build into `.build/_cache/`. FUSE is not required (we run it with
 * `--appimage-extract-and-run`).
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { appRoot, readUpstreamConfig, stageDir } from './lib.mjs';
import { appRunScript } from './pack-linux.mjs';
import { buildWrapperRoot } from './pack-tree.mjs';

const APPIMAGETOOL_VERSION = '1.9.0';
const APPIMAGETOOL_URL =
  `https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-x86_64.AppImage`;

export async function packAppImage(sourceTree, out) {
  const appDir = `${out}.AppDir`;
  await rm(appDir, { recursive: true, force: true });
  await buildWrapperRoot(sourceTree, appDir);

  await writeFile(path.join(appDir, 'AppRun'), appRunScript());
  await chmod(path.join(appDir, 'AppRun'), 0o755);

  const tool = await resolveAppimagetool();
  await mkdir(path.dirname(out), { recursive: true });
  await rm(out, { recursive: true, force: true });
  execFileSync(tool, [appDir, out], {
    stdio: 'inherit',
    env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
  });
  await rm(appDir, { recursive: true, force: true });
  console.log(`[osiris-desktop] ${path.relative(appRoot, out)}`);
  return out;
}

async function resolveAppimagetool() {
  if (process.env.APPIMAGETOOL && existsSync(process.env.APPIMAGETOOL)) return process.env.APPIMAGETOOL;
  try {
    execFileSync('appimagetool', ['--version'], { stdio: 'ignore' });
    return 'appimagetool';
  } catch {
    /* fall through to download */
  }
  const cached = path.join(appRoot, '.build', '_cache', `appimagetool-${APPIMAGETOOL_VERSION}.AppImage`);
  if (!existsSync(cached)) {
    await mkdir(path.dirname(cached), { recursive: true });
    console.log(`[osiris-desktop] downloading appimagetool ${APPIMAGETOOL_VERSION}`);
    const res = await fetch(APPIMAGETOOL_URL);
    if (!res.ok) throw new Error(`GET ${APPIMAGETOOL_URL} → ${res.status}`);
    await writeFile(cached, Buffer.from(await res.arrayBuffer()));
  }
  await chmod(cached, 0o755);
  return cached;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tree, out] = process.argv.slice(2);
  const { release } = await readUpstreamConfig();
  await packAppImage(
    tree ?? stageDir('linux-x64'),
    out ?? path.join(appRoot, 'dist_electron', `Osiris-linux-x64-${release}.AppImage`),
  );
}
