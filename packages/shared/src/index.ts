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

/** Identity and memberships come from PocketID custom claims (`role`, `tenant`, `tenant-admin`); see apps/api/src/auth/. */
export interface MeResponse {
  user: { id: string; email: string | null; name: string | null; phone: string | null; picture: string | null };
  /** Claim `role=osiris-admin`: admin of every tenant, manages tenants. */
  systemAdmin: boolean;
  tenants: { id: string; name: string; role: Role; logo: string | null }[];
}

/** What a system admin can switch on or off per tenant. */
export const FEATURES = ["knowledge", "skills", "memory", "mcp", "http", "whatsapp", "files", "scheduler", "sites"] as const;
export type Feature = (typeof FEATURES)[number];
export type TenantFeatures = Record<Feature, boolean>;

/** The active tenant (`GET /api/tenant`). */
export interface TenantInfo {
  id: string;
  name: string;
  role: Role;
  features: TenantFeatures;
  /** Public URL of the tenant's logo, or null. */
  logo: string | null;
}

/** A tenant as system admins see it (`/api/admin/tenants`). */
export interface TenantSummary {
  id: string;
  name: string;
  logo: string | null;
  /** Users whose claim `tenant` or `tenant-admin` names the tenant. */
  members: number;
}

export interface TenantMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: Role;
}

export interface TenantDetail extends TenantSummary {
  features: TenantFeatures;
  memberList: TenantMember[];
  /** Minutes without activity before the tenant's runtime sleeps; 0 = always on. */
  idleMinutes: number;
  /** Size of the tenant's volume (database and files). */
  storageGb: number;
  backups: { key: string; bytes: number; reason: string; createdAt: string }[];
}

/** A PocketID user, for adding members to a tenant. */
export interface DirectoryUser {
  id: string;
  name: string | null;
  email: string | null;
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

/** A scheduled task: a prompt the agent runs on the owner's behalf at set times (`/api/schedules`). */
export interface Schedule {
  id: string;
  ownerId: string;
  ownerName: string | null;
  title: string;
  prompt: string;
  /** Cron expression (5 fields) for repeating tasks, or null for a one-off at `runAt`. */
  cron: string | null;
  runAt: string | null;
  timezone: string;
  /** Where the result goes; WhatsApp results also stay in a web thread. */
  delivery: "web" | "whatsapp";
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "done" | "failed" | "skipped" | null;
  lastError: string | null;
  lastThreadId: string | null;
}

export interface ScheduleInput {
  title: string;
  prompt: string;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string;
  delivery?: "web" | "whatsapp";
  enabled?: boolean;
}

/** A custom domain for the tenant's site (`/api/domains`); served once DNS proves it's the tenant's. */
export interface SiteDomain {
  domain: string;
  status: "pending" | "verified" | "failed";
  /** TXT record `_osiris-challenge.<domain>` must hold this value. */
  token: string;
  error: string | null;
  releaseId: string | null;
  verifiedAt: string | null;
  /** What the domain must point to: A records to these IPs, or a CNAME to `cname`. */
  target: { ips: string[]; cname: string | null };
}

export interface SiteRelease {
  id: string;
  domain: string;
  files: number;
  bytes: number;
  createdBy: string | null;
  createdAt: string;
  current: boolean;
}

/** The user's PocketID profile, edited from Osiris (`/api/me/profile`). */
export interface UserProfile {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  /** A pending phone verification: send `OVERENI <code>` from the phone to `whatsappNumber`. */
  phoneChallenge?: { phone: string; code: string; whatsappNumber: string | null; expiresAt: string };
}

export const SOCIAL_PROVIDERS = ["google", "facebook", "microsoft", "seznam"] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** How the user signs in (`/api/me/security`); secrets never leave the server. */
export interface SecurityOverview {
  password: boolean;
  /** An authenticator app (TOTP) is the second factor after a password or social sign-in. */
  totp: boolean;
  recoveryCodes: number;
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  social: { provider: SocialProvider; email: string | null; linkedAt: string }[];
  /** Social sign-ins this deployment offers. */
  providers: SocialProvider[];
}

/** One step of signing in (`/auth/interaction/:uid/state`), for the sign-in screen. */
export interface SignInState {
  step: "login" | "second-factor";
  methods: { passkey: boolean; emailLink: boolean; social: SocialProvider[] };
}

/** Result of adding someone to a tenant by email (`POST /api/members`). */
export interface InviteResult {
  userId: string;
  created: boolean;
  /** One-time sign-in link for a new user, to pass on to them. */
  loginLink?: string;
}

/** Tenant files (`/api/files`): shared by the tenant (admins write), the user's own, or one thread's temporary files. */
export type FileScope = "tenant" | "personal" | "temp";

export interface FileEntry {
  scope: FileScope;
  /** Relative to the scope root, `/`-separated. */
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  mime: string | null;
  modifiedAt: string;
}
export * from "./files.ts";
