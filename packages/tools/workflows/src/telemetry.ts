import type { RunnableConfig } from "@langchain/core/runnables";
import { getWriter } from "@langchain/langgraph";
import type { AgentGraphTopology, AgentNodeStatus, AgentPattern, AgentPhase, AgentTelemetryEvent } from "@osiris/shared";
import type { PlanStep } from "./state.ts";

/** Node ids of a step in the topology, so a subgraph's events land on the node the UI drew. */
export const nodeId = (step: string, node?: string) => (node ? `${step}/${node}` : step);

type Node = AgentGraphTopology["nodes"][number];
type Edge = AgentGraphTopology["edges"][number];

function stepGraph(step: PlanStep): { nodes: Node[]; edges: Edge[]; entry: string; exit: string } {
  const node = (id: string, label: string, type: AgentPhase, pattern: AgentPattern = step.pattern): Node => ({ id, label, type, pattern });
  let nodes: Node[];
  let edges: Edge[];
  let exit: string;
  if (step.pattern === "ReAct") {
    nodes = [node(step.id, step.goal, "Execute")];
    edges = [];
    exit = step.id;
  } else if (step.pattern === "MapReduce") {
    const [map, reduce] = [nodeId(step.id, "map"), nodeId(step.id, "reduce")];
    nodes = [node(map, `${step.goal} (${step.items?.length ?? 0}×)`, "Map"), node(reduce, step.goal, "Reduce")];
    edges = [{ from: map, to: reduce }];
    exit = reduce;
  } else {
    const [judge, execute] = [nodeId(step.id, "judge"), nodeId(step.id, "execute")];
    nodes = [node(judge, step.goal, "Judge"), node(execute, step.goal, "Execute")];
    edges = [{ from: judge, to: execute, condition: "criteria" }];
    if (step.pattern === "JEV") {
      // The Judge sets the criteria first and evaluates last: two nodes, so the graph only loops back to repair.
      const [verify, evaluate] = [nodeId(step.id, "verify"), nodeId(step.id, "evaluate")];
      nodes.push(node(verify, step.verifier ?? "verify", "Verify"), node(evaluate, step.goal, "Judge"));
      edges.push({ from: execute, to: verify }, { from: verify, to: execute, condition: "repair" }, { from: verify, to: evaluate, condition: "valid" }, { from: evaluate, to: execute, condition: "rejected" });
      exit = evaluate;
    } else {
      const critic = nodeId(step.id, "critic");
      nodes.push(node(critic, step.goal, "Critic"));
      edges.push({ from: execute, to: critic }, { from: critic, to: execute, condition: "reflect" });
      exit = critic;
    }
  }
  if (!step.destructive) return { nodes, edges, entry: nodes[0]!.id, exit };
  const approval = nodeId(step.id, "approval");
  return { nodes: [node(approval, step.goal, "HumanApproval", "HITL"), ...nodes], edges: [{ from: approval, to: nodes[0]!.id, condition: "approved" }, ...edges], entry: approval, exit };
}

/** The whole expected graph of a plan, for the UI to draw before anything runs. */
export function planTopology(plan: PlanStep[], pattern: AgentPattern): AgentGraphTopology {
  const nodes: Node[] = [{ id: "router", label: "Router", type: "Router", pattern }];
  const edges: Edge[] = [];
  const graphs = new Map(plan.map((s) => [s.id, stepGraph(s)]));
  const dependedOn = new Set(plan.flatMap((s) => s.dependsOn));
  for (const step of plan) {
    const g = graphs.get(step.id)!;
    nodes.push(...g.nodes);
    edges.push(...g.edges);
    if (!step.dependsOn.length) edges.push({ from: "router", to: g.entry });
    for (const dep of step.dependsOn) edges.push({ from: graphs.get(dep)!.exit, to: g.entry });
    if (!dependedOn.has(step.id)) edges.push({ from: g.exit, to: "verify" });
  }
  nodes.push({ id: "verify", label: "Verify", type: "Verify", pattern }, { id: "complete", label: "Complete", type: "Complete", pattern });
  edges.push({ from: "verify", to: "complete" });
  return { nodes, edges };
}

export type TelemetryInput = Omit<AgentTelemetryEvent, "sessionId" | "timestamp">;

/** Sends an event on the graph's `custom` stream; outside a graph run (direct calls in tests) it's dropped. */
export function emit(config: RunnableConfig, event: TelemetryInput) {
  const sessionId = String(config.configurable?.thread_id ?? "");
  const full: AgentTelemetryEvent = { sessionId, timestamp: Date.now(), ...event };
  try {
    getWriter(config)?.({ type: "telemetry", event: full });
  } catch {
    // No writer: not running inside a graph.
  }
}

/** A node's start and end (or failure) as events; returns what `run` returns, rethrowing its error. */
export async function traced<T>(
  config: RunnableConfig,
  at: { pattern: AgentPattern; phase: AgentPhase; nodeId: string; message: string },
  run: () => Promise<T>,
  done: (result: T) => { status?: AgentNodeStatus; message?: string; payload?: Record<string, unknown> } = () => ({}),
): Promise<T> {
  emit(config, { ...at, status: "running" });
  try {
    const result = await run();
    const end = done(result);
    emit(config, { ...at, status: end.status ?? "success", message: end.message ?? at.message, payload: end.payload });
    return result;
  } catch (err) {
    emit(config, { ...at, status: "failed", message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
