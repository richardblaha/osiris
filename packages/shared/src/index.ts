export type Channel = "web" | "whatsapp";

export interface ThreadSummary {
  id: string;
  title: string | null;
  channel: Channel;
  updatedAt: string;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown>; result?: string };

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  content: MessagePart[];
}

/** Server-sent events emitted by `POST /api/threads/:id/runs`, one JSON object per SSE `data` line. */
export type RunEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; result: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type Role = "admin" | "member";

/** Identity and memberships come from PocketID (claims and groups); see apps/api/src/auth/. */
export interface MeResponse {
  user: { id: string; email: string | null; name: string | null; phone: string | null };
  tenants: { id: string; name: string; role: Role }[];
}

export interface SkillSummary {
  name: string;
  description: string;
  /** `bundled` ships with the app; `tenant` was added by the tenant's admin and overrides a bundled one. */
  source: "bundled" | "tenant";
}

export interface Skill extends SkillSummary {
  instructions: string;
}

export interface Memory {
  id: string;
  content: string;
  /** Shared with everyone in the tenant, otherwise personal. */
  shared: boolean;
  createdAt: string;
}

/** A tenant's remote MCP server. Header values are write-only: the API returns only their names. */
export interface McpServer {
  name: string;
  url: string;
  enabled: boolean;
  headerNames: string[];
  updatedAt: string;
  /** Result of the last connection attempt; absent if not tried yet (or disabled). */
  status?: McpServerStatus;
}

export type McpServerStatus = { ok: true; tools: string[] } | { ok: false; error: string };
