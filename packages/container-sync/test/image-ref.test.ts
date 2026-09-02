import { describe, expect, it } from 'vitest';
import { formatImageRef, parseImageRef, sessionImageRef } from '../src/image-ref.js';

describe('parseImageRef', () => {
  it('splits registry, repository and tag', () => {
    expect(parseImageRef('registry.osiris.internal/workspaces/ws1:s1')).toEqual({
      registry: 'registry.osiris.internal',
      repository: 'workspaces/ws1',
      tag: 's1',
    });
  });

  it('defaults the tag to latest', () => {
    expect(parseImageRef('registry.osiris.internal/workspaces/ws1').tag).toBe('latest');
  });

  it('treats a registry-less ref as Docker Hub', () => {
    expect(parseImageRef('ollama/ollama:0.3.12')).toEqual({
      registry: undefined,
      repository: 'ollama/ollama',
      tag: '0.3.12',
    });
  });

  it('keeps a registry port out of the tag', () => {
    expect(parseImageRef('localhost:5000/app:v2')).toEqual({
      registry: 'localhost:5000',
      repository: 'app',
      tag: 'v2',
    });
  });

  it('round-trips through formatImageRef', () => {
    const ref = 'registry.osiris.internal/workspaces/ws1:s1';
    expect(formatImageRef(parseImageRef(ref))).toBe(ref);
  });
});

describe('sessionImageRef', () => {
  it('builds the workspace image ref', () => {
    expect(sessionImageRef({ registry: 'r.osiris', workspaceId: 'ws1', sessionId: 's1' })).toBe(
      'r.osiris/workspaces/ws1:s1',
    );
  });
});
