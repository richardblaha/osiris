/**
 * A thin typed client for the migration protocol. Pure `fetch` + zod — no Docker,
 * no VS Code — so both `osiris-workspace` and the desktop orchestrator can use it.
 * The current lease etag is carried automatically between mutating calls.
 */
import {
  CreateSessionRequest,
  SessionDescriptor,
  type SessionOrigin,
} from './session.js';
import {
  FetchCommitRequest,
  FetchPrepareResponse,
  HandoverCommitRequest,
  HandoverCommitResponse,
  HandoverPrepareResponse,
} from './handover.js';
import { headers, routes } from './routes.js';

export class HandoverHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`handover request failed: HTTP ${status}`);
    this.name = 'HandoverHttpError';
  }
}

export interface HandoverClientOptions {
  /** Server origin, e.g. `https://osiris.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token for the Osiris server. */
  token: string;
  fetchImpl?: typeof fetch;
}

export class HandoverClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private lease: string | undefined;

  constructor(options: HandoverClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The lease etag received from the last response, if any. */
  get leaseEtag(): string | undefined {
    return this.lease;
  }

  private async send(path: string, init: RequestInit & { extraHeaders?: Record<string, string> } = {}): Promise<Response> {
    const { extraHeaders, ...rest } = init;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...rest,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(this.lease ? { [headers.lease]: this.lease } : {}),
        ...extraHeaders,
      },
    });
    if (!res.ok) {
      throw new HandoverHttpError(res.status, await res.text().catch(() => ''));
    }
    const next = res.headers.get(headers.leaseNext);
    if (next) this.lease = next;
    return res;
  }

  async createSession(input: {
    workspaceId: string;
    devcontainerHash: string;
    origin?: SessionOrigin;
  }): Promise<SessionDescriptor> {
    const res = await this.send(routes.createSession(), {
      method: 'POST',
      body: JSON.stringify(CreateSessionRequest.parse(input)),
    });
    return SessionDescriptor.parse(await res.json());
  }

  async getSession(id: string): Promise<SessionDescriptor> {
    const res = await this.send(routes.session(id), { method: 'GET' });
    return SessionDescriptor.parse(await res.json());
  }

  async prepareHandover(id: string): Promise<HandoverPrepareResponse> {
    const res = await this.send(routes.handoverPrepare(id), { method: 'POST' });
    const parsed = HandoverPrepareResponse.parse(await res.json());
    this.lease = parsed.leaseEtag;
    return parsed;
  }

  async commitHandover(
    id: string,
    body: HandoverCommitRequest,
    idempotencyKey: string,
  ): Promise<HandoverCommitResponse> {
    const res = await this.send(routes.handoverCommit(id), {
      method: 'POST',
      body: JSON.stringify(HandoverCommitRequest.parse(body)),
      extraHeaders: { [headers.idempotencyKey]: idempotencyKey },
    });
    return HandoverCommitResponse.parse(await res.json());
  }

  async abortHandover(id: string): Promise<void> {
    await this.send(routes.handoverAbort(id), { method: 'POST' });
    this.lease = undefined;
  }

  async prepareFetch(id: string): Promise<FetchPrepareResponse> {
    const res = await this.send(routes.fetchPrepare(id), { method: 'POST' });
    const parsed = FetchPrepareResponse.parse(await res.json());
    this.lease = parsed.leaseEtag;
    return parsed;
  }

  async commitFetch(id: string, body: FetchCommitRequest): Promise<void> {
    await this.send(routes.fetchCommit(id), {
      method: 'POST',
      body: JSON.stringify(FetchCommitRequest.parse(body)),
    });
    this.lease = undefined;
  }

  async renewLease(id: string): Promise<void> {
    await this.send(routes.leaseRenew(id), { method: 'POST' });
  }
}
