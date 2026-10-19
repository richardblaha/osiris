import { randomUUID } from "node:crypto";
import type { BuiltinTool, Feature, TenantUsage, FileEntry, FileScope, McpServer, Scope, SecretSummary, SiteRelease, Skill, UserSettings } from "@osiris/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
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
import { ServiceError } from "@osiris/platform/http.ts";
import { SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import type { Activity } from "./activity.ts";
import { userAuth, type AuthEnv, type RequestContext } from "./auth.ts";
import { createInternalRoutes } from "./internal.ts";


const runBody = z.object({ message: z.string().trim().min(1).max(20_000) });
const scope = z.enum(["tenant", "personal"]).default("personal");
const documentBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(500_000),
  scope,
});
const skillBody = z.object({
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(50_000),
  scope,
});
const mcpServerBody = z.object({
  url: z.string().trim().min(1).max(2000),
  enabled: z.boolean().default(true),
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
  ["/secrets", ["http", "mcp"]],
  ["/files", ["files"]],
  ["/site-publish", ["sites", "files"]],
];

const FILE_ERROR_STATUS: Record<FileErrorCode, 400 | 404 | 409 | 413 | 415 | 507> = {
  invalid: 400,
  not_found: 404,
  exists: 409,
  too_large: 413,
  type: 415,
  quota: 507,
};
const fileScope = z.enum(["tenant", "personal", "temp"]).default("personal");
const fileRef = z.object({ scope: fileScope, path: z.string().min(1).max(512), thread: z.string().max(100).optional() });
const moveBody = z.object({ from: fileRef, to: fileRef });

export interface RuntimeAppDeps {
  tenant: Tenant;
  verifier: InternalVerifier;
  activity: Activity;
  /** Takes a snapshot and uploads it (operator before sleep, control on demand). */
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  /** Publishes a folder of the tenant's files as a site (through control). */
  publishSite?: (loc: FileLocation, dir: string, domain: string, userId: string) => Promise<SiteRelease>;
  /** Members and scheduled tasks, which control counts, for the quota meters. */
  counts?: () => Promise<{ members: number; schedules: number }>;
}

/**
 * The tenant runtime's API. Every request carries an internal token: user calls come from the gateway (which verified
 * the PocketID token and the membership), scheduled runs and WhatsApp messages from control, activity checks and
 * snapshots from the operator. The tenant is fixed: this process serves one tenant and refuses tokens for another.
 */
export function createRuntimeApp({ tenant, verifier, activity, snapshot, publishSite, counts }: RuntimeAppDeps) {
  // One run per thread at a time. In-process is enough: a tenant has exactly one runtime.
  const activeRuns = new Set<string>();

  const requireThread = async ({ tenant, user }: RequestContext, id: string) => {
    if (!(await threads.ownsThread(tenant.db, user.sub, id))) throw new HTTPException(404, { message: "Thread not found" });
  };
  const requireAdmin = (ctx: RequestContext) => {
    if (ctx.role !== "admin") throw new HTTPException(403, { message: "Requires admin role" });
  };
  /** Anyone may change their personal settings; tenant-wide ones need an admin. */
  const requireScope = (ctx: RequestContext, scope: Scope) => {
    if (scope === "tenant") requireAdmin(ctx);
  };
  const queryScope = (value: string | undefined): Scope => {
    if (value === undefined || value === "personal") return "personal";
    if (value === "tenant") return "tenant";
    throw new HTTPException(400, { message: "scope must be tenant or personal" });
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
    if (scope === "personal") return { scope, userId: ctx.user.sub };
    if (!thread) throw new HTTPException(400, { message: "thread is required for temp files" });
    await requireThread(ctx, thread);
    return { scope, threadId: thread };
  };
  const fileQuery = (c: { req: { query: (k: string) => string | undefined } }) =>
    parse(fileRef.partial({ path: true }), { scope: c.req.query("scope"), path: c.req.query("path"), thread: c.req.query("thread") });
  /** Members read tenant files but write only their own and their threads' temp files. */
  const requireFileWrite = (ctx: RequestContext, scope: FileScope) => {
    if (scope === "tenant") requireAdmin(ctx);
  };
  const fileErrors = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof FileError) throw new HTTPException(FILE_ERROR_STATUS[err.code], { message: err.message });
      throw err;
    }
  };

  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HTTPException(400, { message: "Skill name must be lowercase-kebab-case" });
    return name;
  };

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
      const { tenant, user, role } = ctx;
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const { message } = parse(runBody, await c.req.json());
      const runKey = `${tenant.id}/${id}`;
      if (activeRuns.has(runKey)) throw new HTTPException(409, { message: "A run is already in progress for this thread" });

      activeRuns.add(runKey);
      activity.activeRuns++;
      await threads.touchThread(tenant.db, id, message);
      const abort = new AbortController();
      return streamSSE(c, async (sse) => {
        sse.onAbort(() => abort.abort());
        try {
          const runCtx = {
            thread_id: id,
            tenant_id: tenant.id,
            user_id: user.sub,
            role,
            channel: "web" as const,
            user_name: user.name ?? undefined,
          };
          for await (const event of streamRun(tenant.graph, runCtx, message, abort.signal)) {
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
    })

    // Settings come in two scopes: `tenant` (everyone in the tenant, admins only) and `personal` (the caller only).

    .get("/knowledge/documents", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.knowledge.listDocuments(user.sub));
    })

    .post("/knowledge/documents", async (c) => {
      const ctx = c.get("ctx");
      const { title, content, scope } = parse(documentBody, await c.req.json());
      requireScope(ctx, scope);
      return c.json(await ctx.tenant.knowledge.addDocument(title, content, scope, ctx.user.sub), 201);
    })

    .delete("/knowledge/documents/:id", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.knowledge.deleteDocument(c.req.param("id"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Document not found" });
      }
      return c.body(null, 204);
    })

    // `?scope=tenant` shows what the tenant has (tenant and bundled skills), without the caller's personal overrides.
    .get("/skills", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.skills.list(queryScope(c.req.query("scope")) === "tenant" ? "" : user.sub));
    })

    .get("/skills/:name", async (c) => {
      const { tenant, user } = c.get("ctx");
      const viewer = queryScope(c.req.query("scope")) === "tenant" ? "" : user.sub;
      const skill = await tenant.skills.get(c.req.param("name"), viewer);
      if (!skill) throw new HTTPException(404, { message: "Skill not found" });
      return c.json<Skill>(skill);
    })

    .put("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = skillName(c.req.param("name"));
      const { scope, ...skill } = parse(skillBody, await c.req.json());
      requireScope(ctx, scope);
      await ctx.tenant.skills.put({ name, ...skill }, scope, ctx.user.sub);
      return c.json<Skill>((await ctx.tenant.skills.get(name, ctx.user.sub))!);
    })

    .delete("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.skills.delete(c.req.param("name"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Skill not found" });
      }
      return c.body(null, 204);
    })

    .get("/mcp-servers", async (c) => {
      const { tenant, user, role } = c.get("ctx");
      const servers = await tenant.mcpServers.list(user.sub, { showTenantUrls: role === "admin" });
      return c.json<McpServer[]>(
        servers.map((s) => ({
          ...s,
          status: s.enabled ? tenant.mcp.status(mcpOwner(s.scope, user.sub)).get(s.name) : undefined,
        })),
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

    // How much of its quotas the tenant uses, for the meters above the tenant in the sidebar.
    .get("/usage", async (c) => {
      const { tenant } = c.get("ctx");
      const [quotas, storage, storageLimit, tokens, counted] = await Promise.all([
        tenant.features.quotas(),
        tenant.files.usage(),
        tenant.files.quotaInForce(),
        tenant.usage.tokens(),
        counts?.() ?? { members: 0, schedules: 0 },
      ]);
      return c.json<TenantUsage>({
        storage: { used: storage, limit: storageLimit },
        tokens: { used: tokens, limit: quotas.tokensPerMonth },
        members: { used: counted.members, limit: quotas.members },
        schedules: { used: counted.schedules, limit: quotas.schedules },
      });
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
      const { content, scope } = parse(memoryBody, await c.req.json());
      requireScope(ctx, scope);
      return c.json(await ctx.tenant.memory.add(ctx.user.sub, content, scope), 201);
    })

    .delete("/memories/:id", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.tenant.memory.delete(c.req.param("id"), scope, ctx.user.sub))) {
        throw new HTTPException(404, { message: "Memory not found" });
      }
      return c.body(null, 204);
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
        requireFileWrite(ctx, q.scope);
        const loc = await fileLocation(ctx, q.scope, q.thread);
        const data = new Uint8Array(await c.req.arrayBuffer());
        const overwrite = c.req.query("overwrite") === "true";
        return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.write(loc, q.path ?? "", data, { overwrite })), 201);
      },
    )

    .post("/files/dir", async (c) => {
      const ctx = c.get("ctx");
      const body = parse(fileRef, await c.req.json());
      requireFileWrite(ctx, body.scope);
      const loc = await fileLocation(ctx, body.scope, body.thread);
      return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.mkdir(loc, body.path)), 201);
    })

    .post("/files/move", async (c) => {
      const ctx = c.get("ctx");
      const { from, to } = parse(moveBody, await c.req.json());
      requireFileWrite(ctx, from.scope);
      requireFileWrite(ctx, to.scope);
      const [src, dst] = [await fileLocation(ctx, from.scope, from.thread), await fileLocation(ctx, to.scope, to.thread)];
      return c.json<FileEntry>(await fileErrors(() => ctx.tenant.files.move(src, from.path, dst, to.path)));
    })

    .delete("/files", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      requireFileWrite(ctx, q.scope);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      await fileErrors(() => ctx.tenant.files.delete(loc, q.path ?? ""));
      return c.body(null, 204);
    })

    .post("/site-publish", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!publishSite) throw new HTTPException(404, { message: "Publishing is not available" });
      const body = parse(z.object({ scope: fileScope, dir: z.string().max(512), domain: z.string().min(4).max(253) }), await c.req.json());
      const loc = await fileLocation(ctx, body.scope, undefined);
      try {
        return c.json<SiteRelease>(await fileErrors(() => publishSite(loc, body.dir, body.domain, ctx.user.sub)), 201);
      } catch (err) {
        if (err instanceof ServiceError) throw new HTTPException(err.status === 413 ? 413 : 400, { message: err.message });
        throw err;
      }
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
    .use(async (c, next) => {
      // Shutting down for sleep: the caller wakes the runtime again and retries.
      if (activity.sleeping && c.req.path !== "/health") return c.json({ error: "Runtime is going to sleep" }, 503, { [SLEEPING_HEADER]: "1" });
      await next();
    })
    .get("/health", (c) => c.json({ ok: true, tenant: tenant.id }))
    .route("/api", api)
    .route("/internal", internal)
    .onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    });
}
