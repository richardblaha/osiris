import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export interface StoredObject {
  key: string;
  size: number;
  modified: Date;
}

/** Object storage for published sites and tenant backups: Civo Object Store (S3) in the cluster, a folder locally. */
export interface ObjectStore {
  put(key: string, body: Uint8Array | Readable, contentType?: string): Promise<void>;
  /** Null when the object doesn't exist. */
  get(key: string): Promise<{ body: Readable; size?: number; contentType?: string } | null>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(keys: string[]): Promise<void>;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/** Keys are built by our code from validated parts; this is the last line against `..` and odd characters. */
export function assertKey(key: string): string {
  if (!KEY.test(key) || key.split("/").some((p) => !p || p === "." || p === "..") || key.length > 1024) {
    throw new Error(`Invalid object key: ${key}`);
  }
  return key;
}

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array | Readable, contentType?: string) {
    // Multipart for streams, so a large backup never sits in memory.
    await new Upload({
      client: this.client,
      params: { Bucket: this.options.bucket, Key: assertKey(key), Body: body, ContentType: contentType },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
    }).done();
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: assertKey(key) }));
      return { body: res.Body as Readable, size: res.ContentLength, contentType: res.ContentType };
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: assertKey(prefix), ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0, modified: o.LastModified ?? new Date(0) });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000).map((k) => ({ Key: assertKey(k) }));
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: batch, Quiet: true } }));
    }
  }
}

/** Objects as files under a folder: local development and tests. */
export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(key: string) {
    return join(this.root, ...assertKey(key).split("/"));
  }

  async put(key: string, body: Uint8Array | Readable) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.part`;
    await pipeline(body instanceof Readable ? body : Readable.from([body]), createWriteStream(tmp));
    await rename(tmp, path);
  }

  async get(key: string) {
    const path = this.path(key);
    const s = await stat(path).catch(() => undefined);
    return s?.isFile() ? { body: createReadStream(path), size: s.size } : null;
  }

  async list(prefix: string) {
    const out: StoredObject[] = [];
    const walk = async (dir: string) => {
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const p = join(dir, d.name);
        if (d.isDirectory()) await walk(p);
        else if (!d.name.endsWith(".part")) {
          const key = relative(this.root, p).split(sep).join("/");
          if (key.startsWith(prefix)) {
            const s = await stat(p);
            out.push({ key, size: s.size, modified: s.mtime });
          }
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(keys: string[]) {
    for (const k of keys) await rm(this.path(k), { force: true });
  }
}

export async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}
