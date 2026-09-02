import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { devcontainerHash } from '../src/hash.js';
import { createDigestingStream, sha256Digest } from '../src/digest.js';
import { parseDevContainerUp } from '../src/devcontainer.js';

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
