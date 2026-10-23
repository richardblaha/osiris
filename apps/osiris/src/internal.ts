import { AttachmentError, attachmentInput, attachmentMessage } from "@osiris/core/agent/attachments.ts";
import { FILE_TYPES, fileType } from "@osiris/shared";
import { displayUserText, QuestionError } from "@osiris/core/agent/questions.ts";
import { randomUUID } from "node:crypto";
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { RunContext } from "@osiris/core/agent/context.ts";
import * as threads from "@osiris/core/repo/threads.ts";
import * as sessions from "@osiris/core/repo/whatsapp.ts";
import type { Project } from "@osiris/core/projects/project.ts";
import type { InternalVerifier } from "@osiris/platform/internal-auth.ts";
import type { Activity } from "./activity.ts";
import { verifyCall, type AuthEnv } from "./auth.ts";
import { idName } from "@osiris/core/projects/records.ts";
import { configuredLocale, HttpError, ValidationError } from "@osiris/platform/i18n.ts";

const scheduledRun = z.object({ title: z.string().min(1).max(100), prompt: z.string().min(1).max(4000), idempotencyKey: z.string().min(1).max(200) });
const whatsappMessage = z.object({ messageId: z.string().min(1).max(200), text: z.string().min(1).max(20_000), attachment: z.object({ name: z.string().max(200), mime: z.string().max(100), data: z.string().max(28_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).optional() });

/** A run's stored answer, so a repeated request (lost lease, redelivery) doesn't run the agent twice. */
async function once(project: Project, key: string, work: () => Promise<{ threadId: string; reply: string }>) {
  const file = `private/runs/${idName(key)}.json`;
  const done = await project.records.read<{ threadId: string; reply: string }>(file);
  if (done) return done;
  const result = await work();
  await project.records.write(file, { threadId: result.threadId, reply: result.reply });
  return result;
}

export function createInternalRoutes({
  project,
  verifier,
  activity,
  snapshot,
  activeRuns,
}: {
  project: Project;
  verifier: InternalVerifier;
  activity: Activity;
  snapshot: (reason: string) => Promise<{ key: string; bytes: number }>;
  activeRuns: Set<string>;
}) {
  const invoke = async (ctx: RunContext, text: string) => {
    const key = `${project.id}/${ctx.thread_id}`;
    if (activeRuns.has(key)) throw new HttpError(409, "errors.run.inProgress");
    activeRuns.add(key);
    try {
      const decoded = attachmentInput(text);
      try { text = await project.questions.prepare(ctx.user_id, ctx.thread_id, decoded.text); }
      catch (err) { if (err instanceof QuestionError || err instanceof AttachmentError) throw new HttpError(400, err.key, err.params); throw err; }
      const { messages } = await activity.track(async () => {
        const quota = await project.features.quotas();
        if (decoded.paths.length && (!(await project.features.get()).files || (quota.tokensPerMonth !== null && await project.usage.tokens() >= quota.tokensPerMonth) || (quota.tokensPerUserMonth !== null && await project.usage.tokens(Date.now(), { user: ctx.user_id }) >= quota.tokensPerUserMonth))) throw new HttpError(403, "errors.attachment.unavailable");
        const input = decoded.paths.length ? await attachmentMessage(project.files, project.media, ctx.thread_id, text, decoded.paths, n => project.usage.add(n, Date.now(), { user: ctx.user_id }), ctx.locale, decoded.voice) : new HumanMessage({ content: text, additional_kwargs: { display_text: displayUserText(text, ctx.locale) } });
        return project.graph.invoke({ messages: [input] }, { configurable: { ...ctx } });
      });
      const last = messages.at(-1);
      return last?.getType() === "ai" ? last.text : "";
    } finally { activeRuns.delete(key); }
  };

  const offeredFiles = async (threadId: string) => {
    const state = await project.graph.getState({ configurable: { thread_id: threadId } });
    const messages = state.values.messages ?? [];
    const start = messages.findLastIndex((m: unknown) => HumanMessage.isInstance(m));
    const calls = new Set(messages.slice(start).filter((m: unknown) => AIMessage.isInstance(m)).flatMap((m: AIMessage) => (m.tool_calls ?? []).filter(c => c.name === "send_chat_file" || ["image_generate", "image_edit", "image_variations", "image_generate_spritesheet", "image_get_status", "image_assemble_spritesheet", "image_contact_sheet"].includes(c.name)).map(c => c.id)));
    return messages.slice(start).filter((m: unknown) => ToolMessage.isInstance(m)).flatMap((m: ToolMessage) => {
      if (!calls.has(m.tool_call_id)) return [];
      try { const v = JSON.parse(m.text); return v.file ? [v.file as { scope: "temp" | "project"; path: string; mime: string }] : (v.status === "completed" || v.artifacts ? v.artifacts ?? v.result?.artifacts ?? [] : []); } catch { return []; }
    }).slice(0, 5);
  };

  /** Control's calls on behalf of a user: the token names the user, their role and the channel. */
  const asUser = (call: AuthEnv["Variables"]["call"]) => {
    if (!call.user || !call.role || call.project !== project.id) throw new HTTPException(401, { message: "Unauthorized" });
    return { user: call.user, role: call.role, channel: call.channel ?? "web" };
  };

  return new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set("call", await verifyCall(verifier, project, c.req.header("authorization"), ["control", "operator"]));
      await next();
    })

    .get("/activity", (c) => c.json({ lastActivity: activity.lastActivity, activeRuns: activity.activeRuns, sleeping: activity.sleeping }))

    // Before sleeping (reason=sleep) the runtime stops taking requests, so nothing changes after the snapshot.
    .post("/snapshot", async (c) => {
      const reason = c.req.query("reason") ?? "manual";
      if (reason === "sleep") {
        if (activity.activeRuns > 0) return c.json({ error: "Runs in progress" }, 409);
        activity.sleeping = true;
      }
      try {
        return c.json(await snapshot(reason));
      } catch (err) {
        activity.sleeping = false;
        throw err;
      }
    })

    // A scheduled task (control): runs the prompt as its owner in a new thread, which shows in the owner's web chat.
    .post("/runs", async (c) => {
      const { user, role, channel } = asUser(c.get("call"));
      const body = scheduledRun.safeParse(await c.req.json());
      if (!body.success) throw new ValidationError(body.error);
      const { title, prompt, idempotencyKey } = body.data;
      return c.json(
        await once(project, `schedule:${idempotencyKey}`, async () => {
          const threadId = randomUUID();
          await threads.createThread(project.records, user.sub, threadId, "web");
          await threads.touchThread(project.records, threadId, `⏰ ${title}`);
          const reply = await invoke(
            { thread_id: threadId, project_id: project.id, user_id: user.sub, role, channel, user_name: user.name ?? undefined, locale: configuredLocale() },
            `[Plánovaná úloha „${title}“, spuštěná automaticky bez přítomnosti uživatele. Udělej ji a výsledek shrň.]\n\n${prompt}`,
          );
          return { threadId, reply };
        }),
      );
    })

    // A WhatsApp message (control found the user and the project): runs in the user's WhatsApp thread.
    .post("/whatsapp/message", async (c) => {
      const { user, role } = asUser(c.get("call"));
      const body = whatsappMessage.safeParse(await c.req.json());
      if (!body.success) throw new ValidationError(body.error);
      const { messageId, text } = body.data;
      const { reply } = await once(project, `whatsapp:${messageId}`, async () => {
        const threadId = await whatsappThread(project, user.sub);
        await threads.touchThread(project.records, threadId, text);
        let message = text;
        if (body.data.attachment) {
          if (!(await project.features.get()).files) throw new HttpError(403, "errors.files.featureOff");
          const a = body.data.attachment;
          const mime = a.mime.split(";")[0]!;
          const ext = Object.entries(FILE_TYPES).find(([, type]) => type.mime === mime)?.[0];
          if (!ext) throw new HttpError(400, "errors.attachment.unsupported");
          const filename = a.name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "").slice(-100) || "priloha";
          const path = `wa-${messageId.replace(/[^a-zA-Z0-9]/g, "").slice(-40)}-${fileType(filename)?.mime === mime ? filename : `${filename}.${ext}`}`;
          await project.files.write({ scope: "temp", threadId }, path, Buffer.from(a.data, "base64"));
          message = `@osiris-attachments:${JSON.stringify({ text, paths: [path] })}`;
        }
        const answer = await invoke(
          { thread_id: threadId, project_id: project.id, user_id: user.sub, role, channel: "whatsapp", user_name: user.name ?? undefined, locale: configuredLocale() },
          message,
        );
        return { threadId, reply: answer };
      });
      const threadId = await whatsappThread(project, user.sub);
      return c.json({ reply, threadId, question: await project.questions.get(user.sub, threadId), files: await offeredFiles(threadId) });
    })

    .post("/whatsapp/file", async (c) => {
      const { user } = asUser(c.get("call"));
      if (!(await project.features.get()).files) throw new HTTPException(403);
      const { threadId, scope, path } = z.object({ threadId: z.string(), scope: z.enum(["project", "temp"]), path: z.string().max(300) }).parse(await c.req.json());
      if (!(await threads.ownsThread(project.records, user.sub, threadId)) || !(await offeredFiles(threadId)).some((f: { scope: string; path: string }) => f.scope === scope && f.path === path)) throw new HTTPException(404);
      const file = await project.files.read(scope === "temp" ? { scope, threadId } : { scope }, path);
      if (file.data.length > 20 * 1024 * 1024) throw new HTTPException(413);
      return c.json({ data: file.data.toString("base64"), name: path.split("/").at(-1), mime: fileType(path)!.mime });
    })
    .post("/whatsapp/new-thread", async (c) => {
      const { user } = asUser(c.get("call"));
      await sessions.setThread(project.records, user.sub, null);
      return c.body(null, 204);
    });
}

/** The user's current WhatsApp thread, created if there is none (or it was deleted on the web). */
async function whatsappThread(project: Project, userId: string): Promise<string> {
  const session = await sessions.getSession(project.records, userId);
  if (session?.threadId && (await threads.ownsThread(project.records, userId, session.threadId))) return session.threadId;
  const id = randomUUID();
  await threads.createThread(project.records, userId, id, "whatsapp");
  await sessions.setThread(project.records, userId, id);
  return id;
}
