import { createServer, type Server } from 'node:http';
import { createLogger } from '@richardblaha/shared-core';
import type { LmModelBridge } from './bridge.js';
import { createLmProxyHandler, type LmProxyOptions } from './handler.js';

const log = createLogger('lm-proxy');

export interface LmProxyHandle {
  /** e.g. `http://127.0.0.1:52001` — append `/v1` for an OpenAI base URL. */
  origin: string;
  port: number;
  close(): Promise<void>;
}

export interface StartLmProxyOptions extends LmProxyOptions {
  /** 0 = ephemeral. */
  port?: number;
  /** Bind address. `127.0.0.1` (default) for host-only; `0.0.0.0` to reach it from a container. */
  host?: string;
}

/**
 * Start the LM proxy. The returned `origin + '/v1'` is what you set as
 * `OSIRIS_LM_PROXY_URL` / a crew `openai-compatible` endpoint. Bind `0.0.0.0`
 * (with a `token`) to expose it to a Dev Container via `host.docker.internal`.
 */
export function startLmProxy(
  bridge: LmModelBridge,
  options: StartLmProxyOptions = {},
): Promise<LmProxyHandle> {
  const handler = createLmProxyHandler(bridge, { token: options.token });
  const host = options.host ?? '127.0.0.1';
  const server: Server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      const origin = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`;
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
