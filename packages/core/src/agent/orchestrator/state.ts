import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { AgentPattern } from "@osiris/shared";
import { z } from "zod";

/** What a single plan step runs as. PEV and Composite are plans of several steps, HITL guards a destructive one. */
export const STEP_PATTERNS = ["ReAct", "JEV", "Reflexion", "MapReduce"] as const;
export type StepPattern = (typeof STEP_PATTERNS)[number];

/** Each wave of ready steps takes two graph steps (approval, execute); 8 steps stay under LangGraph's recursion limit of 25. */
export const MAX_PLAN_STEPS = 8;
export const MAX_MAP_ITEMS = 50;

export const PlanStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/).describe("Krátké kebab-case id kroku"),
  goal: z.string().min(1).describe("Co má krok udělat, samostatně srozumitelně"),
  pattern: z.enum(STEP_PATTERNS),
  dependsOn: z.array(z.string()).describe("Id kroků, jejichž výsledek tento krok potřebuje"),
  destructive: z.boolean().describe("Mění nebo maže data (zápis do databáze, smazání souboru, odeslání zprávy)"),
  verifier: z.string().optional().describe("JEV: název deterministické kontroly výsledku"),
  items: z.array(z.string()).max(MAX_MAP_ITEMS).optional().describe("MapReduce: položky ke zpracování (cesty souborů, názvy senzorů)"),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const RoutePlanSchema = z.object({
  rationale: z.string().describe("Proč tento postup, jednou větou"),
  steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
});
export type RoutePlan = z.infer<typeof RoutePlanSchema>;

export type StepStatus = "success" | "failed" | "rejected" | "skipped";
export interface StepResult {
  status: StepStatus;
  output: string;
  attempts?: number;
}

/** HITL: a user's decision on each destructive step of a wave, keyed by step id (missing = rejected). */
export type ApprovalDecision = Record<string, boolean>;
/** What `interrupt()` hands the client; resume the run with `new Command({ resume: ApprovalDecision })`. */
export interface ApprovalRequest {
  type: "approval";
  steps: { id: string; goal: string }[];
}

/** PEV's verdict over the whole plan. */
export interface PlanVerdict {
  ok: boolean;
  failed: string[];
}

/** A merged record that a `null` update clears, so a new turn on the same thread starts empty. */
const mergedOrReset = <T>() =>
  Annotation<Record<string, T>, Record<string, T> | null>({
    reducer: (a, b) => (b === null ? {} : { ...a, ...b }),
    default: () => ({}),
  });
const last = <T>(initial: () => T) => Annotation<T>({ reducer: (_, b) => b, default: initial });

export const AgentRootState = Annotation.Root({
  ...MessagesAnnotation.spec,
  pattern: last<AgentPattern>(() => "ReAct"),
  plan: last<PlanStep[]>(() => []),
  results: mergedOrReset<StepResult>(),
  approvals: mergedOrReset<boolean>(),
  verdict: last<PlanVerdict | null>(() => null),
});
export type RootState = typeof AgentRootState.State;

/** JEV and Reflexion: Judge sets the criteria, Execute writes the artifact, Verify checks it, Judge (or Critic) accepts it. */
export const JevState = Annotation.Root({
  stepId: last(() => ""),
  mode: last<"JEV" | "Reflexion">(() => "JEV"),
  goal: last(() => ""),
  context: last(() => ""),
  verifier: last<string | undefined>(() => undefined),
  criteria: last<string[]>(() => []),
  artifact: last(() => ""),
  attempts: last(() => 0),
  /** Reflexion memory: what was wrong with every rejected attempt, shown to the next one. */
  reflections: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  /** Why the latest attempt failed its check or was rejected; cleared by the next attempt. */
  lastFailure: last<string | null>(() => null),
  status: last<"running" | "success" | "failed">(() => "running"),
});
export type JevStateType = typeof JevState.State;

export const MapReduceState = Annotation.Root({
  stepId: last(() => ""),
  goal: last(() => ""),
  items: last<string[]>(() => []),
  /** Set only on a map task's own input (`Send`). */
  item: last<{ index: number; value: string } | null>(() => null),
  partials: Annotation<{ index: number; item: string; output: string }[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  output: last(() => ""),
});
export type MapReduceStateType = typeof MapReduceState.State;

/** Steps not yet resolved whose dependencies all succeeded. */
export function readySteps(plan: PlanStep[], results: Record<string, StepResult>): PlanStep[] {
  return plan.filter((s) => !results[s.id] && s.dependsOn.every((d) => results[d]?.status === "success"));
}

/** Unique ids, known dependencies, items for MapReduce, no cycles; returns the steps in dependency order. */
export function validatePlan(plan: RoutePlan): PlanStep[] {
  const ids = new Set(plan.steps.map((s) => s.id));
  if (ids.size !== plan.steps.length) throw new Error("Duplicate step ids");
  for (const s of plan.steps) {
    const unknown = s.dependsOn.find((d) => !ids.has(d));
    if (unknown) throw new Error(`Step ${s.id} depends on unknown step ${unknown}`);
    if (s.pattern === "MapReduce" && !s.items?.length) throw new Error(`MapReduce step ${s.id} has no items`);
  }
  const ordered: PlanStep[] = [];
  const done = new Set<string>();
  while (ordered.length < plan.steps.length) {
    const next = plan.steps.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (!next.length) throw new Error("Plan has a dependency cycle");
    for (const s of next) (done.add(s.id), ordered.push(s));
  }
  return ordered;
}

/** One step: its pattern (HITL when it needs approval); PEV for several ReAct steps; Composite when patterns mix. */
export function rootPattern(plan: PlanStep[]): AgentPattern {
  const patterns = new Set(plan.map((s) => s.pattern));
  if (plan.length === 1) return plan[0]!.destructive ? "HITL" : plan[0]!.pattern;
  return patterns.size === 1 && patterns.has("ReAct") ? "PEV" : "Composite";
}
