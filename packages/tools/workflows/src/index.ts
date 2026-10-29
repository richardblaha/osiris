import { getRunContext } from "@osiris/core/agent/context.ts";
import type { ToolModule } from "@osiris/core/tools/module.ts";
import { createOrchestratorGraph, reactFromAgentGraph } from "./graph.ts";
import { workflowTool } from "./tool.ts";

/** Workflows: the agent hands larger tasks to an orchestrator graph (ReAct, JEV/Reflexion, MapReduce steps). */
export function workflowsModule(): ToolModule {
  return {
    name: "workflows",
    feature: "workflows",
    create: (host) => {
      // Workflow steps run as the project's agent itself (the graph exists before any tool runs).
      const orchestrator = createOrchestratorGraph({
        model: host.models.agent,
        react: (goal, config, key) => reactFromAgentGraph(host.graph())(goal, config, key),
        checkpointer: host.checkpointer,
        usage: (config, tokens) => host.usage.add(tokens, Date.now(), { user: getRunContext(config).user_id }),
      });
      // A workflow's own steps never start another workflow.
      return { tools: [workflowTool(orchestrator, host.questions)], usable: async (ctx) => () => !ctx.workflow };
    },
  };
}

export * from "./graph.ts";
export * from "./tool.ts";
