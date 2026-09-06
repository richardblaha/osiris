import { describe, expect, it, vi } from 'vitest';
import { EventBus, type OsirisEvents } from '../src/events.js';

describe('EventBus', () => {
  it('delivers typed payloads to listeners', () => {
    const bus = new EventBus<OsirisEvents>();
    const seen: string[] = [];
    bus.on('osiris:agent:token', ({ text }) => seen.push(text));
    bus.emit('osiris:agent:token', { runId: 'r1', text: 'hello' });
    bus.emit('osiris:agent:token', { runId: 'r1', text: 'world' });
    expect(seen).toEqual(['hello', 'world']);
  });

  it('unsubscribe stops further delivery', () => {
    const bus = new EventBus<OsirisEvents>();
    const fn = vi.fn();
    const off = bus.on('osiris:agent:token', fn);
    bus.emit('osiris:agent:token', { runId: 'r', text: 'a' });
    off();
    bus.emit('osiris:agent:token', { runId: 'r', text: 'b' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('once fires a single time', () => {
    const bus = new EventBus<OsirisEvents>();
    const fn = vi.fn();
    bus.once('osiris:agent:run-started', fn);
    bus.emit('osiris:agent:run-started', { runId: 'r', prompt: 'p' });
    bus.emit('osiris:agent:run-started', { runId: 'r', prompt: 'p' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('next() resolves on the next emission', async () => {
    const bus = new EventBus<OsirisEvents>();
    queueMicrotask(() => bus.emit('osiris:agent:token', { runId: 'r', text: 'hi' }));
    await expect(bus.next('osiris:agent:token')).resolves.toMatchObject({ text: 'hi' });
  });
});
