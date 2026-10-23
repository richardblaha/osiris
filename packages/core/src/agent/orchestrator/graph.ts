import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { END, START, StateGraph, interrupt, isGraphBubbleUp, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { AgentTelemetryEvent } from "@osiris/shared";
import { getRunContext, type RunContext } from "../context.ts";
import type { AgentGraph } from "../graph.ts";
import { BUILTIN_VERIFIERS, createJevGraph } from "./jev.ts";
import { structured, text, type OrchestratorDeps, type ReactDelegate } from "./llm.ts";
import { createMapReduceGraph, MAP_CONCURRENCY } from "./mapreduce.ts";
import {
  AgentRootState, MAX_PLAN_STEPS, readySteps, rootPattern, RoutePlanSchema, validatePlan,
  type ApprovalDecision, type ApprovalRequest, type PlanStep, type RootState, type StepResult,
} from "./state.ts";
import { emit, nodeId, planTopology, traced } from "./telemetry.ts";

/** A dependency's output given to the next step; long ones are cut so a chain of steps stays within the context. */
// ponytail: plain truncation, summarize outputs when long chains need the whole of them.
const MAX_CONTEXT_CHARS = 4000;

/**
 * Runs a graph as a run of its own, not as a subgraph of the graph whose node or tool calls it: LangGraph otherwise
 * merges the caller's Pregel internals (kept in async local storage) into its config, files its checkpoints under the
 * caller's and lets its interrupts end the caller's run.
 */
export function isolated<T>(run: () => Promise<T>): Promise<T> {
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, run);
}

/**
 * The existing ReAct agent as a delegate: a step runs as its own thread (`<thread>:<key>`) with the run's identity,
 * so guards, quotas, tools and history work exactly as in a chat.
 */
export function reactFromAgentGraph(agent: AgentGraph): ReactDelegate {
  return async (goal, config, key) => {
    const ctx = getRunContext(config);
    // Only the run's identity, not the parent's Pregel internals: the agent is its own graph with its own checkpoints.
    const configurable: RunContext = { thread_id: `${ctx.thread_id}:${key}`, tenant_id: ctx.tenant_id, user_id: ctx.user_id, role: ctx.role, channel: ctx.channel, assistant: ctx.assistant, user_name: ctx.user_name, locale: ctx.locale, workflow: true };
    const state = await isolated(() => agent.invoke({ messages: [new HumanMessage(goal)] }, { configurable, signal: config.signal }));
    return state.messages.at(-1)?.text ?? "";
  };
}

const routerPrompt = (verifiers: string[]) => `Jsi plánovač. Rozlož požadavek uživatele na kroky a ke každému zvol vzor:
- ReAct: průzkum, odpovědi, práce s nástroji (soubory, databáze, znalosti, e-mail). Jednoduchý požadavek je jeden krok ReAct.
- JEV: výsledkem je strojově ověřitelný artefakt (JSON, JSON-LD, DTDL model, SQL dotaz, schéma, kód). Uveď verifier: ${verifiers.join(", ")}.
- Reflexion: textový výsledek, který nelze ověřit strojově, ale musí splnit přesná kritéria (návrh, smlouva, nabídka).
- MapReduce: stejná kontrola mnoha položek (soubory, senzory); vypiš položky do items.
Kroky propoj přes dependsOn. Krok, který mění nebo maže data či něco odesílá, označ destructive. Nejvýš ${MAX_PLAN_STEPS} kroků.`;

