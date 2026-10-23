import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { getWriter } from "@langchain/langgraph";
import { configuredLocale, translate } from "@osiris/platform/i18n.ts";
import { z } from "zod";
import { getRunContext, type RunContext } from "../context.ts";
import type { QuestionStore } from "../questions.ts";
import { Command, isolated, streamTelemetry, type OrchestratorGraph } from "./graph.ts";
import type { ApprovalDecision, ApprovalRequest, RootState } from "./state.ts";

export const WORKFLOW_TOOL = "run_workflow";

/** The orchestrator keeps its own checkpoints next to the chat's, on a thread of its own. */
export function workflowConfig(ctx: RunContext, signal?: AbortSignal): RunnableConfig {
  return {
    configurable: { thread_id: `${ctx.thread_id}:workflow`, tenant_id: ctx.tenant_id, user_id: ctx.user_id, role: ctx.role, channel: ctx.channel, user_name: ctx.user_name, locale: ctx.locale },
    signal,
  };
}

async function pendingApproval(graph: OrchestratorGraph, config: RunnableConfig): Promise<ApprovalRequest | null> {
  const state = await graph.getState(config);
  const value = state.tasks.flatMap((t) => t.interrupts).at(0)?.value as ApprovalRequest | undefined;
  return value?.type === "approval" ? value : null;
}

const field = (i: number) => `step_${i + 1}`;
const label = (goal: string) => goal.slice(0, 150);

/** The approval as a chat question: one yes/no per step, so web and WhatsApp show it like any `ask_user` form. */
function approvalQuestion(request: ApprovalRequest, ctx: RunContext) {
  return {
    title: translate(ctx.locale ?? configuredLocale(), "agent.workflowApproval"),
    fields: request.steps.map((s, i) => ({ name: field(i), label: label(s.goal), type: "boolean" as const, required: true })),
  };
}

/**
 * The user's decision, read from the question they answered, never from the model's arguments. Only the newest
 * question counts, and only when it asks about exactly these steps; cancelled or expired rejects every step.
 */
async function decision(questions: QuestionStore, ctx: RunContext, request: ApprovalRequest): Promise<ApprovalDecision | "waiting" | "missing"> {
  const question = await questions.latest(ctx.user_id, ctx.thread_id);
  const matches = question && question.fields.length === request.steps.length && request.steps.every((s, i) => question.fields[i]?.name === field(i) && question.fields[i]?.label === label(s.goal));
  if (!question || !matches) return "missing";
  if (question.state === "open") return "waiting";
  const values = question.state === "answered" ? ((await questions.answer(ctx.user_id, ctx.thread_id, question.id)) ?? {}) : {};
  return Object.fromEntries(request.steps.map((s, i) => [s.id, values[field(i)] === true]));
}

/**
 * The orchestrator for the ReAct agent: a larger task is planned into steps (ReAct, JEV, Reflexion, MapReduce),
 * steps that change data wait for the user's approval (a chat question), and the telemetry streams to the chat.
 */
export function workflowTool(graph: OrchestratorGraph, questions: QuestionStore) {
  return tool(
    async ({ request, resume }, config) => {
      const ctx = getRunContext(config);
      const cfg = workflowConfig(ctx, config.signal);
      const pending = await pendingApproval(graph, cfg);
      let input: Parameters<OrchestratorGraph["stream"]>[0];
      if (resume) {
        if (!pending) return "Žádný postup nečeká na schválení.";
        const answer = await decision(questions, ctx, pending);
        if (answer === "waiting") return "Uživatel na schválení ještě neodpověděl. Počkej na jeho odpověď.";
        // The question was replaced or never asked: ask again, and let the user decide.
        if (answer === "missing") return JSON.stringify({ question: await questions.create(ctx.user_id, ctx.thread_id, approvalQuestion(pending, ctx)) });
        input = new Command({ resume: answer });
      } else {
        input = { messages: [new HumanMessage(request)] };
      }

      let write: ((chunk: unknown) => void) | undefined;
      try {
        write = getWriter(config);
      } catch {
        // Called outside a graph: no stream to write to.
      }
      await isolated(async () => {
        for await (const event of streamTelemetry(graph, input, cfg)) write?.({ type: "telemetry", event: { ...event, sessionId: ctx.thread_id } });
      });

      const waiting = await pendingApproval(graph, cfg);
      if (waiting) return JSON.stringify({ question: await questions.create(ctx.user_id, ctx.thread_id, approvalQuestion(waiting, ctx)) });
      const { messages, plan, results } = (await graph.getState(cfg)).values as RootState;
      const steps = plan.map((s) => `${s.id}: ${results[s.id]?.status ?? "?"}`).join(", ");
      return `${messages.at(-1)?.text ?? ""}\n\n(Kroky postupu: ${steps})`;
    },
    {
      name: WORKFLOW_TOOL,
      description:
        "Provede větší úkol jako řízený postup: rozplánuje ho do kroků, vytvořené JSON/DTDL/SQL ověří a opraví, kolekce souborů či senzorů projde po položkách a před kroky, které mění data, požádá uživatele o schválení. " +
        "Použij jen pro vícekrokové úkoly nebo strojově ověřitelné výsledky, ne pro jednoduché dotazy. Volej samostatně. " +
        "Když uživatel odpoví na schválení postupu, zavolej ho znovu s resume: true (request pak může být prázdný).",
      schema: z.object({
        request: z.string().describe("Celé zadání úkolu, samostatně srozumitelné"),
        resume: z.boolean().optional().describe("Pokračovat v postupu, který čekal na schválení"),
      }),
    },
  );
}
