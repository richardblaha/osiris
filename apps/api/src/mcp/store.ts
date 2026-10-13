import type { Client } from "@libsql/client";
import type { McpServer } from "@osiris/shared";
import type { SecretBox } from "../secrets.ts";

export const MCP_SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface McpServerConfig {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** MCP server configuration in one tenant's database. Headers are sealed with the SecretBox. */
export class McpServerStore {
  constructor(
    private readonly db: Client,
    private readonly secrets: SecretBox,
  ) {}

  private headers(row: Record<string, unknown>): Record<string, string> {
    return row.headers_enc ? (JSON.parse(this.secrets.open(String(row.headers_enc))) as Record<string, string>) : {};
  }

  /** For the API: header names only, never values. */
  async list(): Promise<Omit<McpServer, "status">[]> {
    const { rows } = await this.db.execute("SELECT * FROM mcp_servers ORDER BY name");
    return rows.map((r) => ({
      name: String(r.name),
      url: String(r.url),
      enabled: Number(r.enabled) === 1,
      headerNames: Object.keys(this.headers(r)),
      updatedAt: String(r.updated_at),
    }));
  }

  async get(name: string): Promise<(McpServerConfig & { enabled: boolean }) | undefined> {
    const { rows } = await this.db.execute({ sql: "SELECT * FROM mcp_servers WHERE name = ?", args: [name] });
    const r = rows[0];
    return r && { name, url: String(r.url), headers: this.headers(r), enabled: Number(r.enabled) === 1 };
  }

  /** Enabled servers with decrypted headers, for connecting. */
  async enabled(): Promise<McpServerConfig[]> {
    const { rows } = await this.db.execute("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name");
    return rows.map((r) => ({ name: String(r.name), url: String(r.url), headers: this.headers(r) }));
  }

  /** Creates or updates a server. `headers: undefined` keeps the stored headers; `{}` clears them. */
  async put(name: string, { url, enabled, headers }: { url: string; enabled: boolean; headers?: Record<string, string> }) {
    if (!MCP_SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name "${name}"`);
    const sealed = headers === undefined ? undefined : Object.keys(headers).length ? this.secrets.seal(JSON.stringify(headers)) : null;
    await this.db.execute({
      sql: `INSERT INTO mcp_servers (name, url, enabled, headers_enc) VALUES (?, ?, ?, ?)
            ON CONFLICT (name) DO UPDATE SET url = excluded.url, enabled = excluded.enabled,
              headers_enc = ${sealed === undefined ? "mcp_servers.headers_enc" : "excluded.headers_enc"},
              updated_at = datetime('now')`,
      args: [name, url, enabled ? 1 : 0, sealed ?? null],
    });
  }

  async delete(name: string): Promise<boolean> {
    return (await this.db.execute({ sql: "DELETE FROM mcp_servers WHERE name = ?", args: [name] })).rowsAffected > 0;
  }
}
