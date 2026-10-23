import type { Client } from "@libsql/client";
import type { McpServer, Scope } from "@osiris/shared";
import type { SecretBox } from "../secrets.ts";

export const MCP_SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type McpAuth = "headers" | "oauth";

export interface McpServerConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** `oauth`: the owner signs in at the provider (see oauth.ts) instead of static headers. */
  auth: McpAuth;
}

const authOf = (r: Record<string, unknown>): McpAuth => (r.auth === "oauth" ? "oauth" : "headers");

/** Row owner: '' for tenant-wide servers, the user's sub for personal ones. */
export const mcpOwner = (scope: Scope, userId: string) => (scope === "tenant" ? "" : userId);

/** MCP server configuration in one tenant's database. Headers are sealed with the SecretBox. */
export class McpServerStore {
  constructor(
    private readonly db: Client,
    private readonly secrets: SecretBox,
  ) {}

  private headers(row: Record<string, unknown>): Record<string, string> {
    return row.headers_enc ? (JSON.parse(this.secrets.open(String(row.headers_enc))) as Record<string, string>) : {};
  }

  /** One owner's server names, enabled or not. */
  async names(owner: string): Promise<string[]> {
    const { rows } = await this.db.execute({ sql: "SELECT name FROM mcp_servers WHERE owner = ?", args: [owner] });
    return rows.map((r) => String(r.name));
  }

  /**
   * Tenant servers plus `userId`'s personal ones, for the API: header names only, never values. A tenant server the
   * user has their own of (same name) is `overridden`.
   */
  async list(userId: string, { showTenantUrls }: { showTenantUrls: boolean }): Promise<Omit<McpServer, "status">[]> {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM mcp_servers WHERE owner IN ('', ?) ORDER BY owner <> '', name",
      args: [userId],
    });
    const own = new Set(rows.filter((r) => r.owner !== "").map((r) => String(r.name)));
    return rows.map((r) => {
      const scope: Scope = r.owner === "" ? "tenant" : "personal";
      return {
        ...(scope === "tenant" && own.has(String(r.name)) ? { overridden: true } : {}),
        name: String(r.name),
        scope,
        url: scope === "tenant" && !showTenantUrls ? "" : String(r.url),
        enabled: Number(r.enabled) === 1,
        auth: authOf(r),
        headerNames: Object.keys(this.headers(r)),
        updatedAt: String(r.updated_at),
      };
    });
  }

  async get(name: string, owner: string): Promise<(McpServerConfig & { enabled: boolean }) | undefined> {
    const { rows } = await this.db.execute({ sql: "SELECT * FROM mcp_servers WHERE owner = ? AND name = ?", args: [owner, name] });
    const r = rows[0];
    return r && { name, url: String(r.url), headers: this.headers(r), auth: authOf(r), enabled: Number(r.enabled) === 1 };
  }

  /** Enabled servers of one owner with decrypted headers, for connecting. */
  async enabled(owner: string): Promise<McpServerConfig[]> {
    const { rows } = await this.db.execute({
      sql: "SELECT * FROM mcp_servers WHERE owner = ? AND enabled = 1 ORDER BY name",
      args: [owner],
    });
    return rows.map((r) => ({ name: String(r.name), url: String(r.url), headers: this.headers(r), auth: authOf(r) }));
  }

  /** Creates or updates a server. `headers: undefined` keeps the stored headers; `{}` clears them. */
  async put(
    name: string,
    owner: string,
    { url, enabled, headers, auth = "headers" }: { url: string; enabled: boolean; headers?: Record<string, string>; auth?: McpAuth },
  ) {
    // A user's server may share a name with the tenant's: theirs replaces it in their runs.
    if (!MCP_SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name "${name}"`);
    const sealed = headers === undefined ? undefined : Object.keys(headers).length ? this.secrets.seal(JSON.stringify(headers)) : null;
    await this.db.execute({
      sql: `INSERT INTO mcp_servers (owner, name, url, enabled, headers_enc, auth) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (owner, name) DO UPDATE SET url = excluded.url, enabled = excluded.enabled, auth = excluded.auth,
              headers_enc = ${sealed === undefined ? "mcp_servers.headers_enc" : "excluded.headers_enc"},
              updated_at = datetime('now')`,
      args: [owner, name, url, enabled ? 1 : 0, sealed ?? null, auth],
    });
  }

  async delete(name: string, owner: string): Promise<boolean> {
    const [r] = await this.db.batch(
      [
        { sql: "DELETE FROM mcp_servers WHERE owner = ? AND name = ?", args: [owner, name] },
        { sql: "DELETE FROM mcp_oauth WHERE owner = ? AND name = ?", args: [owner, name] },
      ],
      "write",
    );
    return (r?.rowsAffected ?? 0) > 0;
  }
}
