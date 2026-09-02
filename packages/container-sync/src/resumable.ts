import { createHash } from 'node:crypto';

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const OK_STATUS = new Set([200, 201, 202, 204, 308]);

export interface ResumableUploadOptions {
  token: string;
  /** Bytes per PUT. Default 8 MiB. */
  chunkSize?: number;
  fetchImpl?: typeof fetch;
}

export interface ResumableUploadResult {
  sha256: string;
  bytes: number;
}

/**
 * Upload a volume tar to a resumable endpoint in `Content-Range` chunks. Each
 * non-final PUT carries `bytes <start>-<end>/*` (server replies `308`); the final
 * PUT carries the real total (server replies `2xx` with the assembled digest).
 * The sha256 is computed client-side over the whole stream.
 */
export async function uploadVolumeResumable(
  url: string,
  tar: AsyncIterable<string | Uint8Array>,
  options: ResumableUploadOptions,
): Promise<ResumableUploadResult> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK;
  const doFetch = options.fetchImpl ?? fetch;
  const hash = createHash('sha256');
  let carry: Buffer = Buffer.alloc(0);
  let sent = 0;

  const put = async (body: Buffer, final: boolean): Promise<void> => {
    const total = final ? String(sent + body.length) : '*';
    const end = body.length > 0 ? sent + body.length - 1 : sent;
    const res = await doFetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${sent}-${end}/${total}`,
      },
      body,
    });
    if (!OK_STATUS.has(res.status)) {
      throw new Error(`resumable upload failed at offset ${sent}: HTTP ${res.status}`);
    }
    sent += body.length;
  };

  for await (const chunk of tar) {
    const buf = Buffer.from(chunk);
    hash.update(buf);
    carry = carry.length === 0 ? buf : Buffer.concat([carry, buf]);
    while (carry.length >= chunkSize) {
      await put(carry.subarray(0, chunkSize), false);
      carry = carry.subarray(chunkSize);
    }
  }
  await put(carry, true);

  return { sha256: `sha256:${hash.digest('hex')}`, bytes: sent };
}

export interface ContentRange {
  start: number;
  end: number;
  /** `undefined` while the total is still unknown (`*`). */
  total?: number;
}

/** Parse a `Content-Range: bytes <start>-<end>/<total|*>` header. */
export function parseContentRange(header: string | undefined): ContentRange | undefined {
  if (!header) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, start, end, total] = match;
  return {
    start: Number(start),
    end: Number(end),
    total: total === '*' ? undefined : Number(total),
  };
}
