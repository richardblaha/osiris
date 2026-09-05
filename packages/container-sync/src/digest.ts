import { createHash, type Hash } from 'node:crypto';
import { PassThrough } from 'node:stream';

/** `sha256:<hex>` of a buffer or string — the `ContentDigest` shape from `@richardblaha/protocol`. */
export function sha256Digest(data: Buffer | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

export interface DigestingStream {
  /** Pipe bytes through this; it forwards them unchanged. */
  readonly stream: PassThrough;
  /** Total bytes seen so far. */
  bytesSeen(): number;
  /** `sha256:<hex>` of everything that has passed through. Call after the stream ends. */
  digest(): string;
}

/**
 * A pass-through that hashes and counts bytes in flight — wrap a volume tar with
 * it to get its `volumeDigest` and a progress count without buffering.
 */
export function createDigestingStream(): DigestingStream {
  const hash: Hash = createHash('sha256');
  let bytes = 0;
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  return {
    stream,
    bytesSeen: () => bytes,
    digest: () => `sha256:${hash.digest('hex')}`,
  };
}
