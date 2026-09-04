import { describe, expect, it } from 'vitest';
import { formatSseEvent } from '../src/sse.js';

describe('formatSseEvent', () => {
  it('renders a phase-change event frame', () => {
    const frame = formatSseEvent({ type: 'session.phase-changed', sessionId: 's1', phase: 'Suspended' });
    expect(frame).toBe(
      'event: session.phase-changed\ndata: {"type":"session.phase-changed","sessionId":"s1","phase":"Suspended"}\n\n',
    );
  });

  it('renders a terminated event frame', () => {
    const frame = formatSseEvent({ type: 'session.terminated', sessionId: 's1' });
    expect(frame).toBe('event: session.terminated\ndata: {"type":"session.terminated","sessionId":"s1"}\n\n');
  });
});
