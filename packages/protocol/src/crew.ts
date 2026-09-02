/**
 * Multi-agent "crew" orchestration. Agent definitions live in `.osiris/agents/`;
 * the roster and coordinator policy in `.osiris/crew.json`.
 */
import { z } from 'zod';

export const ModelSpec = z
  .string()
  .regex(/^[\w-]+\/[\w.:-]+$/, 'expected "<provider>/<model>", e.g. vscode-lm/claude-opus-5');
export type ModelSpec = z.infer<typeof ModelSpec>;

export const AgentDefinition = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  role: z.string().min(1),
  specialization: z.string().default(''),
  model: z.string().optional(),
  tools: z.array(z.string()).default([]),
  delegateTo: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2).optional(),
  /** Markdown body — the system prompt. */
  instructions: z.string().default(''),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const DEFAULT_COORDINATOR_POLICY = {
  maxDepth: 3,
  maxIterationsPerAgent: 12,
  maxDelegationsPerRun: 24,
} as const;

export const CoordinatorPolicy = z.object({
  maxDepth: z.number().int().positive().default(DEFAULT_COORDINATOR_POLICY.maxDepth),
  maxIterationsPerAgent: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_COORDINATOR_POLICY.maxIterationsPerAgent),
  maxDelegationsPerRun: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_COORDINATOR_POLICY.maxDelegationsPerRun),
});
export type CoordinatorPolicy = z.infer<typeof CoordinatorPolicy>;

export const ProviderConfig = z.object({
  kind: z.enum(['vscode-lm', 'echo', 'anthropic', 'openai-compatible', 'ollama']),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const CrewConfig = z.object({
  lead: z.string().min(1),
  defaultModel: z.string().default('echo/echo'),
  coordinator: CoordinatorPolicy.default(DEFAULT_COORDINATOR_POLICY),
  providers: z.record(z.string(), ProviderConfig).default({}),
});
export type CrewConfig = z.infer<typeof CrewConfig>;

export const CrewRunRequest = z.object({
  task: z.string().min(1),
  lead: z.string().optional(),
});
export type CrewRunRequest = z.infer<typeof CrewRunRequest>;

export const CrewDelegation = z.object({
  from: z.string(),
  to: z.string(),
  brief: z.string(),
  depth: z.number().int().nonnegative(),
  result: z.string(),
});
export type CrewDelegation = z.infer<typeof CrewDelegation>;

export const BlackboardEntry = z.object({
  agent: z.string(),
  kind: z.enum(['decision', 'finding', 'note', 'result']),
  text: z.string(),
  at: z.string(),
});
export type BlackboardEntry = z.infer<typeof BlackboardEntry>;

export const CrewRunResult = z.object({
  runId: z.string(),
  lead: z.string(),
  task: z.string(),
  text: z.string(),
  finishReason: z.enum(['stop', 'max-iterations', 'max-delegations', 'aborted', 'error']),
  delegations: z.array(CrewDelegation),
  blackboard: z.array(BlackboardEntry),
  error: z.string().optional(),
});
export type CrewRunResult = z.infer<typeof CrewRunResult>;

/** SSE event stream for a live crew run. */
export const CrewEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent.start'), agent: z.string(), depth: z.number(), brief: z.string() }),
  z.object({ type: z.literal('agent.text'), agent: z.string(), text: z.string() }),
  z.object({ type: z.literal('agent.tool'), agent: z.string(), tool: z.string() }),
  z.object({ type: z.literal('delegate'), from: z.string(), to: z.string(), brief: z.string() }),
  z.object({ type: z.literal('agent.finish'), agent: z.string(), text: z.string() }),
  z.object({ type: z.literal('blackboard'), entry: BlackboardEntry }),
  z.object({ type: z.literal('run.finish'), result: CrewRunResult }),
]);
export type CrewEvent = z.infer<typeof CrewEvent>;
