import { connect } from "node:tls";
import { once } from "node:events";
import { LocalizedError } from "@osiris/platform/i18n.ts";
import { egressProxy, tunnel } from "@osiris/core/net/egress.ts";

/** Read-only POP3 over implicit TLS. Never issues DELE; IDs are stable UIDL values. */
export async function pop3Read(
  endpoint: { host: string; port: number; username: string; password: string },
  uid?: string,
  limit = 20,
): Promise<string> {
  // Behind the egress gate, TLS runs over its tunnel.
  const socket = egressProxy()
    ? connect({ socket: await tunnel(endpoint.host, endpoint.port), servername: endpoint.host })
    : connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host });
  socket.setTimeout(15_000, () => socket.destroy(new Error("POP3 timeout")));
  // Keep the error handled between reads as well.
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  socket.on("error", err => { failure = err; wake?.(); });
  socket.on("close", () => wake?.());
  let pending = "";
  const lines: string[] = [];
  let bytes = 0;
  socket.on("data", chunk => {
    bytes += chunk.length;
    if (bytes > 10 * 1024 * 1024) return socket.destroy(new Error("POP3 response too large"));
    pending += chunk.toString("utf8");
    let end: number;
    while ((end = pending.indexOf("\r\n")) >= 0) {
      lines.push(pending.slice(0, end));
      pending = pending.slice(end + 2);
    }
    wake?.();
  });
  const line = async (): Promise<string> => {
    while (!lines.length) {
      if (failure) throw failure;
      if (socket.destroyed) throw new Error("POP3 connection closed");
      await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
    }
    return lines.shift()!;
  };
  const ok = async () => {
    if (!(await line()).startsWith("+OK")) throw new Error("POP3 server rejected command");
  };
  const command = async (text: string, multi = false) => {
    socket.write(`${text}\r\n`);
    await ok();
    const result: string[] = [];
    if (multi) for (;;) {
      const value = await line();
      if (value === ".") break;
      result.push(value.startsWith("..") ? value.slice(1) : value);
    }
    return result;
  };
  try {
    await once(socket, "secureConnect");
    await ok();
    await command(`USER ${endpoint.username}`);
    await command(`PASS ${endpoint.password}`);
    const entries = (await command("UIDL", true)).map(value => {
      const [number, id] = value.split(" ");
      if (!/^\d+$/.test(number!) || !id) throw new Error("Invalid POP3 UIDL response");
      return { number: number!, id };
    });
    if (!uid) return JSON.stringify(entries.slice(-limit).reverse());
    const entry = entries.find(e => e.id === uid);
    if (!entry) throw new LocalizedError("errors.mail.notFound");
    return (await command(`RETR ${entry.number}`, true)).join("\r\n");
  } finally {
    socket.destroy();
  }
}
