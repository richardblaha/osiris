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

/** Who a setting applies to: the whole tenant (managed by admins) or only the current user. */
export type Scope = "tenant" | "personal";

export interface SkillSummary {
  name: string;
  description: string;
  /** Precedence for one name: `personal` (this user) > `tenant` (admin) > `bundled` (ships with the app). */
  source: "bundled" | Scope;
}

export interface Skill extends SkillSummary {
  instructions: string;
}

export interface Memory {
  id: string;
  content: string;
  /** `tenant`: shared with everyone in the tenant (admins manage it); `personal`: only this user. */
  scope: Scope;
  createdAt: string;
}

/** A remote MCP server, tenant-wide or personal. Header values are write-only: the API returns only their names. */
export interface McpServer {
  name: string;
  scope: Scope;
  /** Empty for tenant servers when the viewer isn't an admin (the URL may carry an API key). */
  url: string;
  enabled: boolean;
  headerNames: string[];
  updatedAt: string;
  /** Result of the last connection attempt; absent if not tried yet (or disabled). */
  status?: McpServerStatus;
}

export type McpServerStatus = { ok: true; tools: string[] } | { ok: false; error: string };

export interface DocumentSummary {
  id: string;
  title: string;
  chunks: number;
  scope: Scope;
  createdAt: string;
}

/** "Můj profil": how the agent should treat this user. */
export interface UserSettings {
  address: "auto" | "ty" | "vy";
  language: "auto" | "cs" | "sk";
  /** Appended to e-mails, quotes and other texts written on the user's behalf. */
  signature: string;
  /** The user's own standing instructions for the agent. */
  instructions: string;
}

/** A secret without its value: values are write-only and never leave the server. */
export interface SecretSummary {
  name: string;
  scope: Scope;
  /** Hosts the secret may be sent to (`api.example.com` or `*.example.com`). */
  allowedHosts: string[];
  description: string;
  updatedAt: string;
}
