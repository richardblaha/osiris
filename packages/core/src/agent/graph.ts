import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { getRunContext, type RunContext } from "./context.ts";
import type { MemoryStore } from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { UserSettingsStore } from "./settings.ts";
import type { SkillStore } from "./skills.ts";
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
}

/** ReAct loop: `agent` calls the model, `tools` executes requested tool calls, repeat until the model answers. */
export function createAgentGraph(deps: AgentDeps) {
  const { tenantId, model, tools, dynamicTools, checkpointer, timezone, skills, memory, settings, secrets, features } = deps;
  if (!model.bindTools) throw new Error("Chat model does not support tool calling");
  const allTools = async (ctx: RunContext) => (dynamicTools ? [...tools, ...(await dynamicTools(ctx))] : tools);

  const callModel = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const ctx = getRunContext(config);
    if (ctx.tenant_id !== tenantId) throw new Error(`Run for tenant ${ctx.tenant_id} sent to graph of ${tenantId}`);
    const on = (await features?.get()) ?? DEFAULT_FEATURES;
    // The system prompt is not stored in the checkpoint, so it can change (date, channel, skills, memory) between turns.
    const system = new SystemMessage(
      buildSystemPrompt({
        channel: ctx.channel,
        timezone,
        knowledge: on.knowledge,
        files: on.files,
        skills: on.skills ? await skills?.list(ctx.user_id) : undefined,
        memories: on.memory ? await memory?.list(ctx.user_id) : undefined,
        userName: ctx.user_name,
        settings: await settings?.get(ctx.user_id),
        secrets: on.http || on.mcp ? await secrets?.list(ctx.user_id) : undefined,
      }),
    );
    const response = await model.bindTools!(await allTools(ctx)).invoke([system, ...state.messages], config);
    return { messages: [response] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", async (state: typeof MessagesAnnotation.State, config: RunnableConfig) =>
      new ToolNode(await allTools(getRunContext(config))).invoke(state, config),
    )
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;
