/**
 * A thin typed client for the session API. Pure `fetch` + zod — no Docker,
 * no Kubernetes client, no VS Code — so both `osiris-workspace` and the CLI
 * can use it. There is no client-managed lease any more: concurrency is
 * handled server-side by the underlying `OsirisSession` resource's own
 * `resourceVersion`.
 */
import { CreateSessionRequest, SessionDescriptor } from './session.js';
import { routes } from './routes.js';

export class SessionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`session request failed: HTTP ${status}`);
    this.name = 'SessionHttpError';
  }
}

export interface SessionClientOptions {
  /** Server origin, e.g. `https://osiris.example.com` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token for the Osiris server. */
  token: string;
  fetchImpl?: typeof fetch;
}

export class SessionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SessionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new SessionHttpError(res.status, await res.text().catch(() => ''));
    }
    return res;
  }

  async createSession(input: CreateSessionRequest): Promise<SessionDescriptor> {
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

  async suspendSession(id: string): Promise<SessionDescriptor> {
    const res = await this.send(routes.suspendSession(id), { method: 'POST' });
    return SessionDescriptor.parse(await res.json());
  }

  async resumeSession(id: string): Promise<SessionDescriptor> {
    const res = await this.send(routes.resumeSession(id), { method: 'POST' });
    return SessionDescriptor.parse(await res.json());
  }

  async deleteSession(id: string): Promise<void> {
    await this.send(routes.session(id), { method: 'DELETE' });
  }

  async reportActivity(id: string): Promise<void> {
    await this.send(routes.sessionActivity(id), { method: 'POST' });
  }
}
