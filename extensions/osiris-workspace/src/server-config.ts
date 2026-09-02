/** Resolve the Osiris Server connection from workspace settings + the environment. */

export interface OsirisServerConfig {
  baseUrl: string;
  token: string;
}

export interface ServerConfigInput {
  /** e.g. `config.get('osiris.server.url')`. */
  url: unknown;
  /** e.g. `config.get('osiris.server.tokenEnv')`. */
  tokenEnv: unknown;
  env?: NodeJS.ProcessEnv;
}

export function resolveServerConfig(input: ServerConfigInput): OsirisServerConfig | undefined {
  const baseUrl = String(input.url ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return undefined;

  const tokenEnv = String(input.tokenEnv ?? 'OSIRIS_SERVER_TOKEN').trim() || 'OSIRIS_SERVER_TOKEN';
  const token = (input.env ?? process.env)[tokenEnv]?.trim() ?? '';
  return { baseUrl, token };
}
