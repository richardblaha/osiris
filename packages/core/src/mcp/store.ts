import { userDir, type Records } from "../projects/records.ts";
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

/** Row owner: '' for project-wide servers, the user's sub for personal ones. */
export const mcpOwner = (scope: Scope, userId: string) => (scope === "project" ? "" : userId);

interface StoredServer {
  url: string;
  enabled: boolean;
  auth: McpAuth;
  updatedAt: string;
  /** A user's sealed headers; the project's are kept apart in private/mcp-headers (the definition goes to git). */
  headersEnc?: string | null;
}

/** Where an owner's servers are: the project's in `mcp/`, a user's in their private folder. */
const dirOf = (owner: string) => (owner ? `${userDir(owner)}/mcp` : "mcp");
const headersFile = (owner: string, name: string) => (owner ? `${dirOf(owner)}/${name}.json` : `private/mcp-headers/${name}.json`);

/** MCP server configuration of one project, one JSON file per server. Headers are sealed with the SecretBox. */
export class McpServerStore {
  constructor(
    private readonly records: Records,
    private readonly secrets: SecretBox,
  ) {}

  private async sealedHeaders(owner: string, name: string): Promise<string | null | undefined> {
    return (await this.records.read<{ headersEnc?: string | null }>(headersFile(owner, name)))?.headersEnc;
  }

  private async headers(owner: string, name: string): Promise<Record<string, string>> {
    const sealed = await this.sealedHeaders(owner, name);
    return sealed ? (JSON.parse(this.secrets.open(sealed)) as Record<string, string>) : {};
  }

  private async servers(owner: string) {
    return (await this.records.all<StoredServer>(dirOf(owner))).filter((r) => MCP_SERVER_NAME.test(r.name));
  }

  /** One owner's server names, enabled or not. */
  async names(owner: string): Promise<string[]> {
    return (await this.servers(owner)).map((r) => r.name);
  }

  /**
   * Project servers plus `userId`'s personal ones, for the API: header names only, never values. A project server the
   * user has their own of (same name) is `overridden`.
   */
  async list(userId: string, { showProjectUrls }: { showProjectUrls: boolean }): Promise<Omit<McpServer, "status">[]> {
    const own = userId ? await this.servers(userId) : [];
    const names = new Set(own.map((r) => r.name));
    const row = async (owner: string, r: { name: string; value: StoredServer }): Promise<Omit<McpServer, "status">> => {
      const scope: Scope = owner === "" ? "project" : "personal";
      return {
        ...(scope === "project" && names.has(r.name) ? { overridden: true } : {}),
        name: r.name,
        scope,
        url: scope === "project" && !showProjectUrls ? "" : r.value.url,
        enabled: r.value.enabled,
        auth: authOf(r.value as unknown as Record<string, unknown>),
        headerNames: Object.keys(await this.headers(owner, r.name)),
        updatedAt: r.value.updatedAt,
      };
    };
    return [...(await Promise.all((await this.servers("")).map((r) => row("", r)))), ...(await Promise.all(own.map((r) => row(userId, r))))];
  }

  async get(name: string, owner: string): Promise<(McpServerConfig & { enabled: boolean }) | undefined> {
    if (!MCP_SERVER_NAME.test(name)) return undefined;
    const r = await this.records.read<StoredServer>(`${dirOf(owner)}/${name}.json`);
    return r && { name, url: r.url, headers: await this.headers(owner, name), auth: authOf(r as unknown as Record<string, unknown>), enabled: r.enabled };
  }

  /** Enabled servers of one owner with decrypted headers, for connecting. */
  async enabled(owner: string): Promise<McpServerConfig[]> {
    const out: McpServerConfig[] = [];
    for (const r of await this.servers(owner)) {
      if (r.value.enabled) out.push({ name: r.name, url: r.value.url, headers: await this.headers(owner, r.name), auth: authOf(r.value as unknown as Record<string, unknown>) });
    }
    return out;
  }

  /** Creates or updates a server. `headers: undefined` keeps the stored headers; `{}` clears them. */
  async put(
    name: string,
    owner: string,
    { url, enabled, headers, auth = "headers" }: { url: string; enabled: boolean; headers?: Record<string, string>; auth?: McpAuth },
  ) {
    // A user's server may share a name with the project's: theirs replaces it in their runs.
    if (!MCP_SERVER_NAME.test(name)) throw new Error(`Invalid MCP server name "${name}"`);
    const headersEnc = headers === undefined ? await this.sealedHeaders(owner, name) : Object.keys(headers).length ? this.secrets.seal(JSON.stringify(headers)) : null;
    const server: StoredServer = { url, enabled, auth, updatedAt: new Date().toISOString() };
    if (owner) await this.records.write(`${dirOf(owner)}/${name}.json`, { ...server, headersEnc: headersEnc ?? null });
    else {
      await this.records.write(`${dirOf(owner)}/${name}.json`, server);
      if (headersEnc) await this.records.write(headersFile(owner, name), { headersEnc });
      else await this.records.remove(headersFile(owner, name));
    }
  }

  async delete(name: string, owner: string): Promise<boolean> {
    if (!MCP_SERVER_NAME.test(name)) return false;
    const existed = await this.records.remove(`${dirOf(owner)}/${name}.json`);
    if (!owner) await this.records.remove(headersFile(owner, name));
    await this.records.remove(`${owner ? userDir(owner) : "private"}/mcp-oauth/${name}.json`);
    return existed;
  }
}
