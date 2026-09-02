import { createLogger } from '@osiris/shared-core';
import {
  AnthropicAdapter,
  EchoProviderAdapter,
  OllamaAdapter,
  OpenAiCompatibleAdapter,
  type ProviderAdapter,
} from '@osiris/agent-core';
import type { CrewConfig, ProviderConfig } from '@osiris/protocol';

const log = createLogger('crew:providers');

/**
 * The editor's Language Model API (VS Code / Copilot Chat). The extension host
 * supplies this; headless runs (CLI, CI) do not have it and fall back to a
 * configured provider.
 */
export interface VsCodeLmBridge {
  createAdapter(model: string): ProviderAdapter;
}

export interface ProviderResolutionOptions {
  config: CrewConfig;
  /** Present only inside the editor. */
  vscodeLm?: VsCodeLmBridge;
  env?: NodeJS.ProcessEnv;
  /** Provider to use when a spec names `vscode-lm` but no bridge is available. */
  headlessFallback?: ProviderConfig;
}

/** Split `vscode-lm/claude-opus-5` into `["vscode-lm", "claude-opus-5"]`. */
export function parseModelSpec(spec: string): { provider: string; model: string } {
  const slash = spec.indexOf('/');
  if (slash === -1) return { provider: spec, model: '' };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

function build(
  kind: ProviderConfig['kind'],
  model: string,
  cfg: ProviderConfig,
  env: NodeJS.ProcessEnv,
): ProviderAdapter {
  const apiKey = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
  switch (kind) {
    case 'echo':
      return new EchoProviderAdapter();
    case 'anthropic':
      return new AnthropicAdapter({ model: model || cfg.model, apiKey });
    case 'openai-compatible':
      return new OpenAiCompatibleAdapter({
        endpoint: cfg.endpoint ?? '',
        model: model || cfg.model || '',
        apiKey,
      });
    case 'ollama':
      return new OllamaAdapter({ baseUrl: cfg.endpoint, model: model || cfg.model || '' });
    case 'vscode-lm':
      throw new Error('vscode-lm has no direct adapter — use a bridge or a headless fallback');
  }
}

/**
 * Resolve a model spec (`<provider>/<model>`) to a concrete `ProviderAdapter`,
 * honouring `crew.json`'s `providers` map, the editor LM bridge and a headless
 * fallback.
 */
export function resolveProvider(spec: string, options: ProviderResolutionOptions): ProviderAdapter {
  const env = options.env ?? process.env;
  const { provider, model } = parseModelSpec(spec || options.config.defaultModel);
  const declared: ProviderConfig = options.config.providers[provider] ?? {
    kind: provider as ProviderConfig['kind'],
  };

  if (declared.kind === 'vscode-lm') {
    // 1. In-process editor LM API (extension host).
    if (options.vscodeLm) return options.vscodeLm.createAdapter(model);
    // 2. The LM proxy the editor publishes into the container (OpenAI-compatible
    //    shim over vscode.lm) — this is how a container-side crew still gets its
    //    models from the VS Code Language Model API.
    const proxyUrl = declared.endpoint ?? env.OSIRIS_LM_PROXY_URL;
    if (proxyUrl) {
      log.info('"%s" via the VS Code LM proxy at %s', spec, proxyUrl);
      return new OpenAiCompatibleAdapter({
        endpoint: proxyUrl,
        model,
        apiKey: env.OSIRIS_LM_PROXY_TOKEN,
      });
    }
    // 3. Headless fallback (CLI/CI with no editor at all).
    const fallback = options.headlessFallback ?? { kind: 'echo' };
    log.warn('no VS Code LM bridge or proxy — "%s" falls back to %s', spec, fallback.kind);
    return build(fallback.kind, fallback.model ?? model, fallback, env);
  }

  return build(declared.kind, model, declared, env);
}
