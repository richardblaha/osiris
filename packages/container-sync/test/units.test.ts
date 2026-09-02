import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devcontainerHash } from '../src/hash.js';
import { createDigestingStream, sha256Digest } from '../src/digest.js';
import { parseDevContainerUp } from '../src/devcontainer.js';
import {
  DEFAULT_WEB_IDE_FEATURE,
  ensureDevcontainerConfig,
  renderOsirisDevcontainer,
} from '../src/devcontainer-template.js';

describe('devcontainerHash', () => {
  it('is stable and 12 hex chars', () => {
    const a = devcontainerHash('/home/me/project');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(devcontainerHash('/home/me/project')).toBe(a);
  });

  it('normalizes the path before hashing', () => {
    expect(devcontainerHash('/home/me/project')).toBe(devcontainerHash('/home/me/./x/../project'));
  });
});

describe('sha256Digest / createDigestingStream', () => {
  it('matches a one-shot digest and counts bytes', async () => {
    const payload = Buffer.from('osiris'.repeat(1000));
    const digesting = createDigestingStream();
    await pipeline(Readable.from(payload), digesting.stream, async (source) => {
      for await (const _chunk of source) {
        // drain
      }
    });
    expect(digesting.digest()).toBe(sha256Digest(payload));
    expect(digesting.bytesSeen()).toBe(payload.length);
  });
});

describe('parseDevContainerUp', () => {
  it('reads the trailing JSON line', () => {
    const stdout = [
      '[1234 ms] Start: Run: docker ...',
      JSON.stringify({
        outcome: 'success',
        containerId: 'abc123',
        remoteWorkspaceFolder: '/workspaces/project',
      }),
    ].join('\n');
    expect(parseDevContainerUp(stdout)).toEqual({
      outcome: 'success',
      containerId: 'abc123',
      remoteWorkspaceFolder: '/workspaces/project',
    });
  });

  it('throws when no JSON result is present', () => {
    expect(() => parseDevContainerUp('just logs\nmore logs')).toThrow(/no JSON/);
  });

  it('throws when the result lacks a containerId', () => {
    expect(() => parseDevContainerUp(JSON.stringify({ outcome: 'error' }))).toThrow(/containerId/);
  });
});

describe('renderOsirisDevcontainer', () => {
  it('wires the web-ide feature + appPort to the requested port', () => {
    const json = renderOsirisDevcontainer({ serverPort: 9001 });
    expect(json).toContain(`"${DEFAULT_WEB_IDE_FEATURE}": { "port": 9001 }`);
    expect(json).toContain('"appPort": ["127.0.0.1:9001:9001"]');
    expect(json).toContain('"postStartCommand": "osiris-web-ide start || true"');
  });

  it('accepts a custom feature ref', () => {
    expect(renderOsirisDevcontainer({ webIdeFeatureRef: './features/web-ide' })).toContain(
      '"./features/web-ide": { "port": 8000 }',
    );
  });
});

describe('ensureDevcontainerConfig', () => {
  it('writes the fallback template when the project has none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osiris-dc-'));
    const result = await ensureDevcontainerConfig(dir, { serverPort: 8123 });

    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, '.devcontainer', 'devcontainer.json'));
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('"name": "Osiris Workspace"');
    expect(written).toContain('${localEnv:SSH_AUTH_SOCK}');
    expect(written).toContain('host.docker.internal:4318');
    expect(written).toContain('127.0.0.1:8123:8123');
  });

  it('leaves an existing .devcontainer/devcontainer.json untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osiris-dc-'));
    mkdirSync(join(dir, '.devcontainer'));
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{ "image": "mine" }');

    const result = await ensureDevcontainerConfig(dir);
    expect(result.created).toBe(false);
    expect(readFileSync(result.path, 'utf8')).toBe('{ "image": "mine" }');
  });

  it('recognises a root .devcontainer.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osiris-dc-'));
    writeFileSync(join(dir, '.devcontainer.json'), '{ "image": "root" }');

    const result = await ensureDevcontainerConfig(dir);
    expect(result.created).toBe(false);
    expect(result.path).toBe(join(dir, '.devcontainer.json'));
  });
});
