import { standardAccountSchema } from "@osiris/core/integrations/standard.ts";
import { randomUUID } from "node:crypto";
import type { AssistantProfile, AssistantProfiles, BuiltinTool, Guard, Guards, Feature, FileEntry, FileScope, FileSearchHit, Inquiry, Integration, McpServer, PublicAssistantSettings, PublicInfo, ThreadMessage, Persona, PublishResult, Scope, SecretSummary, SiteTarget, Skill, TenantUsage, UsageBreakdown, UserSettings } from "@osiris/shared";
import { GUARD_NAME, PUBLIC_ASSISTANT_NAME, PUBLIC_TOOLS } from "@osiris/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { describePersona, hasRules } from "@osiris/core/agent/assistant.ts";
import { publicProfile } from "@osiris/core/public/assistant.ts";
import { buildSite, createSite, describeBuild, listSites, SITE_NAME, VITEPRESS_DIR } from "@osiris/core/agent/tools/site.ts";
import { isGuardPath, type GuardOwner } from "@osiris/core/agent/guards.ts";
import { publishFolder as publishSftp, testTarget } from "@osiris/core/sites/sftp.ts";
import { slug } from "@osiris/core/files/sync.ts";
import { DOCUMENT_ID } from "@osiris/core/rag/store.ts";
import { TOKENS_EXHAUSTED, USER_TOKENS_EXHAUSTED } from "@osiris/core/agent/graph.ts";
import { SKILL_NAME } from "@osiris/core/agent/skills.ts";
import { FileError, type FileErrorCode, type FileLocation } from "@osiris/core/files/store.ts";
import { streamRun, toThreadMessages } from "@osiris/core/agent/run.ts";
import { MCP_SERVER_NAME, McpNameTakenError, mcpOwner } from "@osiris/core/mcp/store.ts";
import { UnsafeUrlError } from "@osiris/core/mcp/url.ts";
import * as threads from "@osiris/core/repo/threads.ts";
import { HOST_PATTERN, SECRET_NAME, SecretUseError } from "@osiris/core/vault/template.ts";
import { secretOwner } from "@osiris/core/vault/vault.ts";
import type { Tenant } from "@osiris/core/tenants/tenant.ts";
import type { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import type { Activity } from "./activity.ts";
import { publicAuth, userAuth, type AuthEnv, type RequestContext } from "./auth.ts";
import { createInternalRoutes } from "./internal.ts";
import { databaseRoutes } from "./database.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";


const runBody = z.object({ message: z.string().trim().min(1).max(20_000) });
// Everything is the tenant's; "personal" is gone (only the user's profile is theirs).
const scope = z.literal("tenant").default("tenant");
const documentBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(500_000),
  /** New documents: a folder, e.g. public (a public assistant may get just that folder). */
  folder: z.string().trim().max(200).optional(),
});
const skillBody = z.object({
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(50_000),
  scope,
});
const mcpServerBody = z.object({
  url: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(true),
  // headers: static headers (sealed); oauth: the owner signs in at the provider instead.
  auth: z.enum(["headers", "oauth"]).default("headers"),
  // Omitted = keep the stored headers. Values are secrets (tokens) and are never returned.
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Neplatný název hlavičky"), z.string().max(4000).regex(/^[^\r\n]*$/))
    .optional(),
  scope,
});
const settingsBody = z.object({
  address: z.enum(["auto", "ty", "vy"]),
  language: z.enum(["auto", "cs", "sk"]),
  signature: z.string().trim().max(1000),
  instructions: z.string().trim().max(4000),
});
const personaBody = z.object({ character: z.string().trim().min(1).max(100), source: z.string().trim().max(150) });
const profileBody = z.object({
  persona: personaBody.extend({ description: z.string().trim().min(1).max(2000) }).nullable(),
});
const guardBody = z.object({ description: z.string().trim().max(300).default(""), rule: z.string().trim().min(1).max(4000) });
/** A knowledge base document or folder, relative to knowledge/: plain segments only. */
const knowledgePath = z
  .string()
  .max(512)
  .refine((p) => p.split("/").every((seg) => seg && seg !== "." && seg !== ".." && !seg.startsWith(".")), "Neplatná cesta ve znalostní bázi");
