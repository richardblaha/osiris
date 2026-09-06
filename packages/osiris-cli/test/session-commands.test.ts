import { describe, expect, it, vi } from 'vitest';
import type { SessionClient } from '@richardblaha/osiris-protocol';
import { sessionResume, sessionRm, sessionSuspend } from '../src/session-commands.js';
import type { CliIo } from '../src/run.js';

function fakeIo(): CliIo & { lines: string[] } {
  const lines: string[] = [];
  return { cwd: '/tmp', out: (t) => lines.push(t), err: (t) => lines.push(t), lines };
}

const descriptor = {
  sessionId: 's1',
  schemaVersion: 2 as const,
  projectName: 'demo',
  phase: 'Running' as const,
  idleTimeoutSeconds: 300,
  lastActivityAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('session commands', () => {
  it('resumes a session and reports its phase', async () => {
    const io = fakeIo();
    const client = { resumeSession: vi.fn(async () => descriptor) } as unknown as SessionClient;
    const code = await sessionResume(client, 's1', io);
    expect(code).toBe(0);
    expect(client.resumeSession).toHaveBeenCalledWith('s1');
    expect(io.lines.join('')).toContain('s1: Running');
  });

  it('suspends a session and reports its phase', async () => {
    const io = fakeIo();
    const client = {
      suspendSession: vi.fn(async () => ({ ...descriptor, phase: 'Suspended' as const })),
    } as unknown as SessionClient;
    const code = await sessionSuspend(client, 's1', io);
    expect(code).toBe(0);
    expect(io.lines.join('')).toContain('s1: Suspended');
  });

  it('deletes a session', async () => {
    const io = fakeIo();
    const client = { deleteSession: vi.fn(async () => undefined) } as unknown as SessionClient;
    const code = await sessionRm(client, 's1', io);
    expect(code).toBe(0);
    expect(client.deleteSession).toHaveBeenCalledWith('s1');
    expect(io.lines.join('')).toContain('s1: deleted');
  });
});
