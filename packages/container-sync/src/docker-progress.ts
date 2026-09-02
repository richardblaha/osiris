import type Docker from 'dockerode';

/** Drain a Docker JSON-progress stream (pull / push) and resolve when it ends. */
export function followProgress(docker: Docker, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}
