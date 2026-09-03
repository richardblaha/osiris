import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_PREFIX, appRunScript, desktopEntry, snapMeta } from './pack-linux.mjs';

test('desktopEntry is a valid single-Exec entry pointing at the given command', () => {
  const entry = desktopEntry({ exec: 'osiris' });
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec=osiris %F$/m);
  assert.match(entry, /^Icon=osiris$/m);
  assert.match(entry, /^StartupWMClass=Osiris$/m);
  assert.match(entry, /x-scheme-handler\/osiris/);
});

test('desktopEntry defaults the Exec command to osiris', () => {
  assert.match(desktopEntry(), /^Exec=osiris %F$/m);
});

test('appRunScript execs the binary under the shared prefix', () => {
  const run = appRunScript();
  assert.ok(run.startsWith('#!/bin/sh\n'));
  assert.match(run, new RegExp(`\\$APP/osiris`));
  assert.match(run, new RegExp(APP_PREFIX.replace(/\//g, '\\/')));
});

test('appRunScript falls back to --no-sandbox when userns is locked down', () => {
  const run = appRunScript();
  assert.match(run, /unprivileged_userns_clone/);
  assert.match(run, /apparmor_restrict_unprivileged_userns/);
  assert.match(run, /--no-sandbox/);
  // OSIRIS_SANDBOX=1 must be able to force it back on
  assert.match(run, /OSIRIS_SANDBOX/);
});

test('snapMeta is classic-confinement and versioned from the release string', () => {
  const meta = snapMeta('1.94.2.24286');
  assert.match(meta, /^name: osiris$/m);
  assert.match(meta, /^version: '1\.94\.2\.24286'$/m);
  assert.match(meta, /^confinement: classic$/m);
  assert.match(meta, /^grade: stable$/m);
  assert.match(meta, new RegExp(`command: ${APP_PREFIX}/bin/osiris`));
});

test('snapMeta honours a devel grade', () => {
  assert.match(snapMeta('1.0.0', 'devel'), /^grade: devel$/m);
});
