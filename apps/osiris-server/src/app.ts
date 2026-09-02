import { Readable } from 'node:stream';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  API_BASE,
  CreateSessionRequest,
  FetchCommitRequest,
  HandoverCommitRequest,
  headers as protocolHeaders,
  type SessionEvent,
} from '@osiris/protocol';
import { parseContentRange } from '@osiris/container-sync';
import { createLogger } from '@osiris/shared-core';
import {
  InMemorySessionStore,
  InvalidTransition,
  LeaseConflict,
  SessionNotFound,
  type SessionStore,
} from './session-store.js';
import {
  InMemoryVolumeStore,
  StubHandoverExecutor,
  type HandoverExecutor,
  type VolumeStore,
} from './executors.js';
import { formatSseEvent } from './sse.js';
import { leaseExpiresAt } from './lease.js';
import { registerGitHosting } from './git.js';
import { registerConsoleRoutes, type ConsoleDeps } from './routes/console.js';
import { registerSpa } from './spa.js';

const log = createLogger('server');

export interface BuildServerOptions {
  /** Bearer token clients must present. Empty string disables auth (tests only). */
  token: string;
  /** Public origin, used to build Web IDE and upload URLs. */
  publicBaseUrl: string;
  store?: SessionStore;
  volumes?: VolumeStore;
  executor?: HandoverExecutor;
  /** How often to auto-abort expired transfer leases. 0 disables the sweep. */
  leaseSweepMs?: number;
  registry?: { url: string; repository: string; token: string };
  /** Enable smart-HTTP Git hosting under `/git/` from this directory of bare repos. */
  gitReposDir?: string;
  /** Mount the crew / backlog / memory console API under `/api/v1`. */
  console?: ConsoleDeps;
  /** Serve the Osiris console SPA (its built `dist/`) at `/`. */
  spaDir?: string;
}

