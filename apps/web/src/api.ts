import type {
  AdminUser,
  AssistantProfile,
  AssistantProfiles,
  BuiltinTool,
  DirectoryUser,
  DocumentSummary,
  FileEntry,
  FileScope,
  FileSearchHit,
  Inquiry,
  Integration,
  InviteResult,
  McpServer,
  McpServerStatus,
  Memory,
  MeResponse,
  Persona,
  Guard,
  Guards,
  LogRecord,
  MetricInfo,
  MetricSeries,
  SpanRecord,
  TelemetryFacets,
  TraceSummary,
  SystemDefaults,
  PublicAssistantSettings,
  PublishResult,
  RunEvent,
  Schedule,
  ScheduleInput,
  Scope,
  SecretSummary,
  SecurityOverview,
  SiteTarget,
  Skill,
  SkillSummary,
  SocialProvider,
  TenantDetail,
  TenantFeatures,
  TenantInfo,
  TenantMember,
  TenantQuotas,
  TenantSummary,
  TenantUsage,
  ThreadMessage,
  ThreadSummary,
  UserProfile,
  UserSettings,
  WebStats,
  DbColumnType,
  DbQueryResult,
  DbRows,
  DbTable,
} from "@osiris/shared";
import type { startRegistration } from "@simplewebauthn/browser";
import { getAccessToken, login } from "./auth.ts";

type PasskeyCreationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";
let tenantId: string | undefined;

export const setTenant = (id: string) => {
  tenantId = id;
};
export const getTenant = () => tenantId;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) {
    await login();
    throw new Error("Not logged in");
  }
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(tenantId ? { "x-tenant-id": tenantId } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) await login();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; user?: Record<string, unknown> } | null;
    // A refused account comes with who is signed in and which claims they have, to see what to fix.
    const user = body?.user
      ? "\n\n" + Object.entries(body.user).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") || "—" : (v ?? "—")}`).join("\n")
      : "";
    throw Object.assign(new Error((body?.error ?? `HTTP ${res.status}`) + user), { status: res.status });
  }
  return res;
}

const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;

export interface DbColumnInput {
  name: string;
  type: DbColumnType;
  required?: boolean;
  unique?: boolean;
  references?: string | null;
}

export interface DbTableChange {
  description?: string;
  rename?: string;
  addColumns?: DbColumnInput[];
  renameColumns?: { from: string; to: string }[];
  dropColumns?: string[];
}

/** A file the API addresses by scope and path; temp files also by the thread they belong to. */
export interface FileRef {
  scope: FileScope;
  path: string;
  thread?: string;
}

const docPath = (id: string) => id.split("/").map(encodeURIComponent).join("/");

/** Query values as strings, empty ones left out. */
const strings = (q: Record<string, string | number | boolean | undefined>) =>
  Object.fromEntries(Object.entries(q).flatMap(([k, v]) => (v === undefined || v === "" || v === false ? [] : [[k, String(v)]])));

const query = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

