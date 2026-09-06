declare module 'git-http-backend' {
  import type { Duplex } from 'node:stream';

  interface GitService {
    action: 'push' | 'pull' | 'info';
    type: string;
    fields: Record<string, string>;
    cmd: string;
    args: string[];
    createStream(): Duplex;
  }

  function backend(
    url: string,
    callback: (error: Error | null, service: GitService | undefined) => void,
  ): Duplex & { on(event: 'service', listener: (service: GitService) => void): void };

  export = backend;
}
