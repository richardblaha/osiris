import { randomUUID } from 'node:crypto';
import { AgentOrchestrator, type ProviderAdapter, type Tool } from '@osiris/agent-core';
import { createLogger } from '@osiris/shared-core';
import type {
  AgentDefinition,
  CrewConfig,
  CrewDelegation,
  CrewEvent,
  CrewRunResult,
} from '@osiris/protocol';
import { Blackboard } from './blackboard.js';
import type { AgentRegistry } from './registry.js';

const log = createLogger('crew');

export interface CrewOptions {
  registry: AgentRegistry;
  config: CrewConfig;
  /** Bridge tools, keyed by name (see `buildToolbox`). */
  toolbox: Map<string, Tool>;
  /** Model spec (`<provider>/<model>`) → adapter. */
  resolveProvider: (spec: string) => ProviderAdapter;
  /** Project instructions (README) folded into every system prompt. */
  projectContext?: string;
  /**
   * Expand an agent's `tools:` list before toolbox lookup — e.g. turn an `mcp`
   * or `mcp:<server>` selector into concrete MCP tool names. Identity by default.
   */
  expandToolNames?: (agentTools: string[]) => string[];
}

export interface CrewRunOptions {
  /** Override `crew.json`'s `lead`. */
  lead?: string;
  signal?: AbortSignal;
  onEvent?: (event: CrewEvent) => void;
}

type FinishReason = CrewRunResult['finishReason'];

