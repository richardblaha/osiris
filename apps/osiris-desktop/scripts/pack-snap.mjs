#!/usr/bin/env node
/**
 * Wrap a branded linux-x64 prebuilt tree into an installable snap.
 *
 *   node scripts/pack-snap.mjs                       # .build/linux-x64 → dist_electron/
 *   node scripts/pack-snap.mjs <sourceTree> <out>    # explicit paths
 *
 * A snap is just a squashfs with a `meta/snap.yaml`, so we build it with
 * `mksquashfs` (from `squashfs-tools`) — no snapcraft / LXD toolchain. It is a
 * classic-confinement snap: install with `snap install --dangerous --classic`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, readUpstreamConfig, stageDir } from './lib.mjs';
import { desktopEntry, snapMeta } from './pack-linux.mjs';
import { buildWrapperRoot } from './pack-tree.mjs';

export async function packSnap(sourceTree, out, { grade = 'stable' } = {}) {
  const { release } = await readUpstreamConfig();
  const prime = `${out}.prime`;
  await rm(prime, { recursive: true, force: true });
  const { icon } = await buildWrapperRoot(sourceTree, prime);

  const gui = path.join(prime, 'meta', 'gui');
  await mkdir(gui, { recursive: true });
  await writeFile(path.join(prime, 'meta', 'snap.yaml'), snapMeta(release, grade));
  await writeFile(path.join(gui, 'osiris.desktop'), desktopEntry());
  await writeFile(path.join(gui, 'icon.png'), await readFile(icon));

  await mkdir(path.dirname(out), { recursive: true });
  await rm(out, { recursive: true, force: true });
  execFileSync(
    'mksquashfs',
    [prime, out, '-noappend', '-no-progress', '-no-xattrs', '-all-root', '-comp', 'xz'],
    { stdio: 'inherit' },
  );
  await rm(prime, { recursive: true, force: true });
  console.log(`[osiris-desktop] ${path.relative(appRoot, out)}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tree, out] = process.argv.slice(2);
  const { release } = await readUpstreamConfig();
  await packSnap(
    tree ?? stageDir('linux-x64'),
    out ?? path.join(appRoot, 'dist_electron', `Osiris-linux-x64-${release}.snap`),
  );
}
