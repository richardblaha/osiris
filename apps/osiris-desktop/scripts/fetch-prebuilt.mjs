#!/usr/bin/env node
/**
 * Download + verify + unpack the VSCodium prebuilt(s) into `.build/<platform>/`.
 *
 *   node scripts/fetch-prebuilt.mjs                # this host's platform
 *   node scripts/fetch-prebuilt.mjs --all          # every platform in the matrix
 *   node scripts/fetch-prebuilt.mjs linux-x64 …    # named platforms
 *
 * Idempotent: an already-populated stage dir is left alone unless `--force`.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { appRoot, hostPlatformKey, PLATFORM_KEYS, readUpstreamConfig, stageDir } from './lib.mjs';

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const named = argv.filter((a) => !a.startsWith('--'));
const targets = argv.includes('--all')
  ? PLATFORM_KEYS
  : named.length
    ? named
    : [hostPlatformKey()].filter(Boolean);

if (targets.length === 0) {
  throw new Error(
    `Unsupported host (${process.platform}-${process.arch}). Pass a platform: ${PLATFORM_KEYS.join(', ')}`,
  );
}

const cfg = await readUpstreamConfig();
const cacheDir = path.join(appRoot, '.build', '_cache');
await mkdir(cacheDir, { recursive: true });

for (const key of targets) {
  if (!cfg.platforms[key]) throw new Error(`Unknown platform "${key}"`);
  const stage = stageDir(key);
  if (existsSync(stage) && !force) {
    console.log(`[osiris-desktop] ${key}: already staged (use --force to refetch)`);
    continue;
  }

  const { asset, format } = cfg.platforms[key];
  const url = cfg.downloadUrl(key);
  const archive = path.join(cacheDir, asset);

  if (!existsSync(archive) || force) {
    console.log(`[osiris-desktop] ${key}: downloading ${asset}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
  }

  const want = (await fetchText(`${url}.sha256`))?.trim().split(/\s+/)[0];
  if (want) {
    const got = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    if (got !== want) throw new Error(`${asset}: sha256 mismatch\n  want ${want}\n  got  ${got}`);
    console.log(`[osiris-desktop] ${key}: sha256 ok`);
  } else {
    console.warn(`[osiris-desktop] ${key}: no .sha256 published — skipping integrity check`);
  }

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  console.log(`[osiris-desktop] ${key}: extracting`);
  if (format === 'tar.gz') {
    execFileSync('tar', ['xzf', archive, '-C', stage], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', archive, '-d', stage], { stdio: 'inherit' });
  }
  const top = await readdir(stage);
  console.log(
    `[osiris-desktop] ${key}: staged → ${path.relative(appRoot, stage)} (${top.length} entries)`,
  );
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}
