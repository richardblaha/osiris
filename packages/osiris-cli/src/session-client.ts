import { SessionClient } from '@richardblaha/osiris-protocol';

/** Build a `SessionClient` against the osiris-api pointed at by env vars. */
export function createSessionClient(env: NodeJS.ProcessEnv): SessionClient {
  return new SessionClient({
    baseUrl: env.OSIRIS_SERVER_URL ?? 'http://localhost:8080',
    token: env.OSIRIS_SERVER_TOKEN ?? '',
  });
}
