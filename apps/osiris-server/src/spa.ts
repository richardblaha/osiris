import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createLogger } from '@richardblaha/shared-core';

const log = createLogger('server:spa');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/**
 * Serve the Osiris console single-page app from its built `dist/` directory.
 * A hand-rolled static handler (no plugin): map the request path to a file under
 * `dir`, otherwise fall back to `index.html` so client-side routing works. Not
 * for `/api/` or `/git/`.
 */
export function registerSpa(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  const indexHtml = join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    log.warn('SPA dir %s has no index.html — not serving the console', dir);
    return;
  }

  const send = (reply: FastifyReply, file: string): void => {
    void reply
      .type(MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .send(createReadStream(file));
  };

  app.get('/*', (request, reply) => {
    const urlPath = decodeURIComponent(request.url.split('?')[0] ?? '/');
    if (urlPath.startsWith('/api/') || urlPath.startsWith('/git/') || urlPath === '/healthz') {
      return reply.callNotFound();
    }
    const candidate = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));
    if (candidate.startsWith(root) && existsSync(candidate) && statSync(candidate).isFile()) {
      return send(reply, candidate);
    }
    return send(reply, indexHtml);
  });

  log.info('serving the Osiris console from %s', root);
}
