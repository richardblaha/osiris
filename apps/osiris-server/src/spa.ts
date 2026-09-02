import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@osiris/shared-core';

const log = createLogger('server:spa');

/**
 * Serve the Osiris console single-page app from its built `dist/` directory.
 * Unknown non-API GETs fall back to `index.html` so client-side routing works.
 */
export async function registerSpa(app: FastifyInstance, dir: string): Promise<void> {
  const indexHtml = join(dir, 'index.html');
  if (!existsSync(indexHtml)) {
    log.warn('SPA dir %s has no index.html — not serving the console', dir);
    return;
  }

  await app.register(fastifyStatic, { root: dir, prefix: '/', wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/git/')
    ) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  log.info('serving the Osiris console from %s', dir);
}
