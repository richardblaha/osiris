/**
 * Session identity and lifecycle. A session runs inside a `kind` cluster as an
 * `OsirisSession` custom resource, reconciled by `osiris-kind-operator`: the
 * client (osiris-api) only ever expresses `desiredPhase` (Running/Suspended)
 * and reads back the controller-observed `phase` — there is no client-managed
 * transfer lease any more (see `osiris-spec.md` §3.3/3.4).
 */
import { z } from 'zod';

export const SESSION_SCHEMA_VERSION = 2 as const;

/** `sha256:<64 hex>` — content address, still used outside the session model (agent-core, container-sync). */
export const ContentDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:" followed by 64 hex chars');
export type ContentDigest = z.infer<typeof ContentDigest>;

/** Mirrors the operator's `OsirisSession.status.phase`. */
export const SessionPhase = z.enum([
  'Pending',
  'Running',
  'Suspending',
  'Suspended',
  'Resuming',
  'Terminating',
]);
export type SessionPhase = z.infer<typeof SessionPhase>;

export const SessionDescriptor = z.object({
  sessionId: z.string().min(1),
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  /** Name of the OsirisProject this session belongs to. */
  projectName: z.string().min(1),
  phase: SessionPhase,
  idleTimeoutSeconds: z.number().int().positive(),
  /** ISO-8601, mirrors the activity Lease's renewTime. */
  lastActivityAt: z.string().min(1),
  createdAt: z.string().min(1),
  /** Present once the session's devcontainer is reachable. */
  webUrl: z.string().optional(),
});
export type SessionDescriptor = z.infer<typeof SessionDescriptor>;

export const CreateSessionRequest = z.object({
  projectName: z.string().min(1),
  idleTimeoutSeconds: z.number().int().positive().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