const publicSettingsBody = z.object({
  enabled: z.boolean(),
  title: z.string().trim().max(120),
  greeting: z.string().trim().max(500),
  knowledge: z.array(knowledgePath).max(200),
  memories: z.array(z.string().max(100)).max(100),
  skills: z.array(z.string().regex(SKILL_NAME)).max(100),
  tools: z.array(z.enum(PUBLIC_TOOLS)).max(PUBLIC_TOOLS.length),
  tokensPerMonth: z.number().int().min(0).max(1e12).nullable(),
});
const siteTargetBody = z.object({
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "Server: název nebo IP adresa"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(100),
  remoteDir: z.string().trim().min(1).max(500).regex(/^\//, "Cílová složka musí být absolutní cesta, např. /var/www/firma"),
  auth: z.enum(["password", "key"]),
  // Omitted = keep the stored one. Never returned.
  secret: z.string().min(1).max(20_000).optional(),
});
const oauthCallbackBody = z.object({ state: z.string().min(16).max(200), code: z.string().min(1).max(4000), iss: z.string().max(2000).optional() });
const memoryBody = z.object({ content: z.string().trim().min(1).max(500), scope });
const secretBody = z.object({
  // Omitted = keep the stored value (e.g. when only the hosts change). Never returned.
  value: z.string().min(1).max(10_000).optional(),
  allowedHosts: z
    .array(z.string().trim().toLowerCase().regex(HOST_PATTERN, "Neplatná doména (např. api.example.com nebo *.example.com)"))
    .min(1, "Zadej aspoň jednu povolenou doménu")
    .max(20),
  description: z.string().trim().max(300).default(""),
  scope,
});

/** Which settings pages need which feature. Secrets serve both http_request and MCP. */
const FEATURE_ROUTES: [string, Feature[]][] = [
  ["/knowledge", ["knowledge"]],
  ["/skills", ["skills"]],
  ["/memories", ["memory"]],
  ["/mcp-servers", ["mcp"]],
  ["/mcp-oauth", ["mcp"]],
  ["/integrations", ["integrations"]],
  ["/public-assistants", ["public"]],
  ["/inquiries", ["public"]],
  ["/secrets", ["http", "mcp"]],
  ["/files", ["files"]],
  ["/site-targets", ["sites", "files"]],
  ["/vitepress-sites", ["sites"]],
  ["/database", ["database"]],
];

const FILE_ERROR_STATUS: Record<FileErrorCode, 400 | 404 | 409 | 413 | 415 | 507> = {
  invalid: 400,
  not_found: 404,
  exists: 409,
  too_large: 413,
  type: 415,
  quota: 507,
};
const fileScope = z.enum(["tenant", "temp"]).default("tenant");
const fileRef = z.object({ scope: fileScope, path: z.string().min(1).max(512), thread: z.string().max(100).optional() });
const moveBody = z.object({ from: fileRef, to: fileRef });

export interface RuntimeAppDeps {
  tenant: Tenant;
  verifier: InternalVerifier;
  activity: Activity;
  /** Takes a snapshot and uploads it (operator before sleep, control on demand). */
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  /** Members and scheduled tasks, which control counts, for the quota meters. */
  counts?: () => Promise<{ members: number; schedules: number; dashboards: number }>;
}

/**
 * The tenant runtime's API. Every request carries an internal token: user calls come from the gateway (which verified
 * the PocketID token and the membership), scheduled runs and WhatsApp messages from control, activity checks and
 * snapshots from the operator. The tenant is fixed: this process serves one tenant and refuses tokens for another.
 */
export function createRuntimeApp({ tenant, verifier, activity, snapshot, counts }: RuntimeAppDeps) {
  // One run per thread at a time. In-process is enough: a tenant has exactly one runtime.
  const activeRuns = new Set<string>();

  /** Runs the agent on one message of a thread and streams its events (web and public chats). */
  const runThread = async (c: Context, ctx: RequestContext, id: string, message: string, assistant?: string) => {
    const { tenant, user, role, channel } = ctx;
    const runKey = `${tenant.id}/${id}`;
    if (activeRuns.has(runKey)) throw new HTTPException(409, { message: "A run is already in progress for this thread" });

    activeRuns.add(runKey);
    activity.activeRuns++;
    await threads.touchThread(tenant.db, id, message);
    const abort = new AbortController();
    return streamSSE(c, async (sse) => {
      sse.onAbort(() => abort.abort());
      try {
        const runCtx = { thread_id: id, tenant_id: tenant.id, user_id: user.sub, role, channel, assistant, user_name: user.name ?? undefined };
        // With rules, the answer is sent only after the output check (the public assistant's rules too).
        const guarded = channel === "public" ? true : hasRules(await tenant.rules(user.sub));
        for await (const event of streamRun(tenant.graph, runCtx, message, abort.signal, { guarded })) {
          await sse.writeSSE({ data: JSON.stringify(event) });
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("Run failed", { tenantId: tenant.id, threadId: id, err });
          await sse.writeSSE({ data: JSON.stringify({ type: "error", message: "Agent run failed" }) });
        }
      } finally {
        activeRuns.delete(runKey);
        activity.activeRuns--;
        activity.touch();
      }
    });
  };

  const requireThread = async ({ tenant, user }: RequestContext, id: string) => {
    if (!(await threads.ownsThread(tenant.db, user.sub, id))) throw new HTTPException(404, { message: "Thread not found" });
  };
  const requireAdmin = (ctx: RequestContext) => {
    if (ctx.role !== "admin") throw new HTTPException(403, { message: "Requires admin role" });
  };
  /** Anyone may change their personal settings; tenant-wide ones need an admin. */
  /** Tenant settings (skills, MCP servers, secrets, rules) are the admins'; the knowledge base, memory and files everyone's. */
  const requireScope = (ctx: RequestContext, _scope: Scope) => requireAdmin(ctx);
  const queryScope = (value: string | undefined): Scope => {
    if (value === undefined || value === "tenant") return "tenant";
    throw new HTTPException(400, { message: "Osobní nastavení už nejsou, vše platí pro celý tenant" });
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value);
    if (!r.success) throw new HTTPException(400, { message: z.prettifyError(r.error) });
    return r.data;
  };
  const checkMcpUrl = async ({ tenant }: RequestContext, url: string) => {
    try {
      await tenant.mcp.checkUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof SecretUseError) throw new HTTPException(400, { message: err.message });
      throw err;
    }
  };
  /** The file scope a request names; temp files belong to one of the caller's threads. */
  const fileLocation = async (ctx: RequestContext, scope: FileScope, thread: string | undefined): Promise<FileLocation> => {
    if (scope === "tenant") return { scope };
    if (!thread) throw new HTTPException(400, { message: "thread is required for temp files" });
    await requireThread(ctx, thread);
    return { scope: "temp", threadId: thread };
  };
  const fileQuery = (c: { req: { query: (k: string) => string | undefined } }) =>
    parse(fileRef.partial({ path: true }), { scope: c.req.query("scope"), path: c.req.query("path"), thread: c.req.query("thread") });
  /** The tenant's files are everyone's to write, but guards/ only admins'; temp files are checked to be the caller's own thread's. */
  const requireFileWrite = (ctx: RequestContext, scope: FileScope, path: string | undefined) => {
    if (scope === "tenant" && isGuardPath(path ?? "") && ctx.role !== "admin") throw new HTTPException(403, { message: "Pravidla (guards/) mění jen správce" });
  };
  const fileErrors = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof FileError) throw new HTTPException(FILE_ERROR_STATUS[err.code], { message: err.message });
      throw err;
    }
  };

  /** Whose guards a request names: the caller's own (anyone), the tenant's or a public assistant's (admins). */
  const guardOwner = async (ctx: RequestContext, level: string, assistant: string | undefined): Promise<GuardOwner> => {
    if (level === "user") return { level: "user", userId: ctx.user.sub };
    requireAdmin(ctx);
    if (level === "tenant") return { level: "tenant" };
    if (level === "assistant") {
      const a = await ctx.tenant.publicAssistants.get(assistant ?? "");
      if (!a || a.name !== assistant) throw new HTTPException(404, { message: "Asistent neexistuje" });
      return { level: "assistant", assistant: a.name };
    }
    throw new HTTPException(400, { message: "Úroveň: user, tenant nebo assistant" });
  };

  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HTTPException(400, { message: "Skill name must be lowercase-kebab-case" });
    return name;
  };

  /** A public assistant, when the system admin allows the feature and the tenant admin switched it on. */
  const publicAssistant = async (name: string) => {
    const a = (await tenant.features.get()).public ? await tenant.publicAssistants.get(name) : null;
    return a?.enabled ? a : null;
  };
  const requirePublic = async (name: string) => {
    const a = await publicAssistant(name);
    if (!a) throw new HTTPException(404, { message: "Asistent není dostupný" });
    return a;
  };

  // The tenant's customers (anonymous): the public chat page and the website widget, through the gateway.
  const pub = new Hono<AuthEnv>()
    .use(publicAuth(verifier, tenant))
    .use(async (_c, next) => {
      activity.touch();
      await next();
    })
    .get("/:assistant/info", async (c) => {
      const a = await publicAssistant(c.req.param("assistant"));
      return c.json<PublicInfo>({ enabled: !!a, title: a?.title || tenant.id, greeting: a?.greeting ?? "" });
    })
    .post("/:assistant/threads", async (c) => {
      await requirePublic(c.req.param("assistant"));
      const { user } = c.get("ctx");
      const id = randomUUID();
      await threads.createThread(tenant.db, user.sub, id, "public");
      return c.json({ id }, 201);
    })
    .get("/:assistant/threads/:id/messages", async (c) => {
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const state = await tenant.graph.getState({ configurable: { thread_id: c.req.param("id") } });
      return c.json<ThreadMessage[]>(toThreadMessages(state.values.messages ?? []));
    })
    .post("/:assistant/threads/:id/runs", async (c) => {
      const a = await requirePublic(c.req.param("assistant"));
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const { message } = parse(z.object({ message: z.string().trim().min(1).max(2000) }), await c.req.json());
      return runThread(c, ctx, c.req.param("id"), message, a.name);
    });

  const api = new Hono<AuthEnv>()
    .use(userAuth(verifier, tenant))
    .use(async (c, next) => {
      activity.touch();
      await next();
    })
    // Settings of a feature the tenant doesn't have are refused, not just hidden in the web app.
    .use(async (c, next) => {
      const route = FEATURE_ROUTES.find(([prefix]) => c.req.path === `/api${prefix}` || c.req.path.startsWith(`/api${prefix}/`));
      if (route) {
        const on = await c.get("ctx").tenant.features.get();
        if (!route[1].some((f) => on[f])) throw new HTTPException(403, { message: "Tato funkce není pro tenant povolená" });
      }
      await next();
    })
    .route("/database", databaseRoutes())

    .get("/threads", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await threads.listThreads(tenant.db, user.sub));
    })

    .post("/threads", async (c) => {
      const { tenant, user } = c.get("ctx");
      const id = randomUUID();
      await threads.createThread(tenant.db, user.sub, id, "web");
      return c.json({ id }, 201);
    })

    .get("/threads/:id/messages", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const state = await ctx.tenant.graph.getState({ configurable: { thread_id: id } });
      return c.json(toThreadMessages(state.values.messages ?? []));
    })

    .delete("/threads/:id", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      await ctx.tenant.checkpointer.deleteThread(id);
      await threads.deleteThread(ctx.tenant.db, id);
      await ctx.tenant.files.removeTemp(id);
      return c.body(null, 204);
    })

    .post("/threads/:id/runs", async (c) => {
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const { message } = parse(runBody, await c.req.json());
      return runThread(c, ctx, c.req.param("id"), message);
    })

    // Settings come in two scopes: `tenant` (everyone in the tenant, admins only) and `personal` (the caller only).

    // The knowledge base: documents in the tenant's database (not files), indexed as they're saved.
    .get("/knowledge/documents", async (c) => c.json(await c.get("ctx").tenant.knowledge.listDocuments()))
    .post("/knowledge/documents", async (c) => {
      const { tenant } = c.get("ctx");
      const { title, content, folder } = parse(documentBody, await c.req.json());
      const base = `${folder ? `${folder}/` : ""}${slug(title)}`;
      let id = `${base}.md`;
      for (let n = 2; await tenant.knowledge.getDocument(id); n++) id = `${base}-${n}.md`;
      if (!DOCUMENT_ID.test(id)) throw new HTTPException(400, { message: "Neplatná složka: písmena, číslice, tečky a pomlčky, / mezi složkami" });
      await tenant.knowledge.putDocument(id, content, title);
      return c.json((await tenant.knowledge.listDocuments()).find((d) => d.id === id), 201);
    })
    .get("/knowledge/documents/:id{.+}", async (c) => {
      const doc = await c.get("ctx").tenant.knowledge.getDocument(c.req.param("id"));
      if (!doc) throw new HTTPException(404, { message: "Dokument neexistuje" });
      return c.json(doc);
    })
    .put("/knowledge/documents/:id{.+}", async (c) => {
      const { tenant } = c.get("ctx");
      const id = c.req.param("id");
      if (!(await tenant.knowledge.getDocument(id))) throw new HTTPException(404, { message: "Dokument neexistuje" });
      const { title, content } = parse(documentBody, await c.req.json());
      await tenant.knowledge.putDocument(id, content, title);
      return c.json(await tenant.knowledge.getDocument(id));
    })
    .delete("/knowledge/documents/:id{.+}", async (c) => {
      if (!(await c.get("ctx").tenant.knowledge.deleteDocument(c.req.param("id")))) throw new HTTPException(404, { message: "Dokument neexistuje" });
      return c.body(null, 204);
    })

    // The tenant's skills and the bundled ones it doesn't replace.
    .get("/skills", async (c) => c.json(await c.get("ctx").tenant.skills.list()))

    .get("/skills/:name", async (c) => {
      const skill = await c.get("ctx").tenant.skills.get(c.req.param("name"));
      if (!skill) throw new HTTPException(404, { message: "Skill not found" });
      return c.json<Skill>(skill);
    })

    .put("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = skillName(c.req.param("name"));
      const { scope, ...skill } = parse(skillBody, await c.req.json());
      requireScope(ctx, scope);
      await fileErrors(() => ctx.tenant.skills.put({ name, ...skill }));
      return c.json<Skill>((await ctx.tenant.skills.get(name))!);
    })

    .delete("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await fileErrors(() => ctx.tenant.skills.delete(c.req.param("name"))))) {
        throw new HTTPException(404, { message: "Skill not found" });
      }
      return c.body(null, 204);
    })

    .get("/mcp-servers", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const servers = await tenant.mcpServers.list(user.sub, { showTenantUrls: role === "admin" });
      return c.json<McpServer[]>(
        await Promise.all(
          servers.map(async (s) => ({
            ...s,
            signedIn: s.auth === "oauth" ? await tenant.mcp.signedIn(mcpOwner(s.scope, user.sub), s.name) : undefined,
            status: s.enabled ? tenant.mcp.status(mcpOwner(s.scope, user.sub)).get(s.name) : undefined,
          })),
        ),
      );
    })

    .put("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!MCP_SERVER_NAME.test(name)) throw new HTTPException(400, { message: "Server name must be lowercase-kebab-case" });
      const { scope, ...body } = parse(mcpServerBody, await c.req.json());
      requireScope(ctx, scope);
      await checkMcpUrl(ctx, body.url);
      const owner = mcpOwner(scope, ctx.user.sub);
      try {
        await ctx.tenant.mcpServers.put(name, owner, body);
      } catch (err) {
        if (err instanceof McpNameTakenError) throw new HTTPException(409, { message: err.message });
        throw err;
      }
      ctx.tenant.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    .delete("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      if (!(await ctx.tenant.mcpServers.delete(c.req.param("name"), owner))) {
        throw new HTTPException(404, { message: "MCP server not found" });
      }
      ctx.tenant.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    // Signing in to an OAuth server: the provider's URL to send the user to (null when the sign-in still holds).
    .post("/mcp-servers/:name/sign-in", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      const server = await ctx.tenant.mcpServers.get(c.req.param("name"), owner);
      if (!server) throw new HTTPException(404, { message: "MCP server not found" });
      if (server.auth !== "oauth") throw new HTTPException(400, { message: "Server se nepřihlašuje přes OAuth" });
      const url = await ctx.tenant.mcp.startSignIn(server, owner).catch((err: Error) => {
        throw new HTTPException(502, { message: `Přihlášení u poskytovatele selhalo: ${err.message}` });
      });
      return c.json({ authorizationUrl: url });
    })
    // The provider sent the user back (web app's /mcp-callback): the code becomes tokens. Only who started it finishes.
    .post("/mcp-oauth/callback", async (c) => {
      const ctx = c.get("ctx");
      const { state, code, iss } = parse(oauthCallbackBody, await c.req.json());
      const pending = await ctx.tenant.mcp.pendingSignIn(state);
      if (!pending) throw new HTTPException(400, { message: "Přihlášení vypršelo nebo už bylo dokončeno, zkus to znovu" });
      requireScope(ctx, pending.owner === "" ? "tenant" : "personal");
      if (pending.owner !== "" && pending.owner !== ctx.user.sub) throw new HTTPException(403, { message: "Přihlášení patří jinému uživateli" });
      const done = await ctx.tenant.mcp.finishSignIn(state, code, iss).catch((err: Error) => {
        throw new HTTPException(502, { message: `Přihlášení se nepodařilo dokončit: ${err.message}` });
      });
      if (!done) throw new HTTPException(400, { message: "Přihlášení vypršelo, zkus to znovu" });
      return c.json({ name: done.name, scope: done.owner === "" ? "tenant" : "personal" });
    })

    // Connects once with the stored configuration and reports the tools (or the error).
    .post("/mcp-servers/:name/test", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      const server = await ctx.tenant.mcpServers.get(c.req.param("name"), owner);
      if (!server) throw new HTTPException(404, { message: "MCP server not found" });
      return c.json(await ctx.tenant.mcp.test(server, owner));
    })

    .get("/settings", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json<UserSettings>(await tenant.settings.get(user.sub));
    })

    // The assistant's persona: the user's own and (admins) a public assistant's.
    .get("/assistant", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const assistant = c.req.query("assistant");
      const [personal, open] = await Promise.all([
        tenant.profiles.get(user.sub),
        assistant && role === "admin" ? tenant.profiles.get(publicProfile(assistant)) : undefined,
      ]);
      return c.json<AssistantProfiles>({ personal, ...(open ? { public: open } : {}) });
    })
    // ?scope=personal, or public&assistant=<name> (a public assistant's, admins). The tenant has none.
    .put("/assistant", async (c) => {
      const ctx = c.get("ctx");
      const which = c.req.query("scope");
      const profile = parse(profileBody, await c.req.json());
      if (which === "personal") {
        await ctx.tenant.profiles.put(ctx.user.sub, profile);
        return c.json<AssistantProfile>(profile);
      }
      if (which !== "public") throw new HTTPException(400, { message: "Persona je jen vlastní (scope=personal) nebo veřejného asistenta" });
      requireAdmin(ctx);
      const a = await ctx.tenant.publicAssistants.get(c.req.query("assistant") ?? "");
      if (!a || c.req.query("assistant") !== a.name) throw new HTTPException(404, { message: "Asistent neexistuje" });
      await ctx.tenant.profiles.put(publicProfile(a.name), profile);
      return c.json<AssistantProfile>(profile);
    })
    // Guards: the system's (read-only here), the tenant's and the public assistants' (admins write), the caller's own.
    .get("/guards", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const [system, own, mine] = await Promise.all([tenant.features.systemGuards(), tenant.guards.list({ level: "tenant" }), tenant.guards.list({ level: "user", userId: user.sub })]);
      const assistants =
        role === "admin" && (await tenant.features.get()).public
          ? Object.fromEntries(
              await Promise.all((await tenant.publicAssistants.list()).map(async (a) => [a.name, await tenant.guards.list({ level: "assistant", assistant: a.name })] as const)),
            )
          : undefined;
      return c.json<Guards>({ system, tenant: own, user: mine, ...(assistants ? { assistants } : {}) });
    })
    .put("/guards/:level/:name", async (c) => {
      const ctx = c.get("ctx");
      const owner = await guardOwner(ctx, c.req.param("level"), c.req.query("assistant"));
      const name = c.req.param("name");
      if (!GUARD_NAME.test(name) || name.length > 60) throw new HTTPException(400, { message: "Název: malá písmena, číslice a pomlčky" });
      const guard = { name, ...parse(guardBody, await c.req.json()) };
      await fileErrors(() => ctx.tenant.guards.put(owner, guard));
      return c.json<Guard>(guard);
    })
    .delete("/guards/:level/:name", async (c) => {
      const ctx = c.get("ctx");
      const owner = await guardOwner(ctx, c.req.param("level"), c.req.query("assistant"));
      if (!(await ctx.tenant.guards.delete(owner, c.req.param("name")))) throw new HTTPException(404, { message: "Pravidlo neexistuje" });
      return c.body(null, 204);
    })
    // Writes a persona's description from a character; nothing is saved until the (edited) profile is put.
    .post("/assistant/persona", async (c) => {
      const { tenant, user } = c.get("ctx");
      const { character, source } = parse(personaBody, await c.req.json());
      const quotas = await tenant.features.quotas();
      if (quotas.tokensPerMonth !== null && (await tenant.usage.tokens()) >= quotas.tokensPerMonth) throw new HTTPException(429, { message: TOKENS_EXHAUSTED });
      if (quotas.tokensPerUserMonth !== null && (await tenant.usage.tokens(Date.now(), { user: user.sub })) >= quotas.tokensPerUserMonth) {
        throw new HTTPException(429, { message: USER_TOKENS_EXHAUSTED });
      }
      const { description, tokens } = await describePersona(tenant.personaModel, character, source);
      await tenant.usage.add(tokens, Date.now(), { user: user.sub });
      return c.json<Persona>({ character, source, description });
    })

    // The public assistants (the tenant's customers): their settings for admins, the inquiries they took for everyone.
    .get("/public-assistants", async (c) => {
      requireAdmin(c.get("ctx"));
      return c.json<PublicAssistantSettings[]>(await c.get("ctx").tenant.publicAssistants.list());
    })
    .put("/public-assistants/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!PUBLIC_ASSISTANT_NAME.test(name) || name.length > 40) throw new HTTPException(400, { message: "Název: malá písmena, číslice a pomlčky" });
      const settings = { ...parse(publicSettingsBody, await c.req.json()), name };
      await ctx.tenant.publicAssistants.put(settings);
      return c.json<PublicAssistantSettings>(settings);
    })
    .delete("/public-assistants/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.tenant.publicAssistants.delete(c.req.param("name")))) throw new HTTPException(404, { message: "Asistent neexistuje" });
      await ctx.tenant.guards.deleteAll({ level: "assistant", assistant: c.req.param("name") });
      return c.body(null, 204);
    })
    .get("/inquiries", async (c) => c.json<Inquiry[]>(await c.get("ctx").tenant.inquiries.list()))
    .patch("/inquiries/:id", async (c) => {
      const { status } = parse(z.object({ status: z.enum(["new", "done"]) }), await c.req.json());
      if (!(await c.get("ctx").tenant.inquiries.setStatus(c.req.param("id"), status))) throw new HTTPException(404, { message: "Poptávka neexistuje" });
      return c.body(null, 204);
    })
    // The conversation an inquiry came from, for the tenant's people.
    .get("/inquiries/:id/messages", async (c) => {
      const { tenant } = c.get("ctx");
      const inquiry = (await tenant.inquiries.list()).find((i) => i.id === c.req.param("id"));
      if (!inquiry?.threadId) throw new HTTPException(404, { message: "Konverzace není" });
      const state = await tenant.graph.getState({ configurable: { thread_id: inquiry.threadId } });
      return c.json<ThreadMessage[]>(toThreadMessages(state.values.messages ?? []));
    })

    .get("/integrations/standard", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.standardAccounts.list(user.sub));
    })
    .put("/integrations/standard/:name", async (c) => {
      const { tenant, user } = c.get("ctx");
      const name = parse(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64), c.req.param("name"));
      await tenant.standardAccounts.put(user.sub, name, parse(standardAccountSchema, await c.req.json()));
      return c.json({ ok: true });
    })
    .delete("/integrations/standard/:name", async (c) => {
      const { tenant, user } = c.get("ctx");
      await tenant.standardAccounts.delete(user.sub, c.req.param("name"));
      return c.json({ ok: true });
    })

    // The caller's Google and Microsoft accounts (personal: only they connect and use them).
    .get("/integrations", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json<Integration[]>(await tenant.integrations.list(user.sub));
    })
    .post("/integrations/:provider/connect", async (c) => {
      const { tenant, user } = c.get("ctx");
      const provider = parse(z.enum(["google", "microsoft"]), c.req.param("provider"));
      if (!tenant.integrations.available().includes(provider)) throw new HTTPException(404, { message: "Propojení s tímto poskytovatelem není v Osirisu nastavené" });
      return c.json({ authorizationUrl: await tenant.integrations.start(user.sub, provider) });
    })
    .delete("/integrations/:provider", async (c) => {
      const { tenant, user } = c.get("ctx");
      await tenant.integrations.disconnect(user.sub, parse(z.enum(["google", "microsoft"]), c.req.param("provider")));
      return c.body(null, 204);
    })
    // The provider sent the user back (web app's /integration-callback); only the user who started it finishes it.
    .post("/integrations/callback", async (c) => {
      const { tenant, user } = c.get("ctx");
      const { state, code } = parse(oauthCallbackBody, await c.req.json());
      const pending = await tenant.integrations.pending(state);
      if (!pending || pending.owner !== user.sub) throw new HTTPException(400, { message: "Přihlášení vypršelo nebo patří jinému uživateli, zkus to znovu" });
      const done = await tenant.integrations.finish(state, code).catch((err: Error) => {
        throw new HTTPException(502, { message: `Propojení se nepodařilo: ${err.message}` });
      });
      return c.json({ provider: done.provider, account: done.account });
    })

    // How much of its quotas the tenant uses, for the meters above the tenant in the sidebar.
    .get("/usage", async (c) => {
      const { tenant, user } = c.get("ctx");
      const [quotas, storage, storageLimit, tokens, userTokens, tables, database, counted] = await Promise.all([
        tenant.features.quotas(),
        tenant.files.usage(),
        tenant.files.quotaInForce(),
        tenant.usage.tokens(),
        tenant.usage.tokens(Date.now(), { user: user.sub }),
        tenant.data.tableCount(),
        tenant.data.size(),
        counts?.() ?? { members: 0, schedules: 0, dashboards: 0 },
      ]);
      return c.json<TenantUsage>({
        storage: { used: storage, limit: storageLimit },
        tokens: { used: tokens, limit: quotas.tokensPerMonth },
        members: { used: counted.members, limit: quotas.members },
        schedules: { used: counted.schedules, limit: quotas.schedules },
        userTokens: { used: userTokens, limit: quotas.tokensPerUserMonth },
        tables: { used: tables, limit: quotas.tables },
        database: { used: database, limit: quotas.databaseMb === null ? null : quotas.databaseMb * 1024 * 1024 },
        dashboards: { used: counted.dashboards, limit: quotas.dashboards },
      });
    })
    // Tokens this month by member and by public assistant, and the tenant's per month; a member sees only themselves.
    .get("/usage/breakdown", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const b = await tenant.usage.breakdown();
      return c.json<UsageBreakdown>({ ...b, users: role === "admin" ? b.users : b.users.filter((u) => u.userId === user.sub) });
    })

    // The assistant's built-in tools and whether each is available (its feature on, not switched off).
    .get("/tools", async (c) => {
      const { tenant } = c.get("ctx");
      const [on, off] = await Promise.all([tenant.features.get(), tenant.features.disabledTools()]);
      return c.json<BuiltinTool[]>(
        tenant.builtinTools.map(([feature, t]) => ({ name: t.name, description: t.description, feature, featureOn: on[feature], disabled: off.includes(t.name) })),
      );
    })

    .put("/settings", async (c) => {
      const { tenant, user } = c.get("ctx");
      const settings = parse(settingsBody, await c.req.json());
      await tenant.settings.put(user.sub, settings);
      return c.json<UserSettings>(settings);
    })

    .get("/memories", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.memory.list(user.sub, 1000));
    })

    .post("/memories", async (c) => {
      const ctx = c.get("ctx");
      const { content } = parse(memoryBody, await c.req.json());
      return c.json(await ctx.tenant.memory.add(ctx.user.sub, content, "tenant"), 201);
    })

    .delete("/memories/:id", async (c) => {
      const ctx = c.get("ctx");
      queryScope(c.req.query("scope"));
      if (!(await ctx.tenant.memory.delete(c.req.param("id"), "tenant", ctx.user.sub))) {
        throw new HTTPException(404, { message: "Memory not found" });
      }
      return c.body(null, 204);
    })

    // Full-text search in the tenant's text files and the caller's own (`scope` limits it to one of them).
    .get("/files/search", async (c) => {
      const { tenant, user } = c.get("ctx");
      const q = (c.req.query("q") ?? "").slice(0, 200);
      const scope = c.req.query("scope");
      const owners = [""];
      const hits = await tenant.fileIndex.search(q, owners, 50);
      return c.json<FileSearchHit[]>(hits.map((h) => ({ scope: h.owner ? "personal" : "tenant", path: h.path, snippet: h.snippet })));
    })

    .get("/files", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      return c.json<FileEntry[]>(await fileErrors(() => ctx.tenant.files.list(loc, q.path ?? "")));
    })

    // Always a download: tenant files may be HTML or SVG, which must never render on the app's origin.
    .get("/files/content", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      const { entry, data } = await fileErrors(() => ctx.tenant.files.read(loc, q.path ?? ""));
      return c.body(new Uint8Array(data), 200, {
        "content-type": entry.mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      });
    })

    .put(
      "/files/content",
      async (c, next) => bodyLimit({ maxSize: c.get("ctx").tenant.files.limits.maxFileBytes, onError: (c) => c.json({ error: "Soubor je příliš velký" }, 413) })(c, next),
      async (c) => {
        const ctx = c.get("ctx");
        const q = fileQuery(c);
        requireFileWrite(ctx, q.scope, q.path);
        const loc = await fileLocation(ctx, q.scope, q.thread);
        const data = new Uint8Array(await c.req.arrayBuffer());
        const overwrite = c.req.query("overwrite") === "true";
        return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.write(loc, q.path ?? "", data, { overwrite })), 201);
      },
    )

    .post("/files/dir", async (c) => {
      const ctx = c.get("ctx");
      const body = parse(fileRef, await c.req.json());
      requireFileWrite(ctx, body.scope, body.path);
      const loc = await fileLocation(ctx, body.scope, body.thread);
      return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.mkdir(loc, body.path)), 201);
    })

    .post("/files/move", async (c) => {
      const ctx = c.get("ctx");
      const { from, to } = parse(moveBody, await c.req.json());
      requireFileWrite(ctx, from.scope, from.path);
      requireFileWrite(ctx, to.scope, to.path);
      const [src, dst] = [await fileLocation(ctx, from.scope, from.thread), await fileLocation(ctx, to.scope, to.thread)];
      return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.move(src, from.path, dst, to.path)));
    })

    .delete("/files", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      requireFileWrite(ctx, q.scope, q.path);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      await fileErrors(() => ctx.tenant.files.delete(loc, q.path ?? ""));
      return c.body(null, 204);
    })

    // The tenant's VitePress sites (vitepress/<site>/, built into www/<site>/): admins create, build and remove them.
    .get("/vitepress-sites", async (c) => {
      const { tenant } = c.get("ctx");
      return c.json({ sites: await listSites(tenant.files), builder: !!tenant.vitepress });
    })
    .post("/vitepress-sites", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { name } = parse(z.object({ name: z.string().trim().toLowerCase().max(60) }), await c.req.json());
      await fileErrors(() => createSite(ctx.tenant.files, name));
      return c.json({ name }, 201);
    })
    .post("/vitepress-sites/:name/build", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!ctx.tenant.vitepress) throw new HTTPException(503, { message: "Sestavování webů tu není nastavené" });
      const name = c.req.param("name");
      if (!SITE_NAME.test(name)) throw new HTTPException(400, { message: "Neplatný název webu" });
      const result = await fileErrors(() => buildSite(ctx.tenant.files, ctx.tenant.vitepress!, name)).catch((err: Error) => {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(502, { message: err.message });
      });
      return c.json({ ...result, message: describeBuild(result) });
    })
    .delete("/vitepress-sites/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!(await listSites(ctx.tenant.files)).includes(name)) throw new HTTPException(404, { message: "Web neexistuje" });
      await fileErrors(() => ctx.tenant.files.delete({ scope: "tenant" }, `${VITEPRESS_DIR}/${name}`));
      await ctx.tenant.files.delete({ scope: "tenant" }, `www/${name}`).catch(() => {});
      return c.body(null, 204);
    })

    // Where the tenant's website is published over SFTP (its VPS at vas-hosting.cz…): admins manage and publish.
    .get("/site-targets", async (c) => {
      requireAdmin(c.get("ctx"));
      return c.json<SiteTarget[]>(await c.get("ctx").tenant.siteTargets.list());
    })
    .put("/site-targets/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!MCP_SERVER_NAME.test(name)) throw new HTTPException(400, { message: "Název: malá písmena, číslice a pomlčky" });
      const body = parse(siteTargetBody, await c.req.json());
      await ctx.tenant.siteTargets.put(name, body).catch((err: Error) => {
        throw new HTTPException(400, { message: err.message });
      });
      return c.body(null, 204);
    })
    .delete("/site-targets/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.tenant.siteTargets.delete(c.req.param("name")))) throw new HTTPException(404, { message: "Cíl neexistuje" });
      return c.body(null, 204);
    })
    // Connects and lists the target folder (pins the server's host key on the first connection).
    .post("/site-targets/:name/test", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const entries = await testTarget(ctx.tenant.siteTargets, c.req.param("name")).catch((err: Error) => {
        throw new HTTPException(502, { message: `Připojení selhalo: ${err.message}` });
      });
      return c.json({ entries });
    })
    .post("/site-targets/:name/publish", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { dir } = parse(z.object({ dir: z.string().max(512).default("www") }), await c.req.json().catch(() => ({})));
      const result = await fileErrors(() => publishSftp(ctx.tenant.files, { scope: "tenant" }, dir, ctx.tenant.siteTargets, c.req.param("name"))).catch(
        (err: Error) => {
          if (err instanceof HTTPException) throw err;
          throw new HTTPException(502, { message: `Publikování selhalo: ${err.message}` });
        },
      );
      return c.json<PublishResult>(result);
    })

    // Secrets are write-only: the list has names, hosts and descriptions, never values.
    .get("/secrets", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json<SecretSummary[]>(await tenant.secrets.list(user.sub));
    })

    .put("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!SECRET_NAME.test(name)) throw new HTTPException(400, { message: "Název musí být VELKÝMI_PÍSMENY (A-Z, 0-9, _)" });
      const { scope, ...body } = parse(secretBody, await c.req.json());
      requireScope(ctx, scope);
      try {
        await ctx.tenant.secrets.put(name, secretOwner(scope, ctx.user.sub), body);
      } catch (err) {
        if (err instanceof SecretUseError) throw new HTTPException(400, { message: err.message });
        throw err;
      }
      // MCP servers may use the secret: reconnect with the new value.
      ctx.tenant.mcp.invalidateAll();
      return c.body(null, 204);
    })

    .delete("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.secrets.delete(c.req.param("name"), secretOwner(scope, ctx.user.sub)))) {
        throw new HTTPException(404, { message: "Secret not found" });
      }
      ctx.tenant.mcp.invalidateAll();
      return c.body(null, 204);
    });

  const internal = createInternalRoutes({ tenant, verifier, activity, snapshot, activeRuns });

  return new Hono()
    .use(telemetryMiddleware())
    .use(async (c, next) => {
      // Shutting down for sleep: the caller wakes the runtime again and retries.
      if (activity.sleeping && c.req.path !== "/health") return c.json({ error: "Runtime is going to sleep" }, 503, { [SLEEPING_HEADER]: "1" });
      await next();
    })
    .get("/health", (c) => c.json({ ok: true, tenant: tenant.id }))
    .route("/api", api)
    .route("/public", pub)
    .route("/internal", internal)
    .onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    });
}