const SEVERITY: Record<FinishReason, number> = {
  stop: 0,
  'max-iterations': 1,
  'max-delegations': 2,
  aborted: 3,
  error: 4,
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The coordinator. `run(task)` drives the lead agent; whenever an agent calls the
 * `delegate` tool a fresh `AgentOrchestrator` is spun up for the named specialist
 * with its own system prompt and tools, and its result folded back. All agents
 * share one `Blackboard`. Depth, per-agent iterations and total delegations are
 * bounded by `crew.json`'s coordinator policy.
 */
export class Crew {
  constructor(private readonly options: CrewOptions) {}

  async run(task: string, runOptions: CrewRunOptions = {}): Promise<CrewRunResult> {
    const runId = randomUUID();
    const lead = runOptions.lead ?? this.options.config.lead;
    const policy = this.options.config.coordinator;
    const emit = (event: CrewEvent): void => runOptions.onEvent?.(event);

    const delegations: CrewDelegation[] = [];
    const blackboard = new Blackboard((entry) => emit({ type: 'blackboard', entry }));
    let finishReason: FinishReason = 'stop';
    let delegationCount = 0;
    let errorMessage: string | undefined;

    const escalate = (reason: FinishReason): void => {
      if (SEVERITY[reason] > SEVERITY[finishReason]) finishReason = reason;
    };

    const runAgent = async (name: string, brief: string, depth: number): Promise<string> => {
      const def = this.options.registry.get(name);
      if (!def) {
        escalate('error');
        errorMessage = `unknown agent "${name}"`;
        return `error: ${errorMessage}`;
      }
      emit({ type: 'agent.start', agent: name, depth, brief });

      const canDelegate = def.delegateTo.length > 0 && depth < policy.maxDepth;
      const tools: Tool[] = [];
      const toolNames = this.options.expandToolNames
        ? this.options.expandToolNames(def.tools)
        : def.tools;
      for (const toolName of toolNames) {
        const base = this.options.toolbox.get(toolName);
        if (base) tools.push(this.instrument(base, name, emit));
      }
      if (canDelegate) {
        tools.push(
          this.delegateTool(def, depth, {
            emit,
            runAgent,
            blackboard,
            delegations,
            policy,
            registry: this.options.registry,
            budget: () => delegationCount,
            spend: () => {
              delegationCount += 1;
            },
            escalate,
          }),
        );
      }

      const orchestrator = new AgentOrchestrator(
        this.options.resolveProvider(this.modelFor(def)),
      );
      orchestrator.setTools(tools);

      const result = await orchestrator.run({
        prompt: brief,
        system: this.systemPrompt(def, blackboard, canDelegate),
        maxIterations: policy.maxIterationsPerAgent,
        signal: runOptions.signal,
        events: { onText: (text) => emit({ type: 'agent.text', agent: name, text }) },
      });

      if (result.finishReason === 'error') {
        escalate('error');
        errorMessage ??= result.error;
      } else if (result.finishReason === 'aborted') {
        escalate('aborted');
      } else if (result.finishReason === 'max-iterations') {
        escalate('max-iterations');
      }

      blackboard.add(name, 'result', truncate(result.text || '(no textual output)', 800));
      emit({ type: 'agent.finish', agent: name, text: result.text });
      return result.text;
    };

    let text = '';
    try {
      text = await runAgent(lead, task, 0);
    } catch (cause) {
      escalate('error');
      errorMessage ??= (cause as Error).message;
      text = `error: ${errorMessage}`;
    }

    const runResult: CrewRunResult = {
      runId,
      lead,
      task,
      text,
      finishReason,
      delegations,
      blackboard: blackboard.entries(),
      error: errorMessage,
    };
    emit({ type: 'run.finish', result: runResult });
    log.info('run %s finished: %s (%d delegations)', runId, finishReason, delegations.length);
    return runResult;
  }

  /**
   * The model spec for an agent: an explicit `model:` wins, then its `taskClass`
   * mapped through `crew.json`'s `taskModels`, then the crew `defaultModel`.
   */
  private modelFor(def: AgentDefinition): string {
    const byClass = def.taskClass ? this.options.config.taskModels[def.taskClass] : undefined;
    return def.model ?? byClass ?? this.options.config.defaultModel;
  }

  private systemPrompt(def: AgentDefinition, blackboard: Blackboard, canDelegate: boolean): string {
    const parts = [
      def.instructions.trim(),
      `You are "${def.name}" — ${def.role}.${def.specialization ? ` Specialization: ${def.specialization}.` : ''}`,
    ];
    if (this.options.projectContext) {
      parts.push(
        `## Project instructions (README.md)\n\n${truncate(this.options.projectContext, 6000)}`,
      );
    }
    const board = blackboard.render();
    if (board) parts.push(board);
    parts.push(
      canDelegate
        ? `You may hand sub-tasks to: ${def.delegateTo.join(', ')} — call the \`delegate\` tool with { agent, brief }. Give each a crisp brief with acceptance criteria.`
        : 'You have no delegation ability on this run — do the work yourself and report back.',
    );
    parts.push('When done, reply with your answer as plain text.');
    return parts.join('\n\n');
  }

  private instrument(tool: Tool, agent: string, emit: (e: CrewEvent) => void): Tool {
    return {
      ...tool,
      invoke: async (input, signal) => {
        emit({ type: 'agent.tool', agent, tool: tool.name });
        return tool.invoke(input, signal);
      },
    };
  }

  private delegateTool(
    def: AgentDefinition,
    depth: number,
    ctx: {
      emit: (e: CrewEvent) => void;
      runAgent: (name: string, brief: string, depth: number) => Promise<string>;
      blackboard: Blackboard;
      delegations: CrewDelegation[];
      policy: CrewConfig['coordinator'];
      registry: AgentRegistry;
      budget: () => number;
      spend: () => void;
      escalate: (reason: FinishReason) => void;
    },
  ): Tool {
    return {
      name: 'delegate',
      description: `Hand a sub-task to another crew member. Allowed targets: ${def.delegateTo.join(', ')}.`,
      inputSchema: {
        type: 'object',
        required: ['agent', 'brief'],
        properties: {
          agent: { type: 'string', enum: def.delegateTo },
          brief: { type: 'string', description: 'the sub-task, with acceptance criteria' },
        },
      },
      invoke: async (input) => {
        const { agent, brief } = (input ?? {}) as { agent?: string; brief?: string };
        if (!agent || !brief) return 'error: both "agent" and "brief" are required';
        if (!def.delegateTo.includes(agent)) {
          return `error: ${def.name} is not allowed to delegate to "${agent}"`;
        }
        if (!ctx.registry.has(agent)) return `error: no such agent "${agent}"`;
        if (depth + 1 > ctx.policy.maxDepth) {
          ctx.escalate('max-delegations');
          return `error: max delegation depth (${ctx.policy.maxDepth}) reached`;
        }
        if (ctx.budget() >= ctx.policy.maxDelegationsPerRun) {
          ctx.escalate('max-delegations');
          return `error: delegation budget (${ctx.policy.maxDelegationsPerRun}) exhausted`;
        }
        ctx.spend();
        ctx.emit({ type: 'delegate', from: def.name, to: agent, brief });
        const result = await ctx.runAgent(agent, brief, depth + 1);
        ctx.delegations.push({ from: def.name, to: agent, brief, depth: depth + 1, result });
        return result || '(the sub-agent produced no output)';
      },
    };
  }
}
