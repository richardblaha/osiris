/** Server-sent events on `GET /api/v1/sessions/:id/events`. */
import { z } from 'zod';
import { SessionDescriptor } from './session.js';
import { TransferProgress } from './handover.js';

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.frozen'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('transfer.progress'),
    sessionId: z.string().min(1),
    progress: TransferProgress,
  }),
  z.object({
    type: z.literal('session.resumed'),
    sessionId: z.string().min(1),
    descriptor: SessionDescriptor,
  }),
  z.object({ type: z.literal('lease.expired'), sessionId: z.string().min(1) }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

export type SessionEventType = SessionEvent['type'];
