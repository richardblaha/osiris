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
  InviteResult,
  McpServer,
  McpServerStatus,
  Memory,
  MeResponse,
  Persona,
  RunEvent,
  Schedule,
  ScheduleInput,
  Scope,
  SecretSummary,
  SecurityOverview,
  SiteDomain,
  SiteRelease,
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
} from "@osiris/shared";
import type { startRegistration } from "@simplewebauthn/browser";
import { getAccessToken, login } from "./auth.ts";

type PasskeyCreationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];

const BASE = (import.meta.env.VITE_API_URL ?? "") + "/api";
let tenantId: string | undefined;

export const setTenant = (id: string) => {
  tenantId = id;
};

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
    throw new Error((body?.error ?? `HTTP ${res.status}`) + user);
  }
  return res;
}

const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;

/** A file the API addresses by scope and path; temp files also by the thread they belong to. */
export interface FileRef {
  scope: FileScope;
  path: string;
  thread?: string;
}

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
  addDocument: (title: string, content: string, scope: Scope) =>
    json<DocumentSummary>("/knowledge/documents", { method: "POST", body: JSON.stringify({ title, content, scope }) }),
  deleteDocument: (id: string, scope: Scope) => request(`/knowledge/documents/${id}?scope=${scope}`, { method: "DELETE" }),
  skills: (scope: Scope) => json<SkillSummary[]>(`/skills?scope=${scope}`),
  skill: (name: string, scope: Scope) => json<Skill>(`/skills/${name}?scope=${scope}`),
  saveSkill: (name: string, description: string, instructions: string, scope: Scope) =>
    json<Skill>(`/skills/${name}`, { method: "PUT", body: JSON.stringify({ description, instructions, scope }) }),
  deleteSkill: (name: string, scope: Scope) => request(`/skills/${name}?scope=${scope}`, { method: "DELETE" }),
  mcpServers: () => json<McpServer[]>("/mcp-servers"),
  saveMcpServer: (name: string, body: { url: string; enabled: boolean; headers?: Record<string, string>; scope: Scope }) =>
    request(`/mcp-servers/${name}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteMcpServer: (name: string, scope: Scope) => request(`/mcp-servers/${name}?scope=${scope}`, { method: "DELETE" }),
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
  usage: () => json<TenantUsage>("/usage"),
  assistant: () => json<AssistantProfiles>("/assistant"),
  saveAssistant: (scope: Scope, profile: AssistantProfile) =>
    json<AssistantProfile>(`/assistant?scope=${scope}`, { method: "PUT", body: JSON.stringify(profile) }),
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

  domains: () => json<SiteDomain[]>("/domains"),
  addDomain: (domain: string) => json<SiteDomain>("/domains", { method: "POST", body: JSON.stringify({ domain }) }),
  verifyDomain: (domain: string) => json<SiteDomain>(`/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" }),
  removeDomain: (domain: string) => request(`/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }),
  releases: (domain: string) => json<SiteRelease[]>(`/sites/releases?domain=${encodeURIComponent(domain)}`),
  activateRelease: (domain: string, id: string) => request(`/sites/releases/${id}/activate`, { method: "POST", body: JSON.stringify({ domain }) }),
  publishSite: (body: { scope: FileScope; dir: string; domain: string }) =>
    json<SiteRelease>("/site-publish", { method: "POST", body: JSON.stringify(body) }),

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
    guards: () => json<{ guards: string }>("/admin/guards"),
    saveGuards: (guards: string) => request("/admin/guards", { method: "PUT", body: JSON.stringify({ guards }) }),
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
    const res = await request(`/threads/${threadId}/runs`, { method: "POST", body: JSON.stringify({ message }), signal });
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
  },
};
