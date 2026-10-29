import type { RunnableConfig } from "@langchain/core/runnables";
import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { text, type OrchestratorDeps } from "./llm.ts";
import { MapReduceState, type MapReduceStateType } from "./state.ts";
import { emit, nodeId, traced } from "./telemetry.ts";

/** Map tasks running at once, so a long collection doesn't hit the model's rate limit. */
export const MAP_CONCURRENCY = 4;

/** Inspects every item in parallel (each one a ReAct run with the project's tools), then aggregates the findings. */
export function createMapReduceGraph(deps: OrchestratorDeps) {
  const map = async (s: MapReduceStateType, config: RunnableConfig) => {
    const { index, value } = s.item!;
    const at = { pattern: "MapReduce" as const, phase: "Map" as const, nodeId: nodeId(s.stepId, "map") };
    emit(config, { ...at, status: "running", message: value, payload: { index, item: value } });
    try {
      const output = await deps.react(`${s.goal}\n\nZpracuj pouze tuto položku: ${value}`, config, `${s.stepId}:${index}`, (message) =>
        emit(config, { ...at, status: "running", message: `${value}: ${message}`, payload: { index, item: value } }),
      );
      emit(config, { ...at, status: "success", message: value, payload: { index, item: value, done: true } });
      return { partials: [{ index, item: value, output }] };
    } catch (err) {
      // One broken item doesn't sink the collection; the reducer is told it failed.
      emit(config, { ...at, status: "failed", message: (err as Error).message, payload: { index, item: value } });
      return { partials: [{ index, item: value, output: `CHYBA: ${(err as Error).message}` }] };
    }
  };

  const reduce = (s: MapReduceStateType, config: RunnableConfig) =>
    traced(config, { pattern: "MapReduce", phase: "Reduce", nodeId: nodeId(s.stepId, "reduce"), message: `Agreguji ${s.partials.length} výsledků` }, async () => {
      const findings = [...s.partials].sort((a, b) => a.index - b.index).map((p) => `## ${p.item}\n${p.output}`).join("\n\n");
      return { output: await text(deps, "Shrň dílčí zjištění do jednoho výsledku úkolu. Nic nevynechej a nic si nevymýšlej; selhané položky uveď.", `Úkol: ${s.goal}\n\n${findings}`, config) };
    });

  return new StateGraph(MapReduceState)
    .addNode("map", map)
    .addNode("reduce", reduce)
    .addConditionalEdges(START, (s) => s.items.map((value, index) => new Send("map", { ...s, item: { index, value } })), ["map"])
    .addEdge("map", "reduce")
    .addEdge("reduce", END)
    // Runs inside one node of the root graph, often several at once: no checkpoints of its own.
    .compile({ checkpointer: false });
}

export type MapReduceGraph = ReturnType<typeof createMapReduceGraph>;
