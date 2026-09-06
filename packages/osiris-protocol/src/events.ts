/** Server-sent events on `GET /api/v1/sessions/:id/events`. */
import { z } from 'zod';
import { SessionPhase } from './session.js';

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.phase-changed'),
    sessionId: z.string().min(1),
    phase: SessionPhase,
  }),
  z.object({ type: z.literal('session.terminated'), sessionId: z.string().min(1) }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

export type SessionEventType = SessionEvent['type'];
