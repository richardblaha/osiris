import { randomUUID } from "node:crypto";
import type { McpServer, MeResponse, Scope, SecretSummary, Skill, UserSettings } from "@osiris/shared";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { SKILL_NAME } from "./agent/skills.ts";
import { streamRun, toThreadMessages } from "./agent/run.ts";
import { authMiddleware, tenantMiddleware, type AuthEnv, type RequestContext } from "./auth/middleware.ts";
import type { TokenVerifier } from "./auth/oidc.ts";
import { MCP_SERVER_NAME, McpNameTakenError, mcpOwner } from "./mcp/store.ts";
import { UnsafeUrlError } from "./mcp/url.ts";
import * as threads from "./repo/threads.ts";
import { HOST_PATTERN, SECRET_NAME, SecretUseError } from "./vault/template.ts";
import { secretOwner } from "./vault/vault.ts";
import type { TenantRegistry } from "./tenants/registry.ts";
import { whatsappWebhook, type WhatsAppWebhookOptions } from "./whatsapp/webhook.ts";

export interface AppDeps {
  verifier: TokenVerifier;
  tenants: TenantRegistry;
  corsOrigin: string;
  /** In production the API also serves the built web app from `dir`, plus its runtime config at `/config.js`. */
  web?: { dir: string; oidcAuthority?: string; oidcClientId?: string };
  /** The WhatsApp channel; without it `/webhooks/whatsapp` answers 404. */
  whatsapp?: WhatsAppWebhookOptions;
}

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

export function createApp({ verifier, tenants, corsOrigin, web, whatsapp }: AppDeps) {
  // Guards against two concurrent runs on one thread. In-process only: needs a shared lock once the API runs on several replicas.
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
  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HTTPException(400, { message: "Skill name must be lowercase-kebab-case" });
    return name;
  };

  const api = new Hono<AuthEnv>()
    .use(authMiddleware(verifier))

    // Before tenantMiddleware: the client calls this to learn which tenants it can pick.
    .get("/me", async (c) => {
      const { user, memberships } = c.get("auth");
      return c.json<MeResponse>({
        user: { id: user.sub, email: user.email, name: user.name, phone: user.phone },
        tenants: memberships.map((m) => ({ id: m.tenantId, name: m.tenantId, role: m.role })),
      });
    })

    .use(tenantMiddleware(tenants))

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

    .get("/skills", async (c) => {
      const { tenant, user } = c.get("ctx");
      return c.json(await tenant.skills.list(user.sub));
    })

    .get("/skills/:name", async (c) => {
      const { tenant, user } = c.get("ctx");
      const skill = await tenant.skills.get(c.req.param("name"), user.sub);
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

  const app = new Hono()
    .use("/api/*", cors({ origin: corsOrigin, allowHeaders: ["authorization", "content-type", "x-tenant-id"] }))
    .get("/health", (c) => c.json({ ok: true }))
    .route("/api", api)
    // Registered even when off, so the SPA fallback doesn't answer Meta's verification with index.html.
    .route("/webhooks/whatsapp", whatsapp ? whatsappWebhook(whatsapp) : new Hono().all("/", (c) => c.text("WhatsApp is not configured", 404)))
    // Runtime config for the web client, so one image works with any PocketID client. Loaded before the app bundle.
    .get("/config.js", (c) => {
      const config = { oidcAuthority: web?.oidcAuthority, oidcClientId: web?.oidcClientId };
      c.header("cache-control", "no-cache");
      return c.body(`window.__OSIRIS_CONFIG__ = ${JSON.stringify(config)};\n`, 200, { "content-type": "text/javascript" });
    });

  if (web) {
    app
      .use("/assets/*", async (c, next) => {
        await next();
        // Vite puts a content hash in asset file names.
        if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
      })
      .use("*", serveStatic({ root: web.dir }))
      // SPA fallback: client-side routes such as /callback get index.html.
      .get("*", serveStatic({ root: web.dir, path: "index.html" }));
  }

  return app.onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    });
}
