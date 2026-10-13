import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { END, MessagesAnnotation, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { getRunContext } from "./context.ts";
import type { MemoryStore } from "./memory.ts";
import { buildSystemPrompt } from "./prompt.ts";
import type { SkillStore } from "./skills.ts";

export interface AgentDeps {
  /** The tenant this graph serves; runs carrying another `tenant_id` are refused. */
  tenantId: string;
  model: BaseChatModel;
  /** Tools bound to this tenant's stores. */
  tools: StructuredToolInterface[];
  /** Tools that can change between turns (the tenant's MCP servers), resolved on every model and tool step. */
  dynamicTools?: () => Promise<StructuredToolInterface[]>;
  checkpointer: BaseCheckpointSaver;
  timezone: string;
  /** Listed in the system prompt on every call, so edits apply from the next turn. */
  skills?: SkillStore;
  /** The user's memories are injected into the system prompt on every call. */
  memory?: MemoryStore;
}

/** ReAct loop: `agent` calls the model, `tools` executes requested tool calls, repeat until the model answers. */
export function createAgentGraph({ tenantId, model, tools, dynamicTools, checkpointer, timezone, skills, memory }: AgentDeps) {
  if (!model.bindTools) throw new Error("Chat model does not support tool calling");
  const allTools = async () => (dynamicTools ? [...tools, ...(await dynamicTools())] : tools);

  const callModel = async (state: typeof MessagesAnnotation.State, config: RunnableConfig) => {
    const ctx = getRunContext(config);
    if (ctx.tenant_id !== tenantId) throw new Error(`Run for tenant ${ctx.tenant_id} sent to graph of ${tenantId}`);
    // The system prompt is not stored in the checkpoint, so it can change (date, channel, skills, memory) between turns.
    const system = new SystemMessage(
      buildSystemPrompt({
        channel: ctx.channel,
        timezone,
        skills: await skills?.list(),
        memories: await memory?.list(ctx.user_id),
      }),
    );
    const response = await model.bindTools!(await allTools()).invoke([system, ...state.messages], config);
    return { messages: [response] };
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", async (state: typeof MessagesAnnotation.State, config: RunnableConfig) =>
      new ToolNode(await allTools()).invoke(state, config),
    )
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition, ["tools", END])
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof createAgentGraph>;
