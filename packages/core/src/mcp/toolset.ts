import type { StructuredToolInterface } from "@langchain/core/tools";
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { McpServerStatus } from "@osiris/shared";
import { SECRET_REF, templateHost } from "../vault/template.ts";
import type { SecretVault } from "../vault/vault.ts";
import { finishOAuth, StoredOAuthProvider, startOAuth, type McpOAuthStore } from "./oauth.ts";
import type { McpServerConfig, McpServerStore } from "./store.ts";
import { assertSafePublicUrl } from "./url.ts";
import { LocalizedError } from "@osiris/platform/i18n.ts";

export interface McpConnection {
  tools: StructuredToolInterface[];
  close(): Promise<void>;
}

/** Opens one server and lists its tools. Replaceable in tests. */
export type McpConnector = (server: McpServerConfig & { authProvider?: StoredOAuthProvider }) => Promise<McpConnection>;

export interface McpOptions {
  /** Development only: allow http and private addresses (MCP servers on localhost). */
  allowPrivate?: boolean;
  connect?: McpConnector;
  /** Where OAuth providers send the user back: the web app's `/mcp-callback`. */
  oauthRedirectUrl?: string;
  /** For OAuth discovery, registration and tokens (tests). */
  oauthFetch?: typeof fetch;
}

/** The server uses OAuth and its owner hasn't signed in (or the sign-in expired for good). */
export class McpSignInRequiredError extends LocalizedError {}

const CONNECT_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 60_000;
/** Loaded tools are reused for this long; config changes invalidate immediately. */
const CACHE_TTL_MS = 5 * 60_000;
/** Replaced connections stay open this long, so runs already using their tools can finish. */
const CLOSE_GRACE_MS = 2 * 60_000;
/** Personal connections of users who haven't run the agent for this long are closed. */
const IDLE_MS = 15 * 60_000;

export const defaultConnector =
  (allowPrivate: boolean): McpConnector =>
  async ({ name, url, headers, authProvider }) => {
    await assertSafePublicUrl(url, { allowPrivate });
    // One adapter per server, so a failing server is isolated. Tool names get the server prefix (`<server>_<tool>`).
    const adapter = new MCPAdapter({ servers: { [name]: { url, headers, authProvider } }, defaultToolTimeout: TOOL_TIMEOUT_MS });
    try {
      return { tools: await adapter.listTools(), close: () => adapter.close() };
    } catch (err) {
      await adapter.close().catch(() => {});
      throw err;
    }
  };

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new LocalizedError("errors.mcp.timeout", { seconds: ms / 1000 })), ms))]);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

const closeLater = (connections: McpConnection[], ms: number) => {
  if (connections.length) setTimeout(() => connections.forEach((c) => void c.close().catch(() => {})), ms).unref();
};

/** The connected servers of one owner ('' = tenant-wide, or a user's sub). */
class OwnerTools {
  loading?: Promise<StructuredToolInterface[]>;
  loadedAt = 0;
  lastUsed = Date.now();
  connections: McpConnection[] = [];
  readonly statuses = new Map<string, McpServerStatus>();
}

/**
 * MCP tools of one tenant: its tenant-wide servers plus each user's personal servers. Connections open lazily,
 * are cached per owner and rebuilt after `invalidate(owner)` (config change) or the TTL. A server that fails is
 * skipped and reported in `status()`.
 */
export class McpToolset {
  private readonly connect: McpConnector;
  private readonly allowPrivate: boolean;
  private readonly owners = new Map<string, OwnerTools>();

  private readonly redirectUrl: string;
  private readonly oauthFetch?: typeof fetch;

  constructor(
    private readonly store: McpServerStore,
    private readonly vault: SecretVault,
    private readonly oauth: McpOAuthStore,
    options: McpOptions = {},
  ) {
    this.allowPrivate = options.allowPrivate ?? false;
    this.connect = options.connect ?? defaultConnector(this.allowPrivate);
    this.redirectUrl = options.oauthRedirectUrl ?? "http://localhost:5173/mcp-callback";
    this.oauthFetch = options.oauthFetch;
  }

  private provider(owner: string, name: string) {
    return new StoredOAuthProvider(this.oauth, owner, name, this.redirectUrl);
  }

  /** Whether an OAuth server's owner is signed in. */
  signedIn(owner: string, name: string): Promise<boolean> {
    return this.oauth.connected(owner, name);
  }

  /** Starts signing in to an OAuth server: the provider's URL to send the user to (null: already signed in). */
  async startSignIn(server: McpServerConfig, owner: string): Promise<string | null> {
    await assertSafePublicUrl(server.url, { allowPrivate: this.allowPrivate });
    return (await startOAuth(this.provider(owner, server.name), server.url, this.oauthFetch))?.toString() ?? null;
  }

  /** Finishes a sign-in the provider sent the user back from; returns the server, whose tools reload. */
  async finishSignIn(state: string, code: string, iss?: string): Promise<{ owner: string; name: string } | undefined> {
    const pending = await this.oauth.byState(state);
    if (!pending) return undefined;
    const server = await this.store.get(pending.name, pending.owner);
    if (!server) return undefined;
    await finishOAuth(this.provider(pending.owner, pending.name), server.url, code, iss, this.oauthFetch);
    this.invalidate(pending.owner);
    return pending;
  }

