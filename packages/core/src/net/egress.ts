import { connect, type Socket } from "node:net";

/**
 * In a contained local agent (`osiris` in Docker) nothing reaches the network but through the egress gate, an HTTP
 * CONNECT proxy that resolves names itself and refuses private, loopback and link-local addresses. `fetch` and the
 * `http`/`https` modules use it through Node's `NODE_USE_ENV_PROXY` and `HTTPS_PROXY`; clients that open their own
 * sockets (SMTP, IMAP, POP3, SFTP) tunnel through it with `tunnel`.
 */
export function egressProxy(): URL | undefined {
  const raw = process.env.OSIRIS_EGRESS_PROXY;
  return raw ? new URL(raw) : undefined;
}

/** A TCP connection to `host:port` through the egress gate (a CONNECT tunnel), ready for TLS or SSH on top. */
export function tunnel(host: string, port: number, { proxy = egressProxy(), timeoutMs = 15_000 } = {}): Promise<Socket> {
  if (!proxy) return Promise.reject(new Error("No egress proxy"));
  if (/[\s\r\n]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("Invalid destination"));
  const authority = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) || 80 });
    const fail = (err: Error) => (socket.destroy(), reject(err));
    socket.setTimeout(timeoutMs, () => fail(new Error(`No connection to ${authority} within ${timeoutMs / 1000} s`)));
    socket.once("error", fail);
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return head.length > 8192 ? fail(new Error("Egress gate answered too much")) : undefined;
      socket.off("data", onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1];
      if (status !== "200") return fail(new Error(`The egress gate refused ${authority} (${status ?? "no status"})`));
      socket.setTimeout(0);
      socket.off("error", fail);
      // Bytes after the header already belong to the tunnel.
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
}
