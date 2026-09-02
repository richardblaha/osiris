import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import { startLmProxy, type LmProxyHandle } from '@osiris/lm-proxy';
import { createLogger } from '@osiris/shared-core';
import { createVscodeLmBridge, hasLanguageModelApi } from './lm-bridge.js';

const log = createLogger('workspace:lm-proxy');

export interface LmProxyInfo {
  /** URL a Dev Container reaches the proxy on (host.docker.internal). */
  containerUrl: string;
  token: string;
}

let handle: LmProxyHandle | undefined;
let info: LmProxyInfo | undefined;

/**
 * Start (once) the OpenAI-compatible proxy over the editor's Language Model API,
 * bound so a Dev Container can reach it via `host.docker.internal`. Returns the
 * env a container-side crew needs; `undefined` when the editor has no LM API.
 */
export async function ensureLmProxy(
  context: vscode.ExtensionContext,
): Promise<LmProxyInfo | undefined> {
  if (info) return info;
  if (!hasLanguageModelApi()) {
    log.warn('this editor has no Language Model API — crew runs will use the headless fallback');
    return undefined;
  }
  const token = randomBytes(24).toString('hex');
  handle = await startLmProxy(createVscodeLmBridge(), { host: '0.0.0.0', token });
  info = { containerUrl: `http://host.docker.internal:${handle.port}/v1`, token };
  context.subscriptions.push({
    dispose: () => {
      void handle?.close();
      handle = undefined;
      info = undefined;
    },
  });
  log.info('LM proxy up on :%d (container URL %s)', handle.port, info.containerUrl);
  return info;
}

/** Env vars to inject into the Dev Container so `provider: vscode-lm` resolves to the proxy. */
export function lmProxyRemoteEnv(proxy: LmProxyInfo | undefined): Record<string, string> {
  if (!proxy) return {};
  return { OSIRIS_LM_PROXY_URL: proxy.containerUrl, OSIRIS_LM_PROXY_TOKEN: proxy.token };
}
