import type { QuestionStore } from "./questions.ts";
import type { AgentModels } from "./model.ts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { DbTable, Persona } from "@osiris/shared";
import { breaksRules, GUARD_REFUSAL, hasRules, type GuardRules } from "./assistant.ts";
import { getRunContext, type RunContext } from "./context.ts";
import type { MemoryStore } from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { UserSettingsStore } from "./settings.ts";
import type { SkillStore } from "./skills.ts";
import type { UsageStore } from "./usage.ts";
import type { SecretVault } from "../vault/vault.ts";
import type { FeatureSource } from "../tenants/features.ts";
import { DEFAULT_FEATURES } from "../tenants/features.ts";
import { configuredLocale, translate } from "@osiris/platform/i18n.ts";
import { LOCALES } from "@osiris/shared";

export interface AgentDeps {
  /** The tenant this graph serves; runs carrying another `tenant_id` are refused. */
  tenantId: string;
  model: BaseChatModel;
  questions?: QuestionStore;
  images?: (thread: string, paths: string[]) => Promise<{ type: "image_url"; image_url: { url: string } }[]>;
  /** System-selected models for agent steps, tool follow-ups and guard checks. */
  models?: AgentModels;
  /** Tools bound to this tenant's stores. */
  tools: StructuredToolInterface[];
  /** Tools that can change between turns or differ per user (MCP servers), resolved on every model and tool step. */
  dynamicTools?: (ctx: RunContext) => Promise<StructuredToolInterface[]>;
  checkpointer: BaseCheckpointSaver;
  timezone: string;
  /** Listed in the system prompt on every call, so edits apply from the next turn. */
  skills?: SkillStore;
  /** The user's memories are injected into the system prompt on every call. */
  memory?: MemoryStore;
  /** The user's profile ("Můj profil") is added to the system prompt. */
  settings?: UserSettingsStore;
  /** Names of the secrets the user can use (never values) are listed in the system prompt. */
  secrets?: SecretVault;
  /** Switched-off features drop out of the prompt too (skills, memory, secrets, knowledge rule). */
  features?: FeatureSource;
  /** Counts the model's tokens per month; with a quota set, the agent stops answering once it's used up. */
  usage?: UsageStore;
  /** The rules (system, tenant, user) for a run: in the prompt, and every message and answer is checked against them. */
  rules?: (ctx: RunContext) => Promise<GuardRules>;
  /** The persona for a run: the user's own, or the system's default. */
  persona?: (ctx: RunContext) => Promise<Persona | null>;
  /** Runs on the `public` channel (the tenant's customers) get this prompt instead, and their own token quota. */
  publicPrompt?: (ctx: RunContext) => Promise<string>;
  publicLimit?: (ctx: RunContext) => Promise<number | null>;
  /** The tenant database's tables, listed in the prompt while the feature is on. */
  database?: () => Promise<DbTable[]>;
}

/** What a customer gets when the public assistant's (or the tenant's) quota is used up (catalog keys, like the two below). */
export const PUBLIC_UNAVAILABLE = "agent.publicUnavailable";
export const TOKENS_EXHAUSTED = "agent.tokensExhausted";
export const USER_TOKENS_EXHAUSTED = "agent.userTokensExhausted";

/** A text the run writes itself, in the run's language. */
const say = (ctx: RunContext | undefined, key: string) => translate(ctx?.locale ?? configuredLocale(), key);
/** The quota notices in every language: they are never checked against the rules. */
const NOTICES = new Set(LOCALES.flatMap((l) => [PUBLIC_UNAVAILABLE, TOKENS_EXHAUSTED, USER_TOKENS_EXHAUSTED].map((k) => translate(l, k))));

