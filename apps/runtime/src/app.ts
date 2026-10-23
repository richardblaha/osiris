import { AttachmentError, attachmentInput, attachmentMessage } from "@osiris/core/agent/attachments.ts";
import { QuestionError } from "@osiris/core/agent/questions.ts";
import { standardAccountSchema } from "@osiris/core/integrations/standard.ts";
import { randomUUID } from "node:crypto";
import type { AssistantProfile, AssistantProfiles, BuiltinTool, Guard, Guards, Feature, FileEntry, FileScope, FileSearchHit, Inquiry, Integration, McpServer, PublicAssistantSettings, PublicInfo, ThreadMessage, Persona, PublishResult, Scope, SecretSummary, SiteTarget, Skill, ProjectUsage, UsageBreakdown, UserSettings } from "@osiris/shared";
import { CUSTOM_PERSONA, GUARD_NAME, PUBLIC_ASSISTANT_NAME, PUBLIC_TOOLS } from "@osiris/shared";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { describePersona, hasRules } from "@osiris/core/agent/assistant.ts";
import { publicProfile } from "@osiris/core/public/assistant.ts";
import { buildSite, createSite, describeBuild, listSites, SITE_NAME, VITEPRESS_DIR } from "@osiris/core/agent/tools/site.ts";
import type { GuardOwner } from "@osiris/core/agent/guards.ts";
import { publishFolder as publishSftp, testTarget } from "@osiris/core/sites/sftp.ts";
import { slug } from "@osiris/core/files/sync.ts";
import { DOCUMENT_ID } from "@osiris/core/rag/store.ts";
import { TOKENS_EXHAUSTED, USER_TOKENS_EXHAUSTED } from "@osiris/core/agent/graph.ts";
import { SKILL_NAME } from "@osiris/core/agent/skills.ts";
import { FileError, type FileErrorCode, type FileLocation } from "@osiris/core/files/store.ts";
import { streamRun, toThreadMessages } from "@osiris/core/agent/run.ts";
import { MCP_SERVER_NAME, mcpOwner } from "@osiris/core/mcp/store.ts";
import { UnsafeUrlError } from "@osiris/core/mcp/url.ts";
import * as threads from "@osiris/core/repo/threads.ts";
import { HOST_PATTERN, SECRET_NAME, SecretUseError } from "@osiris/core/vault/template.ts";
import { secretOwner } from "@osiris/core/vault/vault.ts";
import type { Project } from "@osiris/core/projects/project.ts";
import type { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import { SLEEPING_HEADER } from "@osiris/platform/runtime-client.ts";
import type { Activity } from "./activity.ts";
import { publicAuth, userAuth, type AuthEnv, type RequestContext } from "./auth.ts";
import { createInternalRoutes } from "./internal.ts";
import { databaseRoutes } from "./database.ts";
import { telemetryMiddleware } from "@osiris/platform/telemetry.ts";
import { detail, errorResponse, HttpError, requestLocale, translate, ValidationError } from "@osiris/platform/i18n.ts";


const runBody = z.object({ message: z.string().trim().min(1).max(60_000).refine(v => v.length <= 20_000 || v.startsWith("@osiris-answer:"), "errors.validation.messageTooLong") });
// The project's records (admins write them) or the caller's own, which replace the project's of the same name for them.
const scope = z.enum(["project", "personal"]).default("personal");
const documentBody = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(500_000),
  /** New documents: a folder, e.g. public (a public assistant may get just that folder). */
  folder: z.string().trim().max(200).optional(),
  /** New documents: this exact id (the caller's own copy of a project document) instead of one from the title. */
  id: z.string().max(300).optional(),
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
  // headers: static headers (sealed); oauth: the owner signs in at the provider instead.
  auth: z.enum(["headers", "oauth"]).default("headers"),
  // Omitted = keep the stored headers. Values are secrets (tokens) and are never returned.
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "errors.validation.headerName"), z.string().max(4000).regex(/^[^\r\n]*$/))
    .optional(),
  scope,
});
const settingsBody = z.object({
  address: z.enum(["auto", "ty", "vy"]),
  language: z.enum(["auto", "en", "cs", "sk"]),
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
  .refine((p) => p.split("/").every((seg) => seg && seg !== "." && seg !== ".." && !seg.startsWith(".")), "errors.validation.knowledgePath");
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
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "errors.validation.host"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(100),
  remoteDir: z.string().trim().min(1).max(500).regex(/^\//, "errors.validation.remoteDir"),
  auth: z.enum(["password", "key"]),
  // Omitted = keep the stored one. Never returned.
  secret: z.string().min(1).max(20_000).optional(),
});
const oauthCallbackBody = z.object({ state: z.string().min(16).max(200), code: z.string().min(1).max(4000), iss: z.string().max(2000).optional() });
const memoryBody = z.object({ content: z.string().trim().min(1).max(500), scope, overrides: z.string().max(100).optional() });
const secretBody = z.object({
  // Omitted = keep the stored value (e.g. when only the hosts change). Never returned.
  value: z.string().min(1).max(10_000).optional(),
  allowedHosts: z
    .array(z.string().trim().toLowerCase().regex(HOST_PATTERN, "errors.validation.allowedHost"))
    .min(1, "errors.validation.allowedHostsEmpty")
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
const fileScope = z.enum(["project", "personal", "temp"]).default("project");
const fileRef = z.object({ scope: fileScope, path: z.string().min(1).max(512), thread: z.string().max(100).optional() });
const moveBody = z.object({ from: fileRef, to: fileRef });

export interface RuntimeAppDeps {
  project: Project;
  verifier: InternalVerifier;
  activity: Activity;
  /** Takes a snapshot and uploads it (operator before sleep, control on demand). */
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  /** Members and scheduled tasks, which control counts, for the quota meters. */
  counts?: () => Promise<{ members: number; schedules: number; dashboards: number }>;
}

/**
 * The project runtime's API. Every request carries an internal token: user calls come from the gateway (which had control
 * identify the access token and checked the membership), scheduled runs and WhatsApp messages from control, activity checks and
 * snapshots from the operator. The project is fixed: this process serves one project and refuses tokens for another.
 */
export function createRuntimeApp({ project, verifier, activity, snapshot, counts }: RuntimeAppDeps) {
  // One run per thread at a time. In-process is enough: a project has exactly one runtime.
  const activeRuns = new Set<string>();

  /** Runs the agent on one message of a thread and streams its events (web and public chats). */
  const runThread = async (c: Context, ctx: RequestContext, id: string, message: string, assistant?: string) => {
    const { project, user, role, channel } = ctx;
    const locale = requestLocale(c.req.header("accept-language"));
    const runKey = `${project.id}/${id}`;
    if (activeRuns.has(runKey)) throw new HttpError(409, "errors.run.inProgress");

    activeRuns.add(runKey);
    let paths: string[] = [];
    let voice: string | undefined;
    try {
      const decoded = attachmentInput(message); paths = decoded.paths; voice = decoded.voice;
      if (paths.length && !(await project.features.get()).files) throw new HttpError(403, "errors.files.featureOff");
      message = await project.questions.prepare(user.sub, id, decoded.text);
    }
    catch (err) { activeRuns.delete(runKey); if (err instanceof QuestionError || err instanceof AttachmentError) throw new HttpError(400, err.key, err.params); throw err; }
    activity.activeRuns++;
    const abort = new AbortController();
    return streamSSE(c, async (sse) => {
      sse.onAbort(() => abort.abort());
      try {
        await threads.touchThread(project.records, id, message);
        const runCtx = { thread_id: id, project_id: project.id, user_id: user.sub, role, channel, assistant, user_name: user.name ?? undefined, locale };
        // With rules, the answer is sent only after the output check (the public assistant's rules too).
        const guarded = channel === "public" ? true : hasRules(await project.rules(user.sub));
        const quota = await project.features.quotas();
        if (paths.length && ((quota.tokensPerMonth !== null && await project.usage.tokens() >= quota.tokensPerMonth) || (quota.tokensPerUserMonth !== null && await project.usage.tokens(Date.now(), { user: user.sub }) >= quota.tokensPerUserMonth))) throw new Error("Token quota used up");
        const input = paths.length ? await attachmentMessage(project.files, project.media, id, message, paths, n => project.usage.add(n, Date.now(), { user: user.sub }), locale, voice) : undefined;
        for await (const event of streamRun(project.graph, runCtx, message, abort.signal, { guarded, input })) {
          await sse.writeSSE({ data: JSON.stringify(event) });
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          console.error("Run failed", { projectId: project.id, threadId: id, err });
          await sse.writeSSE({ data: JSON.stringify({ type: "error", message: "Agent run failed" }) });
        }
      } finally {
        activeRuns.delete(runKey);
        activity.activeRuns--;
        activity.touch();
      }
    });
  };

  const requireThread = async ({ project, user }: RequestContext, id: string) => {
    if (!(await threads.ownsThread(project.records, user.sub, id))) throw new HttpError(404, "errors.thread.notFound");
  };
  const requireAdmin = (ctx: RequestContext) => {
    if (ctx.role !== "admin") throw new HttpError(403, "errors.access.adminOnly");
  };
  /** Everyone reads the project's records and keeps their own; only admins change the project's. */
  const requireScope = (ctx: RequestContext, scope: Scope) => {
    if (scope === "project") requireAdmin(ctx);
  };
  const queryScope = (value: string | undefined): Scope => {
    if (value === undefined || value === "personal") return "personal";
    if (value === "project") return "project";
    throw new HttpError(400, "errors.scope.invalid");
  };
  /** Row owner of a scope: '' for the project's records, the caller's sub for their own. */
  const ownerOf = (ctx: RequestContext, scope: Scope) => (scope === "project" ? "" : ctx.user.sub);
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const r = schema.safeParse(value, { reportInput: true });
    if (!r.success) throw new ValidationError(r.error);
    return r.data;
  };
  const checkMcpUrl = async ({ project }: RequestContext, url: string) => {
    try {
      await project.mcp.checkUrl(url);
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof SecretUseError) throw new HttpError(400, err.key, err.params);
      throw err;
    }
  };
  /** The file scope a request names; temp files belong to one of the caller's threads. */
  const fileLocation = async (ctx: RequestContext, scope: FileScope, thread: string | undefined): Promise<FileLocation> => {
    if (scope === "project") return { scope };
    if (scope === "personal") return { scope, userId: ctx.user.sub };
    if (!thread) throw new HttpError(400, "errors.files.threadRequired");
    await requireThread(ctx, thread);
    return { scope: "temp", threadId: thread };
  };
  const fileQuery = (c: { req: { query: (k: string) => string | undefined } }) =>
    parse(fileRef.partial({ path: true }), { scope: c.req.query("scope"), path: c.req.query("path"), thread: c.req.query("thread") });
  /** The project's files are the admins' to write; personal ones the caller's; temp ones their thread's (checked by `fileLocation`). */
  const requireFileWrite = (ctx: RequestContext, scope: FileScope, _path?: string) => {
    if (scope !== "project" || ctx.role === "admin") return;
    throw new HttpError(403, "errors.files.projectAdminOnly");
  };
  const fileErrors = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      if (err instanceof FileError) throw new HttpError(FILE_ERROR_STATUS[err.code], err.key, err.params);
      throw err;
    }
  };

  /** Whose guards a request names: the caller's own (anyone), the project's or a public assistant's (admins). */
  const guardOwner = async (ctx: RequestContext, level: string, assistant: string | undefined): Promise<GuardOwner> => {
    if (level === "user") return { level: "user", userId: ctx.user.sub };
    requireAdmin(ctx);
    if (level === "project") return { level: "project" };
    if (level === "assistant") {
      const a = await ctx.project.publicAssistants.get(assistant ?? "");
      if (!a || a.name !== assistant) throw new HttpError(404, "errors.assistant.notFound");
      return { level: "assistant", assistant: a.name };
    }
    throw new HttpError(400, "errors.guard.level");
  };

  const skillName = (name: string) => {
    if (!SKILL_NAME.test(name)) throw new HttpError(400, "errors.validation.name");
    return name;
  };

  /** A public assistant, when the system admin allows the feature and the project admin switched it on. */
  const publicAssistant = async (name: string) => {
    const a = (await project.features.get()).public ? await project.publicAssistants.get(name) : null;
    return a?.enabled ? a : null;
  };
  const requirePublic = async (name: string) => {
    const a = await publicAssistant(name);
    if (!a) throw new HttpError(404, "errors.assistant.unavailable");
    return a;
  };

  // The project's customers (anonymous): the public chat page and the website widget, through the gateway.
  const pub = new Hono<AuthEnv>()
    .use(publicAuth(verifier, project))
    .use(async (_c, next) => {
      activity.touch();
      await next();
    })
    .get("/:assistant/info", async (c) => {
      const a = await publicAssistant(c.req.param("assistant"));
      return c.json<PublicInfo>({ enabled: !!a, title: a?.title || project.id, greeting: a?.greeting ?? "" });
    })
    .post("/:assistant/threads", async (c) => {
      await requirePublic(c.req.param("assistant"));
      const { user } = c.get("ctx");
      const id = randomUUID();
      await threads.createThread(project.records, user.sub, id, "public");
      return c.json({ id }, 201);
    })
    .get("/:assistant/threads/:id/messages", async (c) => {
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const state = await project.graph.getState({ configurable: { thread_id: c.req.param("id") } });
      return c.json<ThreadMessage[]>(toThreadMessages(state.values.messages ?? []));
    })
    .get("/:assistant/threads/:id/questions/:question", async (c) => {
      await requirePublic(c.req.param("assistant"));
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const q = await project.questions.get(ctx.user.sub, c.req.param("id"), c.req.param("question"));
      if (!q) throw new HttpError(404, "errors.question.notFound");
      return c.json(q);
    })
    .post("/:assistant/threads/:id/runs", async (c) => {
      const a = await requirePublic(c.req.param("assistant"));
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const { message } = parse(z.object({ message: z.string().trim().min(1).max(60_000).refine(v => v.length <= 2000 || v.startsWith("@osiris-answer:")) }), await c.req.json());
      return runThread(c, ctx, c.req.param("id"), message, a.name);
    });

  const api = new Hono<AuthEnv>()
    .use(userAuth(verifier, project))
    .use(async (c, next) => {
      activity.touch();
      await next();
    })
    // Settings of a feature the project doesn't have are refused, not just hidden in the web app.
    .use(async (c, next) => {
      const route = FEATURE_ROUTES.find(([prefix]) => c.req.path === `/api${prefix}` || c.req.path.startsWith(`/api${prefix}/`));
      if (route) {
        const on = await c.get("ctx").project.features.get();
        if (!route[1].some((f) => on[f])) throw new HttpError(403, "errors.featureOff");
      }
      await next();
    })
    .route("/database", databaseRoutes())

    .get("/threads", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json(await threads.listThreads(project.records, user.sub));
    })

    .post("/threads", async (c) => {
      const { project, user } = c.get("ctx");
      const id = randomUUID();
      await threads.createThread(project.records, user.sub, id, "web");
      return c.json({ id }, 201);
    })

    .get("/threads/:id/messages", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const state = await ctx.project.graph.getState({ configurable: { thread_id: id } });
      return c.json(toThreadMessages(state.values.messages ?? []));
    })

    .get("/threads/:id/state", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      const state = await project.graph.getState({ configurable: { thread_id: id } });
      return c.json({ busy: activeRuns.has(`${project.id}/${id}`), messages: toThreadMessages(state.values.messages ?? []) });
    })
    .get("/threads/:id/questions/:question", async (c) => {
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const question = await project.questions.get(ctx.user.sub, c.req.param("id"), c.req.param("question"));
      if (!question) throw new HttpError(404, "errors.question.notFound");
      return c.json(question);
    })

    .delete("/threads/:id", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      await requireThread(ctx, id);
      await ctx.project.checkpointer.deleteThread(id);
      await ctx.project.checkpointer.deleteDerivedThreads(id);
      await threads.deleteThread(ctx.project.records, id);
      await ctx.project.files.removeTemp(id);
      return c.body(null, 204);
    })

    .post("/threads/:id/runs", async (c) => {
      const ctx = c.get("ctx");
      await requireThread(ctx, c.req.param("id"));
      const { message } = parse(runBody, await c.req.json());
      return runThread(c, ctx, c.req.param("id"), message);
    })

    // Settings come in two scopes: `project` (everyone in the project, admins only) and `personal` (the caller only).

    // The knowledge base: documents in the project's database (not files), indexed as they're saved.
    .get("/knowledge/documents", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json(await project.knowledge.listDocuments(user.sub));
    })
    .post("/knowledge/documents", async (c) => {
      const ctx = c.get("ctx");
      const { title, content, folder, id: exact, scope } = parse(documentBody, await c.req.json());
      requireScope(ctx, scope);
      const owner = ownerOf(ctx, scope);
      let id = exact ?? "";
      if (!exact) {
        const base = `${folder ? `${folder}/` : ""}${slug(title)}`;
        id = `${base}.md`;
        for (let n = 2; await ctx.project.knowledge.getDocument(id, owner); n++) id = `${base}-${n}.md`;
      } else if (await ctx.project.knowledge.getDocument(id, owner)) throw new HttpError(409, "errors.knowledge.exists");
      if (!DOCUMENT_ID.test(id)) throw new HttpError(400, "errors.knowledge.folder");
      await ctx.project.knowledge.putDocument(id, content, title, owner);
      return c.json((await ctx.project.knowledge.listDocuments(ctx.user.sub)).find((d) => d.id === id && d.scope === scope), 201);
    })
    // Without ?scope: the document as the caller sees it (their own copy, else the project's).
    .get("/knowledge/documents/:id{.+}", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      const asked = c.req.query("scope");
      const doc = asked
        ? await ctx.project.knowledge.getDocument(id, ownerOf(ctx, queryScope(asked)))
        : ((await ctx.project.knowledge.getDocument(id, ctx.user.sub)) ?? (await ctx.project.knowledge.getDocument(id)));
      if (!doc) throw new HttpError(404, "errors.knowledge.notFound");
      const { owner, ...rest } = doc;
      return c.json({ ...rest, scope: owner === "" ? "project" : "personal" });
    })
    .put("/knowledge/documents/:id{.+}", async (c) => {
      const ctx = c.get("ctx");
      const id = c.req.param("id");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = ownerOf(ctx, scope);
      if (!(await ctx.project.knowledge.getDocument(id, owner))) throw new HttpError(404, "errors.knowledge.notFound");
      const { title, content } = parse(documentBody, await c.req.json());
      await ctx.project.knowledge.putDocument(id, content, title, owner);
      const { owner: _, ...doc } = (await ctx.project.knowledge.getDocument(id, owner))!;
      return c.json({ ...doc, scope });
    })
    .delete("/knowledge/documents/:id{.+}", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.project.knowledge.deleteDocument(c.req.param("id"), ownerOf(ctx, scope)))) throw new HttpError(404, "errors.knowledge.notFound");
      return c.body(null, 204);
    })

    // Bundled, the project's and the caller's own skills; the ones a higher layer replaces are `overridden`.
    .get("/skills", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json(await project.skills.list(user.sub));
    })

    // ?source=personal|project|bundled for one layer's; without it the one the caller gets.
    .get("/skills/:name", async (c) => {
      const { project, user } = c.get("ctx");
      const source = c.req.query("source");
      if (source !== undefined && !["personal", "project", "bundled"].includes(source)) throw new HttpError(400, "errors.scope.invalid");
      const skill = await project.skills.get(c.req.param("name"), user.sub, source as Skill["source"] | undefined);
      if (!skill) throw new HttpError(404, "errors.skill.notFound");
      return c.json<Skill>(skill);
    })

    .put("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = skillName(c.req.param("name"));
      const { scope, ...skill } = parse(skillBody, await c.req.json());
      requireScope(ctx, scope);
      await fileErrors(() => ctx.project.skills.put({ name, ...skill }, scope, ctx.user.sub));
      return c.json<Skill>((await ctx.project.skills.get(name, ctx.user.sub, scope))!);
    })

    .delete("/skills/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await fileErrors(() => ctx.project.skills.delete(c.req.param("name"), scope, ctx.user.sub)))) {
        throw new HttpError(404, "errors.skill.notFound");
      }
      return c.body(null, 204);
    })

    .get("/mcp-servers", async (c) => {
      const { project, user, role } = c.get("ctx");
      const servers = await project.mcpServers.list(user.sub, { showProjectUrls: role === "admin" });
      return c.json<McpServer[]>(
        await Promise.all(
          servers.map(async (s) => ({
            ...s,
            signedIn: s.auth === "oauth" ? await project.mcp.signedIn(mcpOwner(s.scope, user.sub), s.name) : undefined,
            status: s.enabled ? project.mcp.status(mcpOwner(s.scope, user.sub)).get(s.name) : undefined,
          })),
        ),
      );
    })

    .put("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!MCP_SERVER_NAME.test(name)) throw new HttpError(400, "errors.validation.name");
      const { scope, ...body } = parse(mcpServerBody, await c.req.json());
      requireScope(ctx, scope);
      await checkMcpUrl(ctx, body.url);
      const owner = mcpOwner(scope, ctx.user.sub);
      await ctx.project.mcpServers.put(name, owner, body);
      ctx.project.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    .delete("/mcp-servers/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      if (!(await ctx.project.mcpServers.delete(c.req.param("name"), owner))) {
        throw new HttpError(404, "errors.mcp.notFound");
      }
      ctx.project.mcp.invalidate(owner);
      return c.body(null, 204);
    })

    // Signing in to an OAuth server: the provider's URL to send the user to (null when the sign-in still holds).
    .post("/mcp-servers/:name/sign-in", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      const server = await ctx.project.mcpServers.get(c.req.param("name"), owner);
      if (!server) throw new HttpError(404, "errors.mcp.notFound");
      if (server.auth !== "oauth") throw new HttpError(400, "errors.mcp.notOauth");
      const url = await ctx.project.mcp.startSignIn(server, owner).catch((err: Error) => {
        throw new HttpError(502, "errors.mcp.providerFailed", { detail: detail(err) });
      });
      return c.json({ authorizationUrl: url });
    })
    // The provider sent the user back (web app's /mcp-callback): the code becomes tokens. Only who started it finishes.
    .post("/mcp-oauth/callback", async (c) => {
      const ctx = c.get("ctx");
      const { state, code, iss } = parse(oauthCallbackBody, await c.req.json());
      const pending = await ctx.project.mcp.pendingSignIn(state);
      if (!pending) throw new HttpError(400, "errors.integration.expired");
      requireScope(ctx, pending.owner === "" ? "project" : "personal");
      if (pending.owner !== "" && pending.owner !== ctx.user.sub) throw new HttpError(403, "errors.mcp.otherUser");
      const done = await ctx.project.mcp.finishSignIn(state, code, iss).catch((err: Error) => {
        throw new HttpError(502, "errors.mcp.finishFailed", { detail: detail(err) });
      });
      if (!done) throw new HttpError(400, "errors.signIn.expiredRetry");
      return c.json({ name: done.name, scope: done.owner === "" ? "project" : "personal" });
    })

    // Connects once with the stored configuration and reports the tools (or the error).
    .post("/mcp-servers/:name/test", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      const owner = mcpOwner(scope, ctx.user.sub);
      const server = await ctx.project.mcpServers.get(c.req.param("name"), owner);
      if (!server) throw new HttpError(404, "errors.mcp.notFound");
      return c.json(await ctx.project.mcp.test(server, owner));
    })

    .get("/settings", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json<UserSettings>(await project.settings.get(user.sub));
    })

    // The assistant's persona: the user's own and (admins) a public assistant's.
    .get("/assistant", async (c) => {
      const { project, user, role } = c.get("ctx");
      const assistant = c.req.query("assistant");
      const [personal, open] = await Promise.all([
        project.profiles.get(user.sub),
        assistant && role === "admin" ? project.profiles.get(publicProfile(assistant)) : undefined,
      ]);
      return c.json<AssistantProfiles>({ personal, ...(open ? { public: open } : {}) });
    })
    // ?scope=personal, or public&assistant=<name> (a public assistant's, admins). The project has none.
    .put("/assistant", async (c) => {
      const ctx = c.get("ctx");
      const which = c.req.query("scope");
      const profile = parse(profileBody, await c.req.json());
      if (which === "personal") {
        await ctx.project.profiles.put(ctx.user.sub, profile);
        return c.json<AssistantProfile>(profile);
      }
      if (which !== "public") throw new HttpError(400, "errors.persona.scope");
      requireAdmin(ctx);
      const a = await ctx.project.publicAssistants.get(c.req.query("assistant") ?? "");
      if (!a || c.req.query("assistant") !== a.name) throw new HttpError(404, "errors.assistant.notFound");
      await ctx.project.profiles.put(publicProfile(a.name), profile);
      return c.json<AssistantProfile>(profile);
    })
    // Guards: the system's (read-only here), the project's and the public assistants' (admins write), the caller's own.
    .get("/guards", async (c) => {
      const { project, user, role } = c.get("ctx");
      const [system, own, mine] = await Promise.all([project.features.systemGuards(), project.guards.list({ level: "project" }), project.guards.list({ level: "user", userId: user.sub })]);
      const assistants =
        role === "admin" && (await project.features.get()).public
          ? Object.fromEntries(
              await Promise.all((await project.publicAssistants.list()).map(async (a) => [a.name, await project.guards.list({ level: "assistant", assistant: a.name })] as const)),
            )
          : undefined;
      return c.json<Guards>({ system, project: own, user: mine, ...(assistants ? { assistants } : {}) });
    })
    .put("/guards/:level/:name", async (c) => {
      const ctx = c.get("ctx");
      const owner = await guardOwner(ctx, c.req.param("level"), c.req.query("assistant"));
      const name = c.req.param("name");
      if (!GUARD_NAME.test(name) || name.length > 60) throw new HttpError(400, "errors.validation.name");
      const guard = { name, ...parse(guardBody, await c.req.json()) };
      await fileErrors(() => ctx.project.guards.put(owner, guard));
      return c.json<Guard>(guard);
    })
    .delete("/guards/:level/:name", async (c) => {
      const ctx = c.get("ctx");
      const owner = await guardOwner(ctx, c.req.param("level"), c.req.query("assistant"));
      if (!(await ctx.project.guards.delete(owner, c.req.param("name")))) throw new HttpError(404, "errors.guard.notFound");
      return c.body(null, 204);
    })
    // Expands a persona brief; nothing is saved until the (edited) profile is put.
    .post("/assistant/persona", async (c) => {
      const { project, user } = c.get("ctx");
      const input = parse(z.union([z.object({ description: z.string().trim().min(1).max(2000) }), personaBody]), await c.req.json());
      const character = "description" in input ? CUSTOM_PERSONA : input.character;
      const source = "description" in input ? "" : input.source;
      const quotas = await project.features.quotas();
      if (quotas.tokensPerMonth !== null && (await project.usage.tokens()) >= quotas.tokensPerMonth) throw new HttpError(429, TOKENS_EXHAUSTED);
      if (quotas.tokensPerUserMonth !== null && (await project.usage.tokens(Date.now(), { user: user.sub })) >= quotas.tokensPerUserMonth) {
        throw new HttpError(429, USER_TOKENS_EXHAUSTED);
      }
      const { description, tokens } = await describePersona(project.personaModel, "description" in input ? input.description : character, "description" in input ? undefined : source);
      await project.usage.add(tokens, Date.now(), { user: user.sub });
      return c.json<Persona>({ character, source, description });
    })

    // The public assistants (the project's customers): their settings for admins, the inquiries they took for everyone.
    .get("/public-assistants", async (c) => {
      requireAdmin(c.get("ctx"));
      return c.json<PublicAssistantSettings[]>(await c.get("ctx").project.publicAssistants.list());
    })
    .put("/public-assistants/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!PUBLIC_ASSISTANT_NAME.test(name) || name.length > 40) throw new HttpError(400, "errors.validation.name");
      const settings = { ...parse(publicSettingsBody, await c.req.json()), name };
      await ctx.project.publicAssistants.put(settings);
      return c.json<PublicAssistantSettings>(settings);
    })
    .delete("/public-assistants/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.project.publicAssistants.delete(c.req.param("name")))) throw new HttpError(404, "errors.assistant.notFound");
      await ctx.project.guards.deleteAll({ level: "assistant", assistant: c.req.param("name") });
      return c.body(null, 204);
    })
    .get("/inquiries", async (c) => c.json<Inquiry[]>(await c.get("ctx").project.inquiries.list()))
    .patch("/inquiries/:id", async (c) => {
      const { status } = parse(z.object({ status: z.enum(["new", "done"]) }), await c.req.json());
      if (!(await c.get("ctx").project.inquiries.setStatus(c.req.param("id"), status))) throw new HttpError(404, "errors.inquiry.notFound");
      return c.body(null, 204);
    })
    // The conversation an inquiry came from, for the project's people.
    .get("/inquiries/:id/messages", async (c) => {
      const { project } = c.get("ctx");
      const inquiry = (await project.inquiries.list()).find((i) => i.id === c.req.param("id"));
      if (!inquiry?.threadId) throw new HttpError(404, "errors.thread.notFound");
      const state = await project.graph.getState({ configurable: { thread_id: inquiry.threadId } });
      return c.json<ThreadMessage[]>(toThreadMessages(state.values.messages ?? []));
    })

    .get("/integrations/standard", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json(await project.standardAccounts.list(user.sub));
    })
    .put("/integrations/standard/:name", async (c) => {
      const { project, user } = c.get("ctx");
      const name = parse(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64), c.req.param("name"));
      await project.standardAccounts.put(user.sub, name, parse(standardAccountSchema, await c.req.json()));
      return c.json({ ok: true });
    })
    .delete("/integrations/standard/:name", async (c) => {
      const { project, user } = c.get("ctx");
      await project.standardAccounts.delete(user.sub, c.req.param("name"));
      return c.json({ ok: true });
    })

    // The caller's Google and Microsoft accounts (personal: only they connect and use them).
    .get("/integrations", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json<Integration[]>(await project.integrations.list(user.sub));
    })
    .post("/integrations/:provider/connect", async (c) => {
      const { project, user } = c.get("ctx");
      const provider = parse(z.enum(["google", "microsoft"]), c.req.param("provider"));
      if (!project.integrations.available().includes(provider)) throw new HttpError(404, "errors.integration.providerOff");
      return c.json({ authorizationUrl: await project.integrations.start(user.sub, provider) });
    })
    .delete("/integrations/:provider", async (c) => {
      const { project, user } = c.get("ctx");
      await project.integrations.disconnect(user.sub, parse(z.enum(["google", "microsoft"]), c.req.param("provider")));
      return c.body(null, 204);
    })
    // The provider sent the user back (web app's /integration-callback); only the user who started it finishes it.
    .post("/integrations/callback", async (c) => {
      const { project, user } = c.get("ctx");
      const { state, code } = parse(oauthCallbackBody, await c.req.json());
      const pending = await project.integrations.pending(state);
      if (!pending || pending.owner !== user.sub) throw new HttpError(400, "errors.integration.expiredOrOther");
      const done = await project.integrations.finish(state, code).catch((err: Error) => {
        throw new HttpError(502, "errors.integration.failed", { detail: detail(err) });
      });
      return c.json({ provider: done.provider, account: done.account });
    })

    // How much of its quotas the project uses, for the meters above the project in the sidebar.
    .get("/usage", async (c) => {
      const { project, user } = c.get("ctx");
      const [quotas, storage, storageLimit, tokens, userTokens, tables, database, counted] = await Promise.all([
        project.features.quotas(),
        project.files.usage(),
        project.files.quotaInForce(),
        project.usage.tokens(),
        project.usage.tokens(Date.now(), { user: user.sub }),
        project.data.tableCount(),
        project.data.size(),
        counts?.() ?? { members: 0, schedules: 0, dashboards: 0 },
      ]);
      return c.json<ProjectUsage>({
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
    // Tokens this month by member and by public assistant, and the project's per month; a member sees only themselves.
    .get("/usage/breakdown", async (c) => {
      const { project, user, role } = c.get("ctx");
      const b = await project.usage.breakdown();
      return c.json<UsageBreakdown>({ ...b, users: role === "admin" ? b.users : b.users.filter((u) => u.userId === user.sub) });
    })

    // The assistant's built-in tools and whether each is available (its feature on, not switched off).
    .get("/tools", async (c) => {
      const { project } = c.get("ctx");
      const [on, off] = await Promise.all([project.features.get(), project.features.disabledTools()]);
      return c.json<BuiltinTool[]>(
        project.builtinTools.map(([feature, t]) => ({ name: t.name, description: t.description, feature, featureOn: on[feature], disabled: off.includes(t.name) })),
      );
    })

    .put("/settings", async (c) => {
      const { project, user } = c.get("ctx");
      const settings = parse(settingsBody, await c.req.json());
      await project.settings.put(user.sub, settings);
      return c.json<UserSettings>(settings);
    })

    .get("/memories", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json(await project.memory.list(user.sub, 1000));
    })

    .post("/memories", async (c) => {
      const ctx = c.get("ctx");
      const { content, scope, overrides } = parse(memoryBody, await c.req.json());
      requireScope(ctx, scope);
      if (overrides && scope !== "personal") throw new HttpError(400, "errors.memory.overrideOwn");
      try {
        return c.json(await ctx.project.memory.add(ctx.user.sub, content, scope, overrides), 201);
      } catch {
        throw new HttpError(404, "errors.memory.notFound");
      }
    })

    .delete("/memories/:id", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.project.memory.delete(c.req.param("id"), scope, ctx.user.sub))) {
        throw new HttpError(404, "errors.memory.notFound");
      }
      return c.body(null, 204);
    })

    // Full-text search in the project's text files and the caller's own (`scope` limits it to one of them).
    .get("/files/search", async (c) => {
      const { project, user } = c.get("ctx");
      const q = (c.req.query("q") ?? "").slice(0, 200);
      const scope = c.req.query("scope");
      const owners = scope === "project" ? [""] : scope === "personal" ? [user.sub] : ["", user.sub];
      const hits = await project.fileIndex.search(q, owners, 50);
      return c.json<FileSearchHit[]>(hits.map((h) => ({ scope: h.owner ? "personal" : "project", path: h.path, snippet: h.snippet })));
    })

    .get("/files", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      return c.json<FileEntry[]>(await fileErrors(() => ctx.project.files.list(loc, q.path ?? "")));
    })

    // Always a download: project files may be HTML or SVG, which must never render on the app's origin.
    .get("/files/content", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      const { entry, data } = await fileErrors(() => ctx.project.files.read(loc, q.path ?? ""));
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
      async (c, next) => bodyLimit({ maxSize: c.get("ctx").project.files.limits.maxFileBytes, onError: (c) => c.json({ error: translate(requestLocale(c.req.header("accept-language")), "errors.files.uploadTooLarge"), code: "errors.files.uploadTooLarge" }, 413) })(c, next),
      async (c) => {
        const ctx = c.get("ctx");
        const q = fileQuery(c);
        requireFileWrite(ctx, q.scope, q.path);
        const loc = await fileLocation(ctx, q.scope, q.thread);
        const data = new Uint8Array(await c.req.arrayBuffer());
        const overwrite = c.req.query("overwrite") === "true";
        return c.json<FileEntry>(await fileErrors(() => ctx.project.files.write(loc, q.path ?? "", data, { overwrite })), 201);
      },
    )

    .post("/files/dir", async (c) => {
      const ctx = c.get("ctx");
      const body = parse(fileRef, await c.req.json());
      requireFileWrite(ctx, body.scope, body.path);
      const loc = await fileLocation(ctx, body.scope, body.thread);
      return c.json<FileEntry>(await fileErrors(() => ctx.project.files.mkdir(loc, body.path)), 201);
    })

    .post("/files/move", async (c) => {
      const ctx = c.get("ctx");
      const { from, to } = parse(moveBody, await c.req.json());
      requireFileWrite(ctx, from.scope, from.path);
      requireFileWrite(ctx, to.scope, to.path);
      const [src, dst] = [await fileLocation(ctx, from.scope, from.thread), await fileLocation(ctx, to.scope, to.thread)];
      return c.json<FileEntry>(await fileErrors(() => ctx.project.files.move(src, from.path, dst, to.path)));
    })

    .delete("/files", async (c) => {
      const ctx = c.get("ctx");
      const q = fileQuery(c);
      requireFileWrite(ctx, q.scope, q.path);
      const loc = await fileLocation(ctx, q.scope, q.thread);
      await fileErrors(() => ctx.project.files.delete(loc, q.path ?? ""));
      return c.body(null, 204);
    })

    // The project's VitePress sites (vitepress/<site>/, built into www/<site>/): admins create, build and remove them.
    .get("/vitepress-sites", async (c) => {
      const { project } = c.get("ctx");
      return c.json({ sites: await listSites(project.files), builder: !!project.vitepress });
    })
    .post("/vitepress-sites", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { name } = parse(z.object({ name: z.string().trim().toLowerCase().max(60) }), await c.req.json());
      await fileErrors(() => createSite(ctx.project.files, name));
      return c.json({ name }, 201);
    })
    .post("/vitepress-sites/:name/build", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!ctx.project.vitepress) throw new HttpError(503, "errors.vitepress.off");
      const name = c.req.param("name");
      if (!SITE_NAME.test(name)) throw new HttpError(400, "errors.sites.invalidName");
      const result = await fileErrors(() => buildSite(ctx.project.files, ctx.project.vitepress!, name)).catch((err: Error) => {
        if (err instanceof HTTPException || err instanceof HttpError) throw err;
        throw new HttpError(502, "errors.vitepress.buildFailed", { detail: detail(err) });
      });
      return c.json({ ...result, message: describeBuild(result) });
    })
    .delete("/vitepress-sites/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!(await listSites(ctx.project.files)).includes(name)) throw new HttpError(404, "errors.sites.notFound");
      await fileErrors(() => ctx.project.files.delete({ scope: "project" }, `${VITEPRESS_DIR}/${name}`));
      await ctx.project.files.delete({ scope: "project" }, `www/${name}`).catch(() => {});
      return c.body(null, 204);
    })

    // Where the project's website is published over SFTP (its VPS at vas-hosting.cz…): admins manage and publish.
    .get("/site-targets", async (c) => {
      requireAdmin(c.get("ctx"));
      return c.json<SiteTarget[]>(await c.get("ctx").project.siteTargets.list());
    })
    .put("/site-targets/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const name = c.req.param("name");
      if (!MCP_SERVER_NAME.test(name)) throw new HttpError(400, "errors.validation.name");
      const body = parse(siteTargetBody, await c.req.json());
      await ctx.project.siteTargets.put(name, body).catch((err: Error) => {
        throw new HttpError(400, "errors.sftp.saveFailed", { detail: detail(err) });
      });
      return c.body(null, 204);
    })
    .delete("/site-targets/:name", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      if (!(await ctx.project.siteTargets.delete(c.req.param("name")))) throw new HttpError(404, "errors.sftp.targetMissing");
      return c.body(null, 204);
    })
    // Connects and lists the target folder (pins the server's host key on the first connection).
    .post("/site-targets/:name/test", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const entries = await testTarget(ctx.project.siteTargets, c.req.param("name")).catch((err: Error) => {
        throw new HttpError(502, "errors.sftp.connectFailed", { detail: detail(err) });
      });
      return c.json({ entries });
    })
    .post("/site-targets/:name/publish", async (c) => {
      const ctx = c.get("ctx");
      requireAdmin(ctx);
      const { dir } = parse(z.object({ dir: z.string().max(512).default("www") }), await c.req.json().catch(() => ({})));
      const result = await fileErrors(() => publishSftp(ctx.project.files, { scope: "project" }, dir, ctx.project.siteTargets, c.req.param("name"))).catch(
        (err: Error) => {
          if (err instanceof HTTPException || err instanceof HttpError) throw err;
          throw new HttpError(502, "errors.sftp.publishFailed", { detail: detail(err) });
        },
      );
      return c.json<PublishResult>(result);
    })

    // Secrets are write-only: the list has names, hosts and descriptions, never values.
    .get("/secrets", async (c) => {
      const { project, user } = c.get("ctx");
      return c.json<SecretSummary[]>(await project.secrets.list(user.sub));
    })

    .put("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const name = c.req.param("name");
      if (!SECRET_NAME.test(name)) throw new HttpError(400, "errors.secret.name");
      const { scope, ...body } = parse(secretBody, await c.req.json());
      requireScope(ctx, scope);
      try {
        await ctx.project.secrets.put(name, secretOwner(scope, ctx.user.sub), body);
      } catch (err) {
        if (err instanceof SecretUseError) throw new HttpError(400, err.key, err.params);
        throw err;
      }
      // MCP servers may use the secret: reconnect with the new value.
      ctx.project.mcp.invalidateAll();
      return c.body(null, 204);
    })

    .delete("/secrets/:name", async (c) => {
      const ctx = c.get("ctx");
      const scope = queryScope(c.req.query("scope"));
      requireScope(ctx, scope);
      if (!(await ctx.project.secrets.delete(c.req.param("name"), secretOwner(scope, ctx.user.sub)))) {
        throw new HttpError(404, "errors.secret.missing");
      }
      ctx.project.mcp.invalidateAll();
      return c.body(null, 204);
    });

  const internal = createInternalRoutes({ project, verifier, activity, snapshot, activeRuns });

  return new Hono()
    .use(telemetryMiddleware())
    .use(async (c, next) => {
      // Shutting down for sleep: the caller wakes the runtime again and retries.
      if (activity.sleeping && c.req.path !== "/health") return c.json({ error: "Runtime is going to sleep" }, 503, { [SLEEPING_HEADER]: "1" });
      await next();
    })
    .get("/health", (c) => c.json({ ok: true, project: project.id }))
    .route("/api", api)
    .route("/public", pub)
    .route("/internal", internal)
    .onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      const localized = errorResponse(err, requestLocale(c.req.header("accept-language")));
      if (localized) return c.json(localized.body, localized.status);
      console.error(err);
      return c.json({ error: "Internal server error" }, 500);
    });
}
