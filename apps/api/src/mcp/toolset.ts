import type { StructuredToolInterface } from "@langchain/core/tools";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { McpServerStatus } from "@osiris/shared";
import type { McpServerConfig, McpServerStore } from "./store.ts";
import { assertSafeMcpUrl } from "./url.ts";

export interface McpConnection {
  tools: StructuredToolInterface[];
  close(): Promise<void>;
}

/** Opens one server and lists its tools. Replaceable in tests. */
export type McpConnector = (server: McpServerConfig) => Promise<McpConnection>;

export interface McpOptions {
  /** Development only: allow http and private addresses (MCP servers on localhost). */
  allowPrivate?: boolean;
  connect?: McpConnector;
}

const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 60_000;
/** Loaded tools are reused for this long; config changes invalidate immediately. */
const CACHE_TTL_MS = 5 * 60_000;
/** Replaced connections stay open this long, so runs already using their tools can finish. */
const CLOSE_GRACE_MS = 2 * 60_000;

export const defaultConnector =
  (allowPrivate: boolean): McpConnector =>
  async ({ name, url, headers }) => {
    await assertSafeMcpUrl(url, { allowPrivate });
    // One adapter per server, so a failing server is isolated. Tool names get the server prefix (`<server>_<tool>`).
    const adapter = new MCPAdapter({ servers: { [name]: { url, headers } }, defaultToolTimeout: TOOL_TIMEOUT_MS });
    try {
      return { tools: await adapter.listTools(), close: () => adapter.close() };
    } catch (err) {
      await adapter.close().catch(() => {});
      throw err;
    }
  };

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timeout po ${ms / 1000} s`)), ms))]);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * The tools of one tenant's enabled MCP servers. Connections are opened lazily, cached, and rebuilt after
 * `invalidate()` (on config change) or the TTL. A server that fails is skipped and reported in `status()`.
 */
export class McpToolset {
  private readonly connect: McpConnector;
  private readonly allowPrivate: boolean;
  private loading?: Promise<StructuredToolInterface[]>;
  private loadedAt = 0;
  private connections: McpConnection[] = [];
  private readonly statuses = new Map<string, McpServerStatus>();

  constructor(
    private readonly store: McpServerStore,
    options: McpOptions = {},
  ) {
    this.allowPrivate = options.allowPrivate ?? false;
    this.connect = options.connect ?? defaultConnector(this.allowPrivate);
  }

  /** Validates a URL before it is saved (throws UnsafeUrlError). */
  checkUrl(url: string): Promise<URL> {
    return assertSafeMcpUrl(url, { allowPrivate: this.allowPrivate });
  }

  tools(): Promise<StructuredToolInterface[]> {
    if (!this.loading || Date.now() - this.loadedAt > CACHE_TTL_MS) {
      this.loadedAt = Date.now();
      this.loading = this.load();
    }
    return this.loading;
  }

  invalidate(): void {
    this.loading = undefined;
  }

  /** Status per server from the last load. */
  status(): ReadonlyMap<string, McpServerStatus> {
    return this.statuses;
  }

  /** Connects to one server once, outside the cache, to check a configuration. The result becomes its status. */
  async test(server: McpServerConfig): Promise<McpServerStatus> {
    let status: McpServerStatus;
    try {
      const conn = await withTimeout(this.connect(server), CONNECT_TIMEOUT_MS);
      await conn.close().catch(() => {});
      status = { ok: true, tools: conn.tools.map((t) => t.name) };
    } catch (err) {
      status = { ok: false, error: message(err) };
    }
    this.statuses.set(server.name, status);
    return status;
  }

  private async load(): Promise<StructuredToolInterface[]> {
    const servers = await this.store.enabled();
    const results = await Promise.all(
      servers.map(async (s) => {
        try {
          return { name: s.name, conn: await withTimeout(this.connect(s), CONNECT_TIMEOUT_MS) };
        } catch (err) {
          console.warn(`MCP server ${s.name} unavailable: ${message(err)}`);
          return { name: s.name, error: message(err) };
        }
      }),
    );

    const previous = this.connections;
    if (previous.length) setTimeout(() => previous.forEach((c) => void c.close().catch(() => {})), CLOSE_GRACE_MS).unref();
    this.connections = results.flatMap((r) => (r.conn ? [r.conn] : []));
    this.statuses.clear();
    for (const r of results) {
      this.statuses.set(r.name, r.conn ? { ok: true, tools: r.conn.tools.map((t) => t.name) } : { ok: false, error: r.error! });
    }
    return this.connections.flatMap((c) => c.tools);
  }

  async close(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.close().catch(() => {})));
    this.connections = [];
  }
}
