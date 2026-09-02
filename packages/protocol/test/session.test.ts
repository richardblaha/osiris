import { describe, expect, it } from 'vitest';
import {
  CreateSessionRequest,
  HandoverCommitRequest,
  SessionDescriptor,
  SessionEvent,
} from '../src/index.js';

const digest = `sha256:${'a'.repeat(64)}`;

describe('SessionDescriptor', () => {
  it('accepts a well-formed local descriptor', () => {
    const parsed = SessionDescriptor.parse({
      sessionId: 's1',
      schemaVersion: 1,
      location: 'local',
      origin: 'desktop',
      workspaceId: 'ws1',
      devcontainerHash: 'abc123',
      lease: null,
    });
    expect(parsed.location).toBe('local');
    expect(parsed.lease).toBeNull();
  });

  it('rejects an unknown location', () => {
    expect(() =>
      SessionDescriptor.parse({
        sessionId: 's1',
        schemaVersion: 1,
        location: 'moon',
        origin: 'desktop',
        workspaceId: 'ws1',
        devcontainerHash: 'abc123',
        lease: null,
      }),
    ).toThrow();
  });
});

describe('CreateSessionRequest', () => {
  it('defaults origin to desktop', () => {
    const parsed = CreateSessionRequest.parse({ workspaceId: 'ws1', devcontainerHash: 'abc' });
    expect(parsed.origin).toBe('desktop');
  });
});

describe('HandoverCommitRequest', () => {
  it('requires sha256-prefixed digests', () => {
    expect(() =>
      HandoverCommitRequest.parse({
        imageRef: 'r/x:1',
        imageDigest: 'not-a-digest',
        volumeDigest: digest,
        agentStateDigest: digest,
        sha256: 'deadbeef',
      }),
    ).toThrow();
  });

  it('accepts valid digests', () => {
    const parsed = HandoverCommitRequest.parse({
      imageRef: 'registry.osiris.internal/workspaces/ws1:s1',
      imageDigest: digest,
      volumeDigest: digest,
      agentStateDigest: digest,
      sha256: 'deadbeef',
    });
    expect(parsed.imageDigest).toBe(digest);
  });
});

describe('SessionEvent', () => {
  it('discriminates on type', () => {
    const parsed = SessionEvent.parse({ type: 'lease.expired', sessionId: 's1' });
    expect(parsed.type).toBe('lease.expired');
  });
});
