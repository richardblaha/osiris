/**
 * A small strongly-typed event bus built on Node's `EventEmitter`.
 *
 * `TMap` maps a channel name to its payload type:
 *
 * ```ts
 * const bus = new EventBus<OsirisEvents>();
 * bus.on('osiris:agent:token', ({ text }) => process.stdout.write(text));
 * bus.emit('osiris:agent:token', { runId: '1', text: 'hi' });
 * ```
 */
import { EventEmitter } from 'node:events';

export type EventMap = Record<string, unknown>;

export type Unsubscribe = () => void;

export class EventBus<TMap extends EventMap> {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Extensions may attach many listeners across features; lift the warning cap.
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof TMap & string>(channel: K, listener: (payload: TMap[K]) => void): Unsubscribe {
    this.emitter.on(channel, listener as (...args: unknown[]) => void);
    return () => this.off(channel, listener);
  }

  once<K extends keyof TMap & string>(
    channel: K,
    listener: (payload: TMap[K]) => void,
  ): Unsubscribe {
    this.emitter.once(channel, listener as (...args: unknown[]) => void);
    return () => this.off(channel, listener);
  }

  off<K extends keyof TMap & string>(channel: K, listener: (payload: TMap[K]) => void): void {
    this.emitter.off(channel, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof TMap & string>(channel: K, payload: TMap[K]): void {
    this.emitter.emit(channel, payload);
  }

  /** Resolve on the next emission of `channel`. */
  next<K extends keyof TMap & string>(channel: K): Promise<TMap[K]> {
    return new Promise((resolve) => {
      this.once(channel, resolve);
    });
  }

  listenerCount<K extends keyof TMap & string>(channel: K): number {
    return this.emitter.listenerCount(channel);
  }

  removeAll(channel?: keyof TMap & string): void {
    this.emitter.removeAllListeners(channel);
  }
}

/**
 * The canonical Osiris cross-component event channels. Extensions and apps
 * should widen this via declaration merging rather than inventing new maps.
 */
export interface OsirisEvents extends EventMap {
  'osiris:agent:run-started': { runId: string; prompt: string };
  'osiris:agent:token': { runId: string; text: string };
  'osiris:agent:tool-call': { runId: string; tool: string; input: unknown };
  'osiris:agent:run-finished': { runId: string; ok: boolean; error?: string };
  'osiris:dexpi:parsed': { uri: string; equipmentCount: number; segmentCount: number };
  'osiris:dexpi:validated': { uri: string; errors: number; warnings: number };
  'osiris:step:parsed': { uri: string; entityCount: number; schema: string[] };
  'osiris:step:preview-ready': { uri: string; vertices: number; lineSegments: number };
}
