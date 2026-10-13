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