/** ReAct loop: `agent` calls the model, `tools` executes requested tool calls, repeat until the model answers. */
export function createAgentGraph(deps: AgentDeps) {
  const { tenantId, model, tools, dynamicTools, checkpointer, timezone, skills, memory, settings, secrets, features, usage, rules, persona, publicPrompt, publicLimit, database } =
    deps;
  for (const chat of [deps.models?.agent ?? model, deps.models?.tools ?? model]) {
    if (!chat.bindTools) throw new Error("Chat model does not support tool calling");
  }
  const allTools = async (ctx: RunContext) => {
    // A workflow's step has nobody to ask: its approvals are the workflow's own.
    const own = ctx.workflow ? tools.filter((t) => t.name !== "ask_user") : tools;
    return dynamicTools ? [...own, ...(await dynamicTools(ctx))] : own;
  };

  /** Which quota is used up: the tenant's, or the run's own (the member's, or the public assistant's); null for none. */
  const exhausted = async (ctx?: RunContext): Promise<string | null> => {
    if (!usage) return null;
    const quotas = await features?.quotas();
    const limit = quotas?.tokensPerMonth ?? null;
    if (limit !== null && (await usage.tokens()) >= limit) return ctx?.channel === "public" ? PUBLIC_UNAVAILABLE : TOKENS_EXHAUSTED;
    if (ctx?.channel === "public") {
      const own = (await publicLimit?.(ctx)) ?? null;
      return own !== null && (await usage.tokens(Date.now(), { public: ctx.assistant })) >= own ? PUBLIC_UNAVAILABLE : null;
    }
    const perUser = quotas?.tokensPerUserMonth ?? null;
    return ctx && perUser !== null && (await usage.tokens(Date.now(), { user: ctx.user_id })) >= perUser ? USER_TOKENS_EXHAUSTED : null;
  };
  const count = (ctx: RunContext, tokens: number) =>
    usage?.add(tokens, Date.now(), ctx.channel === "public" ? { public: ctx.assistant } : { user: ctx.user_id });
  const noRules: GuardRules = { system: "", tenant: "", user: "" };

  /** Checks a message against the rules; null when there are none to check (or the quota is used up). */
  const check = async (config: RunnableConfig, kind: "input" | "output", text: string) => {
    const ctx = getRunContext(config);
    const r = (await rules?.(ctx)) ?? noRules;
    if (!hasRules(r) || !text.trim() || (await exhausted(ctx))) return null;
    const result = await breaksRules(deps.models?.guard ?? model, r, kind, text).catch((err) => {
      console.error("Guard check failed", err);
      return { breaks: false, tokens: 0 };
    });
    await count(ctx, result.tokens);
    return result.breaks;
  };

  /** The user's message breaking the rules gets a refusal, and the agent doesn't see it. */
  const guardInput = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const last = state.messages.at(-1);
    if (!HumanMessage.isInstance(last) || !(await check(config, "input", last.text))) return {};
    return { messages: [new AIMessage(say(getRunContext(config), GUARD_REFUSAL))] };
  };

  /** A final answer breaking the rules is replaced (same id) by a refusal, in the history too. */
  const guardOutput = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const last = state.messages.at(-1);
    if (!AIMessage.isInstance(last) || NOTICES.has(last.text) || !(await check(config, "output", last.text))) return {};
    return { messages: [new AIMessage({ id: last.id, content: say(getRunContext(config), GUARD_REFUSAL) })] };
  };

  const callModel = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const ctx = getRunContext(config);
    if (ctx.tenant_id !== tenantId) throw new Error(`Run for tenant ${ctx.tenant_id} sent to graph of ${tenantId}`);
    const on = (await features?.get()) ?? DEFAULT_FEATURES;
    const used = await exhausted(ctx);
    if (used) return { messages: [new AIMessage(say(ctx, used))] };
    // The system prompt is not stored in the checkpoint, so it can change (date, channel, skills, memory) between turns.
    const availableTools = await allTools(ctx);
    const system = new SystemMessage(
      ctx.channel === "public" && publicPrompt ? await publicPrompt(ctx) : buildSystemPrompt({
        channel: ctx.channel,
        timezone,
        knowledge: on.knowledge,
        files: on.files,
        imageToolNames: availableTools.filter(t => t.name.startsWith("image_")).map(t => t.name),
        skills: on.skills ? (await skills?.list())?.filter((s) => !s.requires || on[s.requires]) : undefined,
        memories: on.memory ? await memory?.list(ctx.user_id) : undefined,
        userName: ctx.user_name,
        settings: await settings?.get(ctx.user_id),
        secrets: on.http || on.mcp ? await secrets?.list(ctx.user_id) : undefined,
        database: on.database ? await database?.() : undefined,
        rules: await rules?.(ctx),
        persona: await persona?.(ctx),
      }),
    );
    const selected = deps.models ? (ToolMessage.isInstance(state.messages.at(-1)) ? deps.models.tools : deps.models.agent) : model;
    if (!selected.bindTools) throw new Error("Selected model does not support tool calling");
    // Image bytes are request-only: checkpoints retain references, so temp-file expiry also removes the image.
    const messages = [...state.messages];
    const latest = messages.findLastIndex(m => HumanMessage.isInstance(m));
    const human = messages[latest];
    const paths = human?.additional_kwargs.image_paths;
    if (HumanMessage.isInstance(human) && Array.isArray(paths) && paths.length && deps.images) {
      const images = await deps.images(ctx.thread_id, paths as string[]);
      messages[latest] = new HumanMessage({ id: human.id, content: [...(typeof human.content === "string" ? [{ type: "text" as const, text: human.content }] : human.content), ...images], additional_kwargs: human.additional_kwargs });
    }
    const question = await deps.questions?.latest(ctx.user_id, ctx.thread_id);
    const prompt = question && (question.state === "expired" || question.state === "cancelled")
      ? new SystemMessage(`${system.text}\n\nPoslední strukturovaná otázka má stav ${question.state}. Nepovažuj odpovědi na tuto starou otázku za potvrzení. Pokud je potvrzení dál potřeba, polož novou otázku nástrojem ask_user.`) : system;
    const response = await selected.bindTools!(availableTools).invoke([prompt, ...messages], config);
    await count(ctx, response.usage_metadata?.total_tokens ?? 0);
    return { messages: [response] };
  };

  const lastIsAi = (state: typeof MessagesAnnotation.State) => AIMessage.isInstance(state.messages.at(-1));
  return new StateGraph(MessagesAnnotation)
    .addNode("guard_in", guardInput)
    .addNode("agent", callModel)
    .addNode("tools", async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
      const last = state.messages.at(-1) as AIMessage;
      const ask = last.tool_calls?.find(c => c.name === "ask_user");
      if (ask && ((last.tool_calls?.length ?? 0) !== 1 || await check(config, "output", JSON.stringify(ask.args)))) {
        return { messages: last.tool_calls!.map(c => new ToolMessage({ tool_call_id: c.id!, content: "Otázku je nutné položit samostatně a musí respektovat pravidla. Žádná akce nebyla provedena." })) };
      }
      return new ToolNode(await allTools(getRunContext(config))).invoke(state, config);
    })
    .addNode("guard_out", guardOutput)
    .addEdge(START, "guard_in")
    // A refused message ends the turn; otherwise the agent answers.
    .addConditionalEdges("guard_in", (state) => (lastIsAi(state) ? END : "agent"), ["agent", END])
    .addConditionalEdges("agent", (state) => ((state.messages.at(-1) as AIMessage).tool_calls?.length ? "tools" : "guard_out"), ["tools", "guard_out"])
    .addConditionalEdges("tools", async (_, config) => {
      const ctx = getRunContext(config);
      return (await deps.questions?.get(ctx.user_id, ctx.thread_id))?.state === "open" ? END : "agent";
    }, [END, "agent"])
    .addEdge("guard_out", END)
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;
