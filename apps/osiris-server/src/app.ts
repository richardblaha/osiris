import { ApiException } from '@kubernetes/client-node';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { API_BASE, CreateSessionRequest, type SessionEvent } from '@richardblaha/osiris-protocol';
import { createLogger } from '@richardblaha/osiris-core';
import { InMemorySessionStore, SessionNotFound, type SessionStore } from './session-store.js';
import { SessionNotFoundInExecutor, StubSessionExecutor, type SessionExecutor } from './executors.js';
import { formatSseEvent } from './sse.js';
import { registerGitHosting } from './git.js';
import { registerConsoleRoutes, type ConsoleDeps } from './routes/console.js';
import { registerSpa } from './spa.js';

const log = createLogger('server');

export interface BuildServerOptions {
  /** Bearer token clients must present. Empty string disables auth (tests only). */
  token: string;
  /** Public origin — currently unused by the session routes, kept for git/console/spa URLs. */
  publicBaseUrl: string;
  store?: SessionStore;
  executor?: SessionExecutor;
  /** Enable smart-HTTP Git hosting under `/git/` from this directory of bare repos. */
  gitReposDir?: string;
  /** Mount the crew / backlog / memory console API under `/api/v1`. */
  console?: ConsoleDeps;
  /** Serve the Osiris console SPA (its built `dist/`) at `/`. */
  spaDir?: string;
}

function isNotFound(error: unknown): boolean {
  return error instanceof SessionNotFoundInExecutor || (error instanceof ApiException && error.code === 404);
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const store = options.store ?? new InMemorySessionStore();
  const executor = options.executor ?? new StubSessionExecutor();

  const app = Fastify({ logger: false, bodyLimit: 1_073_741_824 });

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
    if (error instanceof SessionNotFound || isNotFound(error)) {
      return reply.code(404).send({ error: error.message });
    }
    if (error.validation || error.name === 'ZodError') {
      return reply.code(400).send({ error: error.message });
    }
    log.error('unhandled: %s', error.stack ?? error.message);
    return reply.code(500).send({ error: 'internal error' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

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
    const descriptor = await executor.createSession(body);
    store.upsert(descriptor);
    return reply.code(201).send(descriptor);
  });

  app.get(`${API_BASE}/sessions/:id`, async (request) => {
    const { id } = request.params as { id: string };
    const descriptor = await executor.getSession(id);
    store.upsert(descriptor);
    return descriptor;
  });

  app.post(`${API_BASE}/sessions/:id/suspend`, async (request) => {
    const { id } = request.params as { id: string };
    const descriptor = await executor.suspendSession(id);
    store.upsert(descriptor);
    store.publish(id, { type: 'session.phase-changed', sessionId: id, phase: descriptor.phase });
    return descriptor;
  });

  app.post(`${API_BASE}/sessions/:id/resume`, async (request) => {
    const { id } = request.params as { id: string };
    const descriptor = await executor.resumeSession(id);
    store.upsert(descriptor);
    store.publish(id, { type: 'session.phase-changed', sessionId: id, phase: descriptor.phase });
    return descriptor;
  });

  app.delete(`${API_BASE}/sessions/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    await executor.deleteSession(id);
    store.publish(id, { type: 'session.terminated', sessionId: id });
    store.remove(id);
    return reply.code(204).send();
  });

  app.post(`${API_BASE}/sessions/:id/activity`, async (request, reply) => {
    const { id } = request.params as { id: string };
    await executor.reportActivity(id);
    return reply.code(204).send();
  });

  app.get(`${API_BASE}/sessions/:id/events`, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Ensure a cache entry (and thus an event emitter) exists before subscribing;
    // this also 404s for an unknown id via the executor.
    store.upsert(await executor.getSession(id));

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

  return app;
}