  /** The owner of a pending sign-in, to check who may finish it. */
  pendingSignIn(state: string) {
    return this.oauth.byState(state);
  }

  /** Validates a URL before it is saved (throws UnsafeUrlError or SecretUseError). Secrets may appear only after the host. */
  checkUrl(url: string): Promise<URL> {
    templateHost(url);
    return assertSafePublicUrl(url.replace(SECRET_REF, "x"), { allowPrivate: this.allowPrivate });
  }

  /** Any secret may have changed: drop every cached connection set. */
  invalidateAll(): void {
    for (const group of this.owners.values()) group.loading = undefined;
  }

  /**
   * Fills `{{secret:NAME}}` in the URL and headers. Tenant servers ('' owner) get tenant secrets only;
   * personal servers get the owner's secrets, then the tenant's. Every secret must allow the URL's host.
   */
  private async resolve(server: McpServerConfig, owner: string): Promise<McpServerConfig> {
    const texts: Record<string, string> = { url: server.url };
    for (const [k, v] of Object.entries(server.headers)) texts[`h:${k}`] = v;
    const { filled } = await this.vault.fill(texts, { userId: owner, host: templateHost(server.url) });
    const headers = Object.fromEntries(Object.keys(server.headers).map((k) => [k, filled[`h:${k}`]!]));
    return { name: server.name, url: filled.url!, headers, auth: server.auth };
  }

  private open(server: McpServerConfig, owner: string): Promise<McpConnection> {
    return withTimeout(
      (async () => {
        const resolved = await this.resolve(server, owner);
        if (server.auth !== "oauth") return this.connect(resolved);
        if (!(await this.oauth.connected(owner, server.name))) throw new McpSignInRequiredError("errors.mcp.signInRequired");
        return this.connect({ ...resolved, authProvider: this.provider(owner, server.name) });
      })(),
      CONNECT_TIMEOUT_MS,
    );
  }

  /**
   * Tools for a user's run: the tenant's servers and the user's own. A server of theirs replaces the tenant's of the
   * same name (enabled or not), so its tools never come twice.
   */
  async tools(userId = ""): Promise<StructuredToolInterface[]> {
    this.evictIdle();
    if (!userId) return this.ownerTools("");
    const [own, tenant, mine] = await Promise.all([this.store.names(userId), this.ownerTools(""), this.ownerTools(userId)]);
    return [...tenant.filter((t) => !own.some((name) => t.name.startsWith(`${name}_`))), ...mine];
  }

  invalidate(owner: string): void {
    const group = this.owners.get(owner);
    if (group) group.loading = undefined;
  }

  /** Status per server of one owner, from the last load or test. */
  status(owner: string): ReadonlyMap<string, McpServerStatus> {
    return this.owners.get(owner)?.statuses ?? new Map();
  }

  /** Connects to one server once, outside the cache, to check a configuration. The result becomes its status. */
  async test(server: McpServerConfig, owner: string): Promise<McpServerStatus> {
    let status: McpServerStatus;
    try {
      const conn = await this.open(server, owner);
      await conn.close().catch(() => {});
      status = { ok: true, tools: conn.tools.map((t) => t.name) };
    } catch (err) {
      status = { ok: false, error: message(err) };
    }
    this.group(owner).statuses.set(server.name, status);
    return status;
  }

  async close(): Promise<void> {
    const all = [...this.owners.values()].flatMap((g) => g.connections);
    this.owners.clear();
    await Promise.all(all.map((c) => c.close().catch(() => {})));
  }

  private group(owner: string): OwnerTools {
    let group = this.owners.get(owner);
    if (!group) this.owners.set(owner, (group = new OwnerTools()));
    return group;
  }

  private ownerTools(owner: string): Promise<StructuredToolInterface[]> {
    const group = this.group(owner);
    group.lastUsed = Date.now();
    if (!group.loading || Date.now() - group.loadedAt > CACHE_TTL_MS) {
      group.loadedAt = Date.now();
      group.loading = this.load(owner, group);
    }
    return group.loading;
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [owner, group] of this.owners) {
      if (owner !== "" && now - group.lastUsed > IDLE_MS) {
        this.owners.delete(owner);
        closeLater(group.connections, CLOSE_GRACE_MS);
      }
    }
  }

  private async load(owner: string, group: OwnerTools): Promise<StructuredToolInterface[]> {
    const servers = await this.store.enabled(owner);
    const results = await Promise.all(
      servers.map(async (s) => {
        try {
          return { name: s.name, conn: await this.open(s, owner) };
        } catch (err) {
          console.warn(`MCP server ${s.name} unavailable: ${message(err)}`);
          return { name: s.name, error: message(err) };
        }
      }),
    );

    closeLater(group.connections, CLOSE_GRACE_MS);
    group.connections = results.flatMap((r) => (r.conn ? [r.conn] : []));
    group.statuses.clear();
    for (const r of results) {
      group.statuses.set(r.name, r.conn ? { ok: true, tools: r.conn.tools.map((t) => t.name) } : { ok: false, error: r.error! });
    }
    return group.connections.flatMap((c) => c.tools);
  }
}