/** Supervisor over the patterns: routes, guards destructive steps, runs the plan in dependency waves and verifies it. */
export function createOrchestratorGraph(deps: OrchestratorDeps & { checkpointer?: BaseCheckpointSaver }) {
  const jev = createJevGraph(deps);
  const mapReduce = createMapReduceGraph(deps);
  const verifierNames = Object.keys({ ...BUILTIN_VERIFIERS, ...deps.verifiers });

  const router = async (state: RootState, config: RunnableConfig) => {
    const request = state.messages.findLast((m) => HumanMessage.isInstance(m))?.text ?? "";
    emit(config, { pattern: "Composite", phase: "Router", nodeId: "router", status: "running", message: "Volím postup" });
    let plan: PlanStep[];
    let rationale: string;
    try {
      const route = await structured(deps, RoutePlanSchema, "plan", routerPrompt(verifierNames), request, config);
      plan = validatePlan(route);
      rationale = route.rationale;
    } catch (err) {
      if (isGraphBubbleUp(err)) throw err;
      // A plan the model got wrong falls back to the plain agent, which handles anything.
      plan = [{ id: "task", goal: request, pattern: "ReAct", dependsOn: [], destructive: false }];
      rationale = `Plán se nepodařilo sestavit (${(err as Error).message}), řeší agent.`;
    }
    const pattern = rootPattern(plan);
    emit(config, { pattern, phase: "Router", nodeId: "router", status: "success", message: rationale, activeGraphTopology: planTopology(plan, pattern), payload: { plan } });
    for (const step of plan) emit(config, { pattern: step.pattern, phase: "Plan", nodeId: nodeId(step.id, step.destructive ? "approval" : undefined), status: "pending", message: step.goal });
    return { plan, pattern, results: null, approvals: null, verdict: null };
  };

  /** HITL: a wave's destructive steps wait for the user; rejected ones (and so their dependents) never run. */
  const approval = (state: RootState, config: RunnableConfig) => {
    const pending = readySteps(state.plan, state.results).filter((s) => s.destructive && state.approvals[s.id] === undefined);
    if (!pending.length) return {};
    for (const s of pending) emit(config, { pattern: "HITL", phase: "HumanApproval", nodeId: nodeId(s.id, "approval"), status: "waiting_approval", message: s.goal });
    const decision = interrupt<ApprovalRequest, ApprovalDecision>({ type: "approval", steps: pending.map((s) => ({ id: s.id, goal: s.goal })) });
    const approvals = Object.fromEntries(pending.map((s) => [s.id, decision?.[s.id] === true]));
    const results: Record<string, StepResult> = {};
    for (const s of pending) {
      emit(config, { pattern: "HITL", phase: "HumanApproval", nodeId: nodeId(s.id, "approval"), status: approvals[s.id] ? "success" : "failed", message: approvals[s.id] ? "Schváleno" : "Zamítnuto" });
      if (!approvals[s.id]) results[s.id] = { status: "rejected", output: "Uživatel krok zamítl." };
    }
    return { approvals, results };
  };

  const brief = (step: PlanStep, results: Record<string, StepResult>) => {
    const inputs = step.dependsOn.map((d) => `- ${d}: ${results[d]!.output.slice(0, MAX_CONTEXT_CHARS)}`);
    return inputs.length ? `Výsledky kroků, na kterých tento krok závisí:\n${inputs.join("\n")}` : "";
  };

  const runStep = async (step: PlanStep, state: RootState, config: RunnableConfig): Promise<StepResult> => {
    const context = brief(step, state.results);
    if (step.pattern === "ReAct") {
      const goal = context ? `${step.goal}\n\n${context}` : step.goal;
      const output = await traced(config, { pattern: "ReAct", phase: "Execute", nodeId: step.id, message: step.goal }, () => deps.react(goal, config, step.id));
      return { status: "success", output };
    }
    if (step.pattern === "MapReduce") {
      const out = await mapReduce.invoke({ stepId: step.id, goal: context ? `${step.goal}\n\n${context}` : step.goal, items: step.items ?? [] }, { ...config, maxConcurrency: MAP_CONCURRENCY });
      return { status: "success", output: out.output };
    }
    const out = await jev.invoke({ stepId: step.id, mode: step.pattern, goal: step.goal, context, verifier: step.verifier }, config);
    return { status: out.status === "success" ? "success" : "failed", output: out.status === "success" ? out.artifact : out.reflections.join("\n"), attempts: out.attempts };
  };

  /** One wave: every ready step that may run, in parallel. A failing step fails alone; its dependents are skipped. */
  const execute = async (state: RootState, config: RunnableConfig) => {
    const wave = readySteps(state.plan, state.results).filter((s) => !s.destructive || state.approvals[s.id]);
    const done = await Promise.all(wave.map(async (step): Promise<[string, StepResult]> => {
      try {
        return [step.id, await runStep(step, state, config)];
      } catch (err) {
        if (isGraphBubbleUp(err)) throw err;
        return [step.id, { status: "failed", output: (err as Error).message }];
      }
    }));
    return { results: Object.fromEntries(done) };
  };

  /** PEV's verify: deterministic over the whole plan; unreachable steps are marked skipped. */
  const verify = (state: RootState, config: RunnableConfig) => {
    const skipped = Object.fromEntries(state.plan.filter((s) => !state.results[s.id]).map((s): [string, StepResult] => [s.id, { status: "skipped", output: "Nespuštěno: předchozí krok neuspěl." }]));
    const results = { ...state.results, ...skipped };
    const failed = state.plan.filter((s) => results[s.id]!.status !== "success").map((s) => s.id);
    emit(config, { pattern: state.pattern, phase: "Verify", nodeId: "verify", status: failed.length ? "failed" : "success", message: failed.length ? `Neuspělo: ${failed.join(", ")}` : "Všechny kroky uspěly", payload: { results } });
    return { results: skipped, verdict: { ok: !failed.length, failed } };
  };

  /** The answer: a single step's own output, or the model's summary of the plan's results. */
  const complete = (state: RootState, config: RunnableConfig) =>
    traced(config, { pattern: state.pattern, phase: "Complete", nodeId: "complete", message: "Odpovídám" }, async () => {
      const only = state.plan.length === 1 ? state.results[state.plan[0]!.id] : undefined;
      if (only) return { messages: [new AIMessage(only.status === "success" ? only.output : `Úkol se nepodařilo dokončit: ${only.output}`)] };
      const request = state.messages.findLast((m) => HumanMessage.isInstance(m))?.text ?? "";
      const report = state.plan.map((s) => `## ${s.id} (${state.results[s.id]!.status}): ${s.goal}\n${state.results[s.id]!.output}`).join("\n\n");
      return { messages: [new AIMessage(await text(deps, "Odpověz uživateli v jazyce jeho požadavku na základě výsledků kroků. Neuspělé či zamítnuté kroky přiznej.", `Požadavek: ${request}\n\n${report}`, config))] };
    });

  const next = (state: RootState) => (readySteps(state.plan, state.results).length ? "approval" : "verify");
  return new StateGraph(AgentRootState)
    .addNode("router", router)
    .addNode("approval", approval)
    .addNode("execute", execute)
    .addNode("verify", verify)
    .addNode("complete", complete)
    .addEdge(START, "router")
    .addConditionalEdges("router", next, ["approval", "verify"])
    .addEdge("approval", "execute")
    .addConditionalEdges("execute", next, ["approval", "verify"])
    .addEdge("verify", "complete")
    .addEdge("complete", END)
    .compile({ checkpointer: deps.checkpointer });
}

export type OrchestratorGraph = ReturnType<typeof createOrchestratorGraph>;

/** Resumes a run waiting for approval: `new Command({ resume: ApprovalDecision })`. */
export { Command } from "@langchain/langgraph";

const isTelemetry = (chunk: unknown): chunk is { type: "telemetry"; event: AgentTelemetryEvent } =>
  !!chunk && typeof chunk === "object" && (chunk as { type?: unknown }).type === "telemetry";

/**
 * Runs the orchestrator (or resumes it after an approval with `new Command({ resume: decision })`) and yields its
 * telemetry, subgraphs' included, one JSON-serializable event at a time, for an SSE (`streamSSE`) or WebSocket endpoint.
 */
export async function* streamTelemetry(graph: OrchestratorGraph, input: Parameters<OrchestratorGraph["stream"]>[0], config: RunnableConfig): AsyncGenerator<AgentTelemetryEvent> {
  const stream = await graph.stream(input, { ...config, streamMode: "custom", subgraphs: true });
  for await (const [, chunk] of stream) if (isTelemetry(chunk)) yield chunk.event;
}
