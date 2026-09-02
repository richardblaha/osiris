/**
 * The two-phase transfer protocol.
 *
 *   Handover to Server:  prepare → (freeze + push + volume upload) → commit
 *   Fetch to Local:      prepare → (freeze + push + volume download) → commit
 *
 * `:prepare` acquires the exclusive lease and returns everything the caller needs
 * to move bytes. `:commit` is idempotent (`Idempotency-Key` header) and performs
 * the actual location switch once the server has verified every digest.
 */
import { z } from 'zod';
import { ContentDigest, TransferDirection } from './session.js';

export const TransferPhase = z.enum([
  'snapshot',
  'freeze',
  'commit',
  'push',
  'volume',
  'restore',
  'boot',
  'done',
]);
export type TransferPhase = z.infer<typeof TransferPhase>;

export const RegistryCredentials = z.object({
  url: z.string().min(1),
  repository: z.string().min(1),
  token: z.string().min(1),
});
export type RegistryCredentials = z.infer<typeof RegistryCredentials>;

export const HandoverPrepareResponse = z.object({
  leaseEtag: z.string().min(1),
  registry: RegistryCredentials,
  /** Resumable upload target for the workspace-volume tar (`Content-Range`). */
  volumeUploadUrl: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type HandoverPrepareResponse = z.infer<typeof HandoverPrepareResponse>;

export const HandoverCommitRequest = z.object({
  imageRef: z.string().min(1),
  imageDigest: ContentDigest,
  volumeDigest: ContentDigest,
  agentStateDigest: ContentDigest,
  /** sha256 of the uploaded volume tar as the client streamed it. */
  sha256: z.string().min(1),
});
export type HandoverCommitRequest = z.infer<typeof HandoverCommitRequest>;

export const HandoverCommitResponse = z.object({
  webUrl: z.string().min(1),
  location: z.literal('server'),
});
export type HandoverCommitResponse = z.infer<typeof HandoverCommitResponse>;

export const FetchPrepareResponse = z.object({
  leaseEtag: z.string().min(1),
  imageRef: z.string().min(1),
  imageDigest: ContentDigest,
  volumeDownloadUrl: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type FetchPrepareResponse = z.infer<typeof FetchPrepareResponse>;

export const FetchCommitRequest = z.object({
  volumeDigest: ContentDigest,
  agentStateDigest: ContentDigest,
});
export type FetchCommitRequest = z.infer<typeof FetchCommitRequest>;

export const TransferProgress = z.object({
  direction: TransferDirection,
  phase: TransferPhase,
  bytesTransferred: z.number().nonnegative(),
  bytesTotal: z.number().nonnegative().optional(),
});
export type TransferProgress = z.infer<typeof TransferProgress>;

export const AbortRequest = z.object({
  reason: z.string().optional(),
});
export type AbortRequest = z.infer<typeof AbortRequest>;
