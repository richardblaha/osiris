/**
 * Session identity and lifecycle. A session lives in exactly one `location` at a
 * time; every mutating request carries the current lease etag (`If-Match`) so the
 * Desktop and the Server can never run the same container concurrently.
 */
import { z } from 'zod';

export const SESSION_SCHEMA_VERSION = 1 as const;

/** `sha256:<64 hex>` — content address of an image / volume tar / agent snapshot. */
export const ContentDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected "sha256:" followed by 64 hex chars');
export type ContentDigest = z.infer<typeof ContentDigest>;

export const SessionLocation = z.enum(['local', 'in-transit', 'server']);
export type SessionLocation = z.infer<typeof SessionLocation>;

export const SessionOrigin = z.enum(['desktop', 'server']);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

export const TransferDirection = z.enum(['to-server', 'to-local']);
export type TransferDirection = z.infer<typeof TransferDirection>;

export const Lease = z.object({
  /** Opaque token; changes on every state transition. */
  etag: z.string().min(1),
  /** Who currently holds the transfer lock. */
  holder: z.string().min(1),
  /** ISO-8601. After this instant the server auto-aborts an incomplete transfer. */
  expiresAt: z.string().min(1),
});
export type Lease = z.infer<typeof Lease>;

export const SessionDigests = z
  .object({
    image: ContentDigest,
    volume: ContentDigest,
    agentState: ContentDigest,
  })
  .partial();
export type SessionDigests = z.infer<typeof SessionDigests>;

export const SessionDescriptor = z.object({
  sessionId: z.string().min(1),
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  location: SessionLocation,
  origin: SessionOrigin,
  workspaceId: z.string().min(1),
  devcontainerHash: z.string().min(1),
  /** Null unless a transfer is in flight. */
  lease: Lease.nullable(),
  /** Present while `location === 'server'`. */
  webUrl: z.string().optional(),
  transfer: z
    .object({
      direction: TransferDirection,
      startedAt: z.string().min(1),
    })
    .optional(),
  digests: SessionDigests.optional(),
});
export type SessionDescriptor = z.infer<typeof SessionDescriptor>;

export const CreateSessionRequest = z.object({
  workspaceId: z.string().min(1),
  devcontainerHash: z.string().min(1),
  origin: SessionOrigin.default('desktop'),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;
