import type { SessionClient } from '@richardblaha/osiris-protocol';
import type { CliIo } from './run.js';

/**
 * `osiris session resume <id>` — resumes a suspended session (or, if it was
 * only idle-suspended by the operator, this is equivalent to just bumping
 * activity — see `operator/internal/controller/osirissession_controller.go`).
 */
export async function sessionResume(client: SessionClient, id: string, io: CliIo): Promise<number> {
  const descriptor = await client.resumeSession(id);
  io.out(`session ${descriptor.sessionId}: ${descriptor.phase}\n`);
  return 0;
}

/**
 * `osiris session suspend <id>` — not the primary path (idle timeout drives
 * suspend automatically) but useful to force it deterministically, e.g. in
 * tests, without waiting out the real timeout.
 */
export async function sessionSuspend(client: SessionClient, id: string, io: CliIo): Promise<number> {
  const descriptor = await client.suspendSession(id);
  io.out(`session ${descriptor.sessionId}: ${descriptor.phase}\n`);
  return 0;
}

/** `osiris session rm <id>` — deletes the session's container and workspace PVC. */
export async function sessionRm(client: SessionClient, id: string, io: CliIo): Promise<number> {
  await client.deleteSession(id);
  io.out(`session ${id}: deleted\n`);
  return 0;
}
