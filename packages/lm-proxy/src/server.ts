import { createServer, type Server } from 'node:http';
import { createLogger } from '@osiris/shared-core';
import type { LmModelBridge } from './bridge.js';
import { createLmProxyHandler } from './handler.js';

const log = createLogger('lm-proxy');

export interface LmProxyHandle {
  /** e.g. `http://127.0.0.1:52001` — append `/v1` for an OpenAI base URL. */
  origin: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Start the LM proxy on `127.0.0.1:<port>` (0 = ephemeral). The returned
 * `origin + '/v1'` is what you set as `OSIRIS_LM_PROXY_URL` / a crew
 * `openai-compatible` endpoint.
 */
export function startLmProxy(bridge: LmModelBridge, port = 0): Promise<LmProxyHandle> {
  const handler = createLmProxyHandler(bridge);
  const server: Server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      const origin = `http://127.0.0.1:${boundPort}`;
      log.info('LM proxy listening on %s (OpenAI base: %s/v1)', origin, origin);
      resolve({
        origin,
        port: boundPort,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
