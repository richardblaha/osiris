import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain";

/**
 * Creates the chat model from a `provider:model` spec, e.g. `mistralai:mistral-small-2603` or `anthropic:claude-sonnet-5-5`.
 * The provider package (`@langchain/anthropic`, `@langchain/openai`, ...) must be installed, and its API key
 * set via the provider's usual env var (MISTRAL_API_KEY, ANTHROPIC_API_KEY, ...).
 */
export async function createChatModel(spec: string): Promise<BaseChatModel> {
  return (await initChatModel(spec)) as unknown as BaseChatModel;
}

export const MODEL_ROLES = ["agent", "tools", "guard", "persona"] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export type AgentModels = Record<ModelRole, BaseChatModel>;

/** System-owned assignments. Identical specs share one model instance. */
export async function createAgentModels(specs: Record<ModelRole, string>): Promise<AgentModels> {
  for (const role of MODEL_ROLES) {
    if (!/^(mistralai|openai|anthropic):[^\s]+$/.test(specs[role])) throw new Error(`Invalid ${role} model: ${specs[role]}`);
  }
  const cache = new Map<string, Promise<BaseChatModel>>();
  const entries = await Promise.all(MODEL_ROLES.map(async (role) => {
    const spec = specs[role];
    if (!cache.has(spec)) cache.set(spec, createChatModel(spec));
    return [role, await cache.get(spec)!] as const;
  }));
  return Object.fromEntries(entries) as AgentModels;
}