function ifMatch(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const store = options.store ?? new InMemorySessionStore();
  const volumes = options.volumes ?? new InMemoryVolumeStore();
  const executor = options.executor ?? new StubHandoverExecutor(options.publicBaseUrl);
  const registry = options.registry ?? {
    url: 'registry.osiris.internal',
    repository: 'workspaces',
    token: 'stub-registry-token',
  };

  const app = Fastify({ logger: false, bodyLimit: 1_073_741_824 });

  // Volume tars arrive as a raw stream — hand it straight to the handler.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  app.addHook('onRequest', async (request, reply) => {
    // `/healthz` is open; `/git/` enforces its own HTTP Basic auth (git clients
    // cannot send a bearer token) inside registerGitHosting.
    if (request.url === '/healthz' || request.url.startsWith('/git/') || options.token === '') {
      return;
    }
    const header = request.headers.authorization ?? '';
    if (header !== `Bearer ${options.token}`) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler(async (error: FastifyError, _request, reply) => {
    if (error instanceof SessionNotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof LeaseConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof InvalidTransition) return reply.code(409).send({ error: error.message });
    if (error.validation || error.name === 'ZodError') {
      return reply.code(400).send({ error: error.message });
    }
    log.error('unhandled: %s', error.stack ?? error.message);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/healthz', async () => ({ status: 'ok', sessions: store.list().length }));

  if (options.gitReposDir) {
    registerGitHosting(app, { reposDir: options.gitReposDir, token: options.token });
  }

  if (options.console) {
    registerConsoleRoutes(app, options.console);
  }

  if (options.spaDir) {
    registerSpa(app, options.spaDir);
  }

  app.post(`${API_BASE}/sessions`, async (request, reply) => {
    const body = CreateSessionRequest.parse(request.body);
    const descriptor = store.create(body);
    return reply.code(201).send(descriptor);
  });

  app.get(`${API_BASE}/sessions/:id`, async (request) => {
    const { id } = request.params as { id: string };
    return store.get(id);
  });

  app.post(`${API_BASE}/sessions/:id/handover/prepare`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const descriptor = store.beginTransfer(
      id,
      'to-server',
      clientId(request.headers.authorization),
    );
    reply.header(protocolHeaders.leaseNext, descriptor.lease?.etag ?? '');
    return {
      leaseEtag: descriptor.lease?.etag,
      registry,
      volumeUploadUrl: `${options.publicBaseUrl}${API_BASE}/sessions/${id}/volume`,
      expiresAt: descriptor.lease?.expiresAt ?? leaseExpiresAt(),
    };
  });

  app.put(`${API_BASE}/sessions/:id/volume`, async (request, reply) => {
    const { id } = request.params as { id: string };
    store.get(id); // 404 if unknown
    const body = await collect(request.body as AsyncIterable<Uint8Array>);
    const range = parseContentRange(headerValue(request.headers['content-range']));

    await volumes.write(id, range?.start ?? 0, body);

    const incomplete = range && (range.total === undefined || range.end + 1 < range.total);
    if (incomplete) {
      return reply.code(308).send();
    }

    const result = await volumes.finalize(id);
    store.publish(id, { type: 'session.frozen', sessionId: id });
    return reply.code(202).send(result);
  });

  app.get(`${API_BASE}/sessions/:id/volume`, async (request, reply) => {
    const { id } = request.params as { id: string };
    store.get(id);
    const stream = await volumes.read(id);
    return reply.type('application/octet-stream').send(Readable.from(stream));
  });

  app.post(`${API_BASE}/sessions/:id/handover/commit`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = HandoverCommitRequest.parse(request.body);

    const uploaded = volumes.digest(id);
    if (uploaded && uploaded !== body.volumeDigest) {
      return reply.code(409).send({ error: 'volumeDigest does not match the uploaded tar' });
    }

    const { webUrl } = await executor.provision({ sessionId: id, commit: body });
    store.withLease(id, ifMatch(request.headers[protocolHeaders.lease.toLowerCase()]), (d) => {
      d.digests = {
        image: body.imageDigest,
        volume: body.volumeDigest,
        agentState: body.agentStateDigest,
      };
      d.webUrl = webUrl;
    });
    const final = store.endTransfer(id, 'server');
    return reply.code(200).send({ webUrl: final.webUrl, location: 'server' });
  });

  app.post(`${API_BASE}/sessions/:id/handover/abort`, async (request) => {
    const { id } = request.params as { id: string };
    store.withLease(id, ifMatch(request.headers[protocolHeaders.lease.toLowerCase()]), () => {});
    return store.abortTransfer(id);
  });

  app.post(`${API_BASE}/sessions/:id/handover/finalize`, async (request) => {
    const { id } = request.params as { id: string };
    return store.get(id);
  });

  app.post(`${API_BASE}/sessions/:id/fetch/prepare`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const descriptor = store.beginTransfer(id, 'to-local', clientId(request.headers.authorization));
    const frozen = await executor.freezeForFetch({ sessionId: id });
    store.publish(id, { type: 'session.frozen', sessionId: id });
    reply.header(protocolHeaders.leaseNext, descriptor.lease?.etag ?? '');
    return {
      leaseEtag: descriptor.lease?.etag,
      imageRef: frozen.imageRef,
      imageDigest: frozen.imageDigest,
      volumeDownloadUrl: frozen.volumeDownloadUrl,
      expiresAt: descriptor.lease?.expiresAt ?? leaseExpiresAt(),
    };
  });

  app.post(`${API_BASE}/sessions/:id/fetch/commit`, async (request) => {
    const { id } = request.params as { id: string };
    FetchCommitRequest.parse(request.body);
    store.withLease(id, ifMatch(request.headers[protocolHeaders.lease.toLowerCase()]), () => {});
    await executor.teardown({ sessionId: id });
    return store.endTransfer(id, 'local');
  });

  app.post(`${API_BASE}/sessions/:id/lease/renew`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const descriptor = store.withLease(
      id,
      ifMatch(request.headers[protocolHeaders.lease.toLowerCase()]),
      () => {},
    );
    reply.header(protocolHeaders.leaseNext, descriptor.lease?.etag ?? '');
    return descriptor;
  });

  app.get(`${API_BASE}/sessions/:id/events`, (request, reply) => {
    const { id } = request.params as { id: string };
    store.get(id); // 404 if unknown

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const send = (event: SessionEvent): void => {
      reply.raw.write(formatSseEvent(event));
    };
    const unsubscribe = store.subscribe(id, send);
    request.raw.on('close', () => {
      unsubscribe();
      reply.raw.end();
    });
  });

  if (options.leaseSweepMs && options.leaseSweepMs > 0) {
    const timer = setInterval(() => {
      for (const id of store.sweepExpiredLeases()) log.warn('lease expired, auto-aborted %s', id);
    }, options.leaseSweepMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return app;
}

function clientId(authorization: string | undefined): string {
  return authorization ? `token:${authorization.slice(-6)}` : 'anonymous';
}
