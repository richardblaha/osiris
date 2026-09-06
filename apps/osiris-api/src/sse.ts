import type { SessionEvent } from '@richardblaha/osiris-protocol';

/** Serialize a protocol event as a Server-Sent Event frame. */
export function formatSseEvent(event: SessionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
