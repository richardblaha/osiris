import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
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

export interface AgentDeps {
  /** The tenant this graph serves; runs carrying another `tenant_id` are refused. */
  tenantId: string;
  model: BaseChatModel;
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

/** What a customer gets when the public assistant's (or the tenant's) quota is used up. */
export const PUBLIC_UNAVAILABLE = "Omlouvám se, asistent teď nemůže odpovídat. Kontaktujte prosím firmu přímo.";

export const TOKENS_EXHAUSTED = "Měsíční limit využití asistenta pro tuto firmu je vyčerpaný. Obrať se na správce.";

export const USER_TOKENS_EXHAUSTED = "Tvůj měsíční limit využití asistenta je vyčerpaný. Obrať se na správce firmy.";

/** ReAct loop: `agent` calls the model, `tools` executes requested tool calls, repeat until the model answers. */
export function createAgentGraph(deps: AgentDeps) {
  const { tenantId, model, tools, dynamicTools, checkpointer, timezone, skills, memory, settings, secrets, features, usage, rules, persona, publicPrompt, publicLimit, database } =
    deps;
  if (!model.bindTools) throw new Error("Chat model does not support tool calling");
  const allTools = async (ctx: RunContext) => (dynamicTools ? [...tools, ...(await dynamicTools(ctx))] : tools);

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
    const result = await breaksRules(model, r, kind, text).catch((err) => {
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
    return { messages: [new AIMessage(GUARD_REFUSAL)] };
  };

  /** A final answer breaking the rules is replaced (same id) by a refusal, in the history too. */
  const guardOutput = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const last = state.messages.at(-1);
    if (!AIMessage.isInstance(last) || [TOKENS_EXHAUSTED, USER_TOKENS_EXHAUSTED, PUBLIC_UNAVAILABLE].includes(last.text) || !(await check(config, "output", last.text))) return {};
    return { messages: [new AIMessage({ id: last.id, content: GUARD_REFUSAL })] };
  };

  const callModel = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const ctx = getRunContext(config);
    if (ctx.tenant_id !== tenantId) throw new Error(`Run for tenant ${ctx.tenant_id} sent to graph of ${tenantId}`);
    const on = (await features?.get()) ?? DEFAULT_FEATURES;
    const used = await exhausted(ctx);
    if (used) return { messages: [new AIMessage(used)] };
    // The system prompt is not stored in the checkpoint, so it can change (date, channel, skills, memory) between turns.
    const system = new SystemMessage(
      ctx.channel === "public" && publicPrompt ? await publicPrompt(ctx) : buildSystemPrompt({
        channel: ctx.channel,
        timezone,
        knowledge: on.knowledge,
        files: on.files,
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
    const response = await model.bindTools!(await allTools(ctx)).invoke([system, ...state.messages], config);
    await count(ctx, response.usage_metadata?.total_tokens ?? 0);
    return { messages: [response] };
  };

  const lastIsAi = (state: typeof MessagesAnnotation.State) => AIMessage.isInstance(state.messages.at(-1));
  return new StateGraph(MessagesAnnotation)
    .addNode("guard_in", guardInput)
    .addNode("agent", callModel)
    .addNode("tools", async (state: typeof MessagesAnnotation.State, config: RunnableConfig) =>
      new ToolNode(await allTools(getRunContext(config))).invoke(state, config),
    )
    .addNode("guard_out", guardOutput)
    .addEdge(START, "guard_in")
    // A refused message ends the turn; otherwise the agent answers.
    .addConditionalEdges("guard_in", (state) => (lastIsAi(state) ? END : "agent"), ["agent", END])
    .addConditionalEdges("agent", (state) => ((state.messages.at(-1) as AIMessage).tool_calls?.length ? "tools" : "guard_out"), ["tools", "guard_out"])
    .addEdge("tools", "agent")
    .addEdge("guard_out", END)
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;
