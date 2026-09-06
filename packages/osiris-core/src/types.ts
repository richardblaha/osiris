/**
 * Domain types shared across the Osiris extensions. Keep this file free of
 * runtime code so it can be imported from anywhere (including webviews).
 */

/* ---------------------------------------------------------------- osiris-ai */

export interface AgentDescriptor {
  id: string;
  label: string;
  description?: string;
  /** System prompt / instructions for the agent. */
  instructions: string;
  /** Names of MCP tools the agent is allowed to call; `*` for all. */
  allowedTools?: string[] | '*';
}

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  /** Stable key, also used as the tool namespace prefix. */
  id: string;
  transport: McpTransport;
  /** stdio: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: base URL of the server. */
  url?: string;
  /** Milliseconds before a request is considered failed. */
  timeoutMs?: number;
  enabled?: boolean;
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  agent: AgentDescriptor;
  signal?: AbortSignal;
}
