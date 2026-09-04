import { describe, expect, it } from 'vitest';
import { CreateSessionRequest, SessionDescriptor, SessionEvent } from '../src/index.js';

describe('SessionDescriptor', () => {
  it('accepts a well-formed descriptor', () => {
    const parsed = SessionDescriptor.parse({
      sessionId: 's1',
      schemaVersion: 2,
      projectName: 'demo',
      phase: 'Running',
      idleTimeoutSeconds: 300,
      lastActivityAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed.phase).toBe('Running');
  });

  it('rejects an unknown phase', () => {
    expect(() =>
      SessionDescriptor.parse({
        sessionId: 's1',
        schemaVersion: 2,
        projectName: 'demo',
        phase: 'Sleeping',
        idleTimeoutSeconds: 300,
        lastActivityAt: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });
});

describe('CreateSessionRequest', () => {
  it('requires only a project name', () => {
    const parsed = CreateSessionRequest.parse({ projectName: 'demo' });
    expect(parsed.projectName).toBe('demo');
    expect(parsed.idleTimeoutSeconds).toBeUndefined();
  });

  it('accepts an idle timeout override', () => {
    const parsed = CreateSessionRequest.parse({ projectName: 'demo', idleTimeoutSeconds: 60 });
    expect(parsed.idleTimeoutSeconds).toBe(60);
  });
});

describe('SessionEvent', () => {
  it('discriminates on type', () => {
    const parsed = SessionEvent.parse({
      type: 'session.phase-changed',
      sessionId: 's1',
      phase: 'Suspended',
    });
    expect(parsed.type).toBe('session.phase-changed');
  });

  it('accepts session.terminated', () => {
    const parsed = SessionEvent.parse({ type: 'session.terminated', sessionId: 's1' });
    expect(parsed.type).toBe('session.terminated');
  });
});
