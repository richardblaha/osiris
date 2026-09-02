import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDesktopConfig } from './osiris-main.mjs';

test('resolveDesktopConfig: defaults', () => {
  const cfg = resolveDesktopConfig({});
  assert.equal(cfg.dashboard, 'aspire');
  assert.equal(cfg.serverPort, 8000);
  assert.equal(cfg.server.registryHost, 'registry.osiris.internal');
  assert.equal(cfg.server.baseUrl, '');
});

test('resolveDesktopConfig: reads the environment', () => {
  const cfg = resolveDesktopConfig({
    OSIRIS_DASHBOARD: 'jaeger',
    OSIRIS_DEVCONTAINER_PORT: '9001',
    OSIRIS_SERVER_URL: 'https://osiris.example.com/',
    OSIRIS_SERVER_TOKEN: 'secret',
    OSIRIS_REGISTRY: 'reg.internal',
  });
  assert.equal(cfg.dashboard, 'jaeger');
  assert.equal(cfg.serverPort, 9001);
  assert.equal(cfg.server.baseUrl, 'https://osiris.example.com');
  assert.equal(cfg.server.token, 'secret');
  assert.equal(cfg.server.registryHost, 'reg.internal');
});

test('resolveDesktopConfig: bad port falls back to 8000', () => {
  assert.equal(resolveDesktopConfig({ OSIRIS_DEVCONTAINER_PORT: 'nope' }).serverPort, 8000);
});
