#!/usr/bin/env node
/** Shallow-clone the pinned OpenVSCode Server tag into `.build/server`. Idempotent. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { appRoot, readUpstreamConfig } from './lib.mjs';

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' });

const { repository, tag, checkoutDir } = await readUpstreamConfig();
mkdirSync(path.dirname(checkoutDir), { recursive: true });

if (!existsSync(path.join(checkoutDir, '.git'))) {
  console.log(`[osiris-web] cloning ${repository} @ ${tag}`);
  git(['clone', '--depth', '1', '--branch', tag, repository, checkoutDir], appRoot);
} else {
  console.log(`[osiris-web] updating checkout to ${tag}`);
  git(['fetch', '--depth', '1', 'origin', 'tag', tag], checkoutDir);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--force', tag], checkoutDir);
  git(['reset', '--hard', tag], checkoutDir);
}

console.log(`[osiris-web] upstream ready at ${path.relative(appRoot, checkoutDir)}`);
