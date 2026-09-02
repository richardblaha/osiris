import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { HandoverCommitRequest } from '@osiris/protocol';

/**
 * The infrastructure side of a handover — pull the image, restore the volume,
 * boot the container and attach a Web IDE. {@link StubHandoverExecutor} lets the
 * protocol and lease logic run without Docker; {@link DockerHandoverExecutor}
 * (see `docker-executor.ts`) wires `@osiris/container-sync`'s `thaw()`.
 */
export interface HandoverExecutor {
  provision(input: { sessionId: string; commit: HandoverCommitRequest }): Promise<{ webUrl: string }>;
  freezeForFetch(input: { sessionId: string }): Promise<{
    imageRef: string;
    imageDigest: string;
    volumeDownloadUrl: string;
  }>;
  teardown(input: { sessionId: string }): Promise<void>;
}

/** Assembles a volume tar from (possibly out-of-order) `Content-Range` chunks. */
export interface VolumeStore {
  write(sessionId: string, offset: number, chunk: Buffer): Promise<void>;
  finalize(sessionId: string): Promise<{ sha256: string; bytes: number }>;
  digest(sessionId: string): string | undefined;
  read(sessionId: string): Promise<AsyncIterable<Uint8Array>>;
  discard(sessionId: string): Promise<void>;
}

const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export class StubHandoverExecutor implements HandoverExecutor {
  constructor(private readonly publicBaseUrl: string) {}

  async provision(input: { sessionId: string }): Promise<{ webUrl: string }> {
    return { webUrl: `${this.publicBaseUrl}/ide/${input.sessionId}` };
  }

  async freezeForFetch(input: { sessionId: string }): Promise<{
    imageRef: string;
    imageDigest: string;
    volumeDownloadUrl: string;
  }> {
    return {
      imageRef: `registry.osiris.internal/workspaces/${input.sessionId}:server`,
      imageDigest: ZERO_DIGEST,
      volumeDownloadUrl: `${this.publicBaseUrl}/api/v1/sessions/${input.sessionId}/volume`,
    };
  }

  async teardown(): Promise<void> {
    // no-op for the stub
  }
}

export class InMemoryVolumeStore implements VolumeStore {
  private readonly uploads = new Map<
    string,
    { parts: Map<number, Buffer>; digest?: string; bytes?: number; assembled?: Buffer }
  >();

  async write(sessionId: string, offset: number, chunk: Buffer): Promise<void> {
    const upload = this.uploads.get(sessionId) ?? { parts: new Map() };
    upload.parts.set(offset, Buffer.from(chunk));
    this.uploads.set(sessionId, upload);
  }

  async finalize(sessionId: string): Promise<{ sha256: string; bytes: number }> {
    const upload = this.uploads.get(sessionId);
    if (!upload) throw new Error(`no volume upload for session ${sessionId}`);
    const ordered = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, buf]) => buf);
    const assembled = Buffer.concat(ordered);
    const sha256 = `sha256:${createHash('sha256').update(assembled).digest('hex')}`;
    upload.assembled = assembled;
    upload.digest = sha256;
    upload.bytes = assembled.length;
    return { sha256, bytes: assembled.length };
  }

  digest(sessionId: string): string | undefined {
    return this.uploads.get(sessionId)?.digest;
  }

  async read(sessionId: string): Promise<AsyncIterable<Uint8Array>> {
    const upload = this.uploads.get(sessionId);
    if (!upload?.assembled) throw new Error(`no assembled volume for session ${sessionId}`);
    return Readable.from(upload.assembled);
  }

  async discard(sessionId: string): Promise<void> {
    this.uploads.delete(sessionId);
  }
}

/** Disk-backed volume store — chunks are written to `<dir>/<sessionId>.tar` at their offset. */
export class FileVolumeStore implements VolumeStore {
  private readonly digests = new Map<string, string>();

  constructor(private readonly dir: string) {}

  private path(sessionId: string): string {
    return join(this.dir, `${sessionId.replace(/[^\w.-]/g, '_')}.tar`);
  }

  async write(sessionId: string, offset: number, chunk: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // O_CREAT without O_APPEND so positioned writes land at `offset`.
    const handle = await open(this.path(sessionId), constants.O_RDWR | constants.O_CREAT);
    try {
      await handle.write(chunk, 0, chunk.length, offset);
    } finally {
      await handle.close();
    }
  }

  async finalize(sessionId: string): Promise<{ sha256: string; bytes: number }> {
    const path = this.path(sessionId);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    const sha256 = `sha256:${hash.digest('hex')}`;
    this.digests.set(sessionId, sha256);
    return { sha256, bytes: (await stat(path)).size };
  }

  digest(sessionId: string): string | undefined {
    return this.digests.get(sessionId);
  }

  async read(sessionId: string): Promise<AsyncIterable<Uint8Array>> {
    return createReadStream(this.path(sessionId));
  }

  async discard(sessionId: string): Promise<void> {
    this.digests.delete(sessionId);
    await unlink(this.path(sessionId)).catch(() => undefined);
  }
}
