import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { z } from "zod";

/**
 * Runs a self-contained ReAct task (the tenant's agent with its tools) and returns its final answer; `progress` hears
 * what it is doing (the tools it calls), so the diagram shows more than "running" for minutes.
 */
export type ReactDelegate = (goal: string, config: RunnableConfig, key: string, progress?: (message: string) => void) => Promise<string>;

/** A deterministic check of an artifact: the problems found, none when it's valid. */
export type Verifier = (artifact: string) => string[] | Promise<string[]>;

export interface OrchestratorDeps {
  /** Routes, plans, judges and writes artifacts (the system's agent model). */
  model: BaseChatModel;
  react: ReactDelegate;
  /** Extra named verifiers next to the built-in ones (`json`, `jsonld`, `dtdl`, `sql`). */
  verifiers?: Record<string, Verifier>;
  /** Counts the orchestrator's own model tokens (the delegate's ReAct runs count their own). */
  usage?: (config: RunnableConfig, tokens: number) => Promise<void>;
}

const tokensOf = (m: BaseMessage) => ("usage_metadata" in m ? (m.usage_metadata as { total_tokens?: number } | undefined)?.total_tokens ?? 0 : 0);

/** A structured answer, validated by the schema. */
export async function structured<S extends z.ZodType>(deps: OrchestratorDeps, schema: S, name: string, system: string, user: string, config: RunnableConfig): Promise<z.infer<S>> {
  const { raw, parsed } = await deps.model
    .withStructuredOutput(schema, { name, includeRaw: true })
    .invoke([new SystemMessage(system), new HumanMessage(user)], config);
  await deps.usage?.(config, tokensOf(raw));
  return schema.parse(parsed);
}

/** A plain text answer, without the Markdown fence models like to wrap code in. */
export async function text(deps: OrchestratorDeps, system: string, user: string, config: RunnableConfig): Promise<string> {
  const response = await deps.model.invoke([new SystemMessage(system), new HumanMessage(user)], config);
  await deps.usage?.(config, tokensOf(response));
  return response.text.trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, "$1");
}