/** Saves a downloaded file through a temporary link. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const api = {
  me: () => json<MeResponse>("/me"),
  tenant: () => json<TenantInfo>("/tenant"),
  threads: () => json<ThreadSummary[]>("/threads"),
  createThread: () => json<{ id: string }>("/threads", { method: "POST" }),
  deleteThread: (id: string) => request(`/threads/${id}`, { method: "DELETE" }),
  messages: (id: string) => json<ThreadMessage[]>(`/threads/${id}/messages`),
  documents: () => json<DocumentSummary[]>("/knowledge/documents"),
  addDocument: (title: string, content: string, folder?: string) =>
    json<DocumentSummary>("/knowledge/documents", { method: "POST", body: JSON.stringify({ title, content, folder }) }),
  /** Ids may hold folders (public/cenik.md): each segment is encoded, the slashes stay. */
  document: (id: string) => json<{ id: string; title: string; content: string; updatedAt: string }>(`/knowledge/documents/${docPath(id)}`),
  saveDocument: (id: string, title: string, content: string) =>
    json<unknown>(`/knowledge/documents/${docPath(id)}`, { method: "PUT", body: JSON.stringify({ title, content }) }),
  deleteDocument: (id: string) => request(`/knowledge/documents/${docPath(id)}`, { method: "DELETE" }),
  skills: (scope: Scope) => json<SkillSummary[]>(`/skills?scope=${scope}`),
  skill: (name: string, scope: Scope) => json<Skill>(`/skills/${name}?scope=${scope}`),
  saveSkill: (name: string, description: string, instructions: string, scope: Scope) =>
    json<Skill>(`/skills/${name}`, { method: "PUT", body: JSON.stringify({ description, instructions, scope }) }),
  deleteSkill: (name: string, scope: Scope) => request(`/skills/${name}?scope=${scope}`, { method: "DELETE" }),
  mcpServers: () => json<McpServer[]>("/mcp-servers"),
  saveMcpServer: (name: string, body: { url: string; enabled: boolean; auth: McpServer["auth"]; headers?: Record<string, string>; scope: Scope }) =>
    request(`/mcp-servers/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteMcpServer: (name: string, scope: Scope) => request(`/mcp-servers/${name}?scope=${scope}`, { method: "DELETE" }),
  signInMcpServer: (name: string, scope: Scope) =>
    json<{ authorizationUrl: string | null }>(`/mcp-servers/${encodeURIComponent(name)}/sign-in?scope=${scope}`, { method: "POST" }),
  finishMcpSignIn: (body: { state: string; code: string; iss?: string }) =>
    json<{ name: string; scope: Scope }>("/mcp-oauth/callback", { method: "POST", body: JSON.stringify(body) }),
  testMcpServer: (name: string, scope: Scope) =>
    json<McpServerStatus>(`/mcp-servers/${name}/test?scope=${scope}`, { method: "POST" }),
  settings: () => json<UserSettings>("/settings"),
  saveSettings: (settings: UserSettings) => json<UserSettings>("/settings", { method: "PUT", body: JSON.stringify(settings) }),
  memories: () => json<Memory[]>("/memories"),
  addMemory: (content: string, scope: Scope) =>
    json<Memory>("/memories", { method: "POST", body: JSON.stringify({ content, scope }) }),
  deleteMemory: (id: string, scope: Scope) => request(`/memories/${id}?scope=${scope}`, { method: "DELETE" }),
  secrets: () => json<SecretSummary[]>("/secrets"),
  saveSecret: (name: string, body: { value?: string; allowedHosts: string[]; description: string; scope: Scope }) =>
    request(`/secrets/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSecret: (name: string, scope: Scope) => request(`/secrets/${name}?scope=${scope}`, { method: "DELETE" }),
  files: (scope: FileScope, dir = "", thread?: string) => json<FileEntry[]>(`/files?${query({ scope, path: dir || undefined, thread })}`),
  searchFiles: (q: string, scope?: FileScope) => json<FileSearchHit[]>(`/files/search?${query({ q, scope })}`),
  downloadFile: async ({ scope, path, thread }: FileRef) => (await request(`/files/content?${query({ scope, path, thread })}`)).blob(),
  uploadFile: ({ scope, path, thread }: FileRef, file: Blob, overwrite = false) =>
    json<FileEntry>(`/files/content?${query({ scope, path, thread, overwrite: overwrite ? "true" : undefined })}`, {
      method: "PUT",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream" },
    }),
  makeDir: (ref: FileRef) => json<FileEntry>("/files/dir", { method: "POST", body: JSON.stringify(ref) }),
  moveFile: (from: FileRef, to: FileRef) => json<FileEntry>("/files/move", { method: "POST", body: JSON.stringify({ from, to }) }),
  deleteFile: ({ scope, path, thread }: FileRef) => request(`/files?${query({ scope, path, thread })}`, { method: "DELETE" }),

  profile: () => json<UserProfile>("/me/profile"),
  saveProfile: (changes: { firstName?: string; lastName?: string; email?: string }) =>
    json<UserProfile>("/me/profile", { method: "PATCH", body: JSON.stringify(changes) }),
  savePicture: (image: Blob) => request("/me/picture", { method: "PUT", body: image, headers: { "content-type": image.type } }),
  tools: () => json<BuiltinTool[]>("/tools"),
  db: {
    tables: () => json<DbTable[]>("/database/tables"),
    createTable: (t: { name: string; description: string; columns: DbColumnInput[] }) =>
      json<DbTable>("/database/tables", { method: "POST", body: JSON.stringify(t) }),
    alterTable: (name: string, change: DbTableChange) => json<DbTable>(`/database/tables/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(change) }),
    dropTable: (name: string) => request(`/database/tables/${encodeURIComponent(name)}`, { method: "DELETE" }),
    rows: (name: string, q: { limit?: number; offset?: number; order?: string; desc?: boolean; search?: string }) =>
      json<DbRows>(`/database/tables/${encodeURIComponent(name)}/rows?${query(strings(q))}`),
    insert: (name: string, rows: Record<string, unknown>[]) =>
      json<{ ids: number[] }>(`/database/tables/${encodeURIComponent(name)}/rows`, { method: "POST", body: JSON.stringify({ rows }) }),
    update: (name: string, id: number, values: Record<string, unknown>) =>
      request(`/database/tables/${encodeURIComponent(name)}/rows/${id}`, { method: "PATCH", body: JSON.stringify(values) }),
    delete: (name: string, id: number) => request(`/database/tables/${encodeURIComponent(name)}/rows/${id}`, { method: "DELETE" }),
    query: (sql: string) => json<DbQueryResult>("/database/query", { method: "POST", body: JSON.stringify({ sql }) }),
  },
  usage: () => json<TenantUsage>("/usage"),
  publicAssistants: () => json<PublicAssistantSettings[]>("/public-assistants"),
  savePublicAssistant: ({ name, ...settings }: PublicAssistantSettings) =>
    json<PublicAssistantSettings>(`/public-assistants/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(settings) }),
  deletePublicAssistant: (name: string) => request(`/public-assistants/${encodeURIComponent(name)}`, { method: "DELETE" }),
  guards: () => json<Guards>("/guards"),
  /** `level` user (the caller's own), tenant or assistant (with `assistant`). */
  saveGuard: (level: "user" | "tenant" | "assistant", { name, ...body }: Guard, assistant?: string) =>
    json<Guard>(`/guards/${level}/${encodeURIComponent(name)}${assistant ? `?${query({ assistant })}` : ""}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteGuard: (level: "user" | "tenant" | "assistant", name: string, assistant?: string) =>
    request(`/guards/${level}/${encodeURIComponent(name)}${assistant ? `?${query({ assistant })}` : ""}`, { method: "DELETE" }),
  inquiries: () => json<Inquiry[]>("/inquiries"),
  setInquiryStatus: (id: string, status: Inquiry["status"]) =>
    request(`/inquiries/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  inquiryMessages: (id: string) => json<ThreadMessage[]>(`/inquiries/${encodeURIComponent(id)}/messages`),
  integrations: () => json<Integration[]>("/integrations"),
  connectIntegration: (provider: Integration["provider"]) =>
    json<{ authorizationUrl: string }>(`/integrations/${provider}/connect`, { method: "POST" }),
  disconnectIntegration: (provider: Integration["provider"]) => request(`/integrations/${provider}`, { method: "DELETE" }),
  finishIntegration: (body: { state: string; code: string }) =>
    json<{ provider: Integration["provider"]; account: string | null }>("/integrations/callback", { method: "POST", body: JSON.stringify(body) }),
  /** With `assistant`, also that public assistant's persona and rules (admins). */
  assistant: (assistant?: string) => json<AssistantProfiles>(`/assistant${assistant ? `?${query({ assistant })}` : ""}`),
  saveAssistant: (scope: Scope | "public", profile: AssistantProfile, assistant?: string) =>
    json<AssistantProfile>(`/assistant?${query({ scope, assistant })}`, { method: "PUT", body: JSON.stringify(profile) }),
  generatePersona: (character: string, source: string) =>
    json<Persona>("/assistant/persona", { method: "POST", body: JSON.stringify({ character, source }) }),
  saveTenantLogo: (image: Blob) => request("/tenant/logo", { method: "PUT", body: image, headers: { "content-type": image.type } }),
  startPhone: (phone: string) => json<UserProfile>("/me/phone", { method: "POST", body: JSON.stringify({ phone }) }),
  removePhone: () => request("/me/phone", { method: "DELETE" }),
  security: {
    get: () => json<SecurityOverview>("/me/security"),
    setPassword: (password: string, current?: string) =>
      json<SecurityOverview>("/me/security/password", { method: "PUT", body: JSON.stringify({ password, current }) }),
    removePassword: () => json<SecurityOverview>("/me/security/password", { method: "DELETE" }),
    passkeyOptions: () => json<PasskeyCreationOptions>("/me/security/passkeys/options", { method: "POST" }),
    addPasskey: (response: unknown, name: string) => json<SecurityOverview>("/me/security/passkeys", { method: "POST", body: JSON.stringify({ response, name }) }),
    renamePasskey: (id: string, name: string) =>
      json<SecurityOverview>(`/me/security/passkeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    removePasskey: (id: string) => json<SecurityOverview>(`/me/security/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
    startTotp: () => json<{ secret: string; url: string }>("/me/security/totp", { method: "POST" }),
    confirmTotp: (code: string) =>
      json<{ recoveryCodes: string[]; security: SecurityOverview }>("/me/security/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }),
    disableTotp: (code: string) => json<SecurityOverview>("/me/security/totp", { method: "DELETE", body: JSON.stringify({ code }) }),
    newRecoveryCodes: (code: string) =>
      json<{ recoveryCodes: string[]; security: SecurityOverview }>("/me/security/recovery-codes", { method: "POST", body: JSON.stringify({ code }) }),
    linkSocial: (provider: SocialProvider) => json<{ url: string }>(`/me/security/social/${provider}`, { method: "POST" }),
    unlinkSocial: (provider: SocialProvider) => json<SecurityOverview>(`/me/security/social/${provider}`, { method: "DELETE" }),
  },

  members: () => json<TenantMember[]>("/members"),
  invite: (body: { email: string; firstName: string; lastName: string; role: "admin" | "member" }) =>
    json<InviteResult>("/members", { method: "POST", body: JSON.stringify(body) }),
  setMemberRole: (userId: string, role: "admin" | "member") =>
    request(`/members/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ role }) }),
  removeMember: (userId: string) => request(`/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  loginLink: (userId: string) => json<{ loginLink: string }>(`/members/${encodeURIComponent(userId)}/login-link`, { method: "POST" }),

  schedules: (all = false) => json<Schedule[]>(`/schedules${all ? "?all=true" : ""}`),
  createSchedule: (input: ScheduleInput) => json<Schedule>("/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, input: Partial<ScheduleInput>) => json<Schedule>(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  runSchedule: (id: string) => json<Schedule>(`/schedules/${id}/run`, { method: "POST" }),
  deleteSchedule: (id: string) => request(`/schedules/${id}`, { method: "DELETE" }),

  siteTargets: () => json<SiteTarget[]>("/site-targets"),
  vitepressSites: () => json<{ sites: string[]; builder: boolean }>("/vitepress-sites"),
  createVitepressSite: (name: string) => json<{ name: string }>("/vitepress-sites", { method: "POST", body: JSON.stringify({ name }) }),
  buildVitepressSite: (name: string) => json<{ message: string }>(`/vitepress-sites/${encodeURIComponent(name)}/build`, { method: "POST" }),
  deleteVitepressSite: (name: string) => request(`/vitepress-sites/${encodeURIComponent(name)}`, { method: "DELETE" }),
  saveSiteTarget: (
    name: string,
    body: { host: string; port: number; username: string; remoteDir: string; auth: SiteTarget["auth"]; secret?: string },
  ) => request(`/site-targets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSiteTarget: (name: string) => request(`/site-targets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  testSiteTarget: (name: string) => json<{ entries: string[] }>(`/site-targets/${encodeURIComponent(name)}/test`, { method: "POST" }),
  publishSite: (name: string, dir = "www") =>
    json<PublishResult>(`/site-targets/${encodeURIComponent(name)}/publish`, { method: "POST", body: JSON.stringify({ dir }) }),

  admin: {
    tenants: () => json<TenantSummary[]>("/admin/tenants"),
    tenant: (id: string) => json<TenantDetail>(`/admin/tenants/${id}`),
    createTenant: (id: string, name: string) =>
      json<TenantSummary>("/admin/tenants", { method: "POST", body: JSON.stringify({ id, name }) }),
    updateTenant: (
      id: string,
      body: { name?: string; features?: Partial<TenantFeatures>; idleMinutes?: number; storageGb?: number; disabledTools?: string[]; quotas?: Partial<TenantQuotas> },
    ) =>
      request(`/admin/tenants/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteTenant: (id: string) => request(`/admin/tenants/${id}`, { method: "DELETE" }),
    setMember: (id: string, userId: string, role: "admin" | "member") =>
      request(`/admin/tenants/${id}/members/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ role }) }),
    removeMember: (id: string, userId: string) =>
      request(`/admin/tenants/${id}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    /** The cluster's telemetry in ClickHouse; times in epoch ms. */
    telemetry: {
      facets: (q: { from: number; to: number }) => json<TelemetryFacets>(`/admin/telemetry/facets?${query(strings(q))}`),
      logs: (q: { from: number; to: number; service?: string; namespace?: string; severity?: string; q?: string; traceId?: string; limit?: number }) =>
        json<LogRecord[]>(`/admin/telemetry/logs?${query(strings(q))}`),
      traces: (q: { from: number; to: number; service?: string; q?: string; minMs?: number; errors?: boolean }) =>
        json<TraceSummary[]>(`/admin/telemetry/traces?${query(strings(q))}`),
      trace: (id: string) => json<SpanRecord[]>(`/admin/telemetry/traces/${id}`),
      web: (q: { site?: string; from: number; to: number }) => json<WebStats>(`/admin/telemetry/web?${query(strings(q))}`),
      metrics: (q: { from: number; to: number; q?: string }) => json<MetricInfo[]>(`/admin/telemetry/metrics?${query(strings(q))}`),
      series: (q: { from: number; to: number; name: string; type: MetricInfo["type"]; groupBy?: string; service?: string }) =>
        json<{ step: number; series: MetricSeries[] }>(`/admin/telemetry/series?${query(strings(q))}`),
    },
    defaults: () => json<SystemDefaults>("/admin/defaults"),
    saveDefaults: (d: SystemDefaults) => json<SystemDefaults>("/admin/defaults", { method: "PUT", body: JSON.stringify(d) }),
    guards: () => json<Guard[]>("/admin/guards"),
    saveGuard: ({ name, ...body }: Guard) => json<Guard>(`/admin/guards/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) }),
    deleteGuard: (name: string) => request(`/admin/guards/${encodeURIComponent(name)}`, { method: "DELETE" }),
    users: () => json<AdminUser[]>("/admin/users"),
    createUser: (body: { email: string; firstName: string; lastName: string }) =>
      json<{ userId: string; loginLink: string }>("/admin/users", { method: "POST", body: JSON.stringify(body) }),
    updateUser: (id: string, body: { firstName?: string; lastName?: string; email?: string; disabled?: boolean; systemAdmin?: boolean }) =>
      request(`/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
    loginLink: (id: string) => json<{ loginLink: string }>(`/admin/users/${encodeURIComponent(id)}/login-link`, { method: "POST" }),
    invite: (id: string, body: { email: string; firstName: string; lastName: string; role: "admin" | "member" }) =>
      json<InviteResult>(`/admin/tenants/${id}/members`, { method: "POST", body: JSON.stringify(body) }),
    backup: (id: string) => request(`/admin/tenants/${id}/backups`, { method: "POST" }),
    resetSecondFactor: (userId: string) => request(`/admin/users/${encodeURIComponent(userId)}/second-factor`, { method: "DELETE" }),
  },

  /** Starts a run and yields its server-sent events. */
  async *run(threadId: string, message: string, signal: AbortSignal): AsyncGenerator<RunEvent> {
    yield* readEvents(await request(`/threads/${threadId}/runs`, { method: "POST", body: JSON.stringify({ message }), signal }));
  },
};

/** The server-sent events of a run's response. */
export async function* readEvents(res: Response): AsyncGenerator<RunEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop()!;
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as RunEvent;
    }
  }
}
