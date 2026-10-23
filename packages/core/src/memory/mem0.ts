import "./env.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Client } from "@libsql/client";
import { Memory, VectorStoreFactory } from "mem0ai/oss";
import type { Records } from "../projects/records.ts";
import { FileVectorStore, type FileVectorStoreConfig } from "./file-vector-store.ts";

// Mem0 builds its stores (memories, then `<name>_entities`) through this factory: ours keeps them in the project's files.
const create = VectorStoreFactory.create.bind(VectorStoreFactory);
VectorStoreFactory.create = (provider: string, config: Record<string, any>) =>
  provider === "osiris-files" ? new FileVectorStore(config as FileVectorStoreConfig) : create(provider, config);

const COLLECTION = "osiris";

/** Who pays for Mem0's own model calls in the current async context (fact extraction, update decisions). */
const payer = new AsyncLocalStorage<(tokens: number) => void>();

class TokenCounter extends BaseCallbackHandler {
  name = "osiris-mem0-tokens";
  handleLLMEnd(output: LLMResult) {
    const tokens = output.generations.flat().reduce((n, g) => n + ((g as { message?: { usage_metadata?: { total_tokens?: number } } }).message?.usage_metadata?.total_tokens ?? 0), 0);
    if (tokens) payer.getStore()?.(tokens);
  }
}

/** The model with a token counter on every call Mem0 makes, also through `withStructuredOutput` and `bindTools`. */
function counted<T extends object>(runnable: T, counter: TokenCounter): T {
  return new Proxy(runnable, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "invoke")
        return async (input: unknown, options: { callbacks?: unknown[] } = {}) => {
          const out = (await (value as (i: unknown, o: unknown) => Promise<unknown>).call(target, input, { ...options, callbacks: [...((options.callbacks as unknown[]) ?? []), counter] })) as
            | { content?: unknown; text?: unknown; tool_calls?: unknown[] }
            | undefined;
          // Mem0's LangChain adapter takes any `tool_calls` array for a tool answer, and LangChain always sets one: an
          // answer without calls must reach it as text.
          if (out && typeof out === "object" && "content" in out) {
            if (Array.isArray(out.tool_calls) && !out.tool_calls.length) out.tool_calls = undefined;
            if (typeof out.content !== "string" && typeof out.text === "string") out.content = out.text;
          }
          return out;
        };
      if ((prop === "withStructuredOutput" || prop === "bindTools") && typeof value === "function") return (...args: unknown[]) => counted((value as (...a: unknown[]) => object).apply(target, args), counter);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface MemoryEngine {
  /** Created on first use: Mem0 initializes its stores at once, and the cache's tables exist only after `init`. */
  readonly memory: Memory;
  /** The store of memories (and knowledge chunks), for direct reads and batch inserts. */
  points(): Promise<FileVectorStore>;
  /** Runs `fn` with Mem0's model calls paid by `pay`. */
  paidBy<T>(pay: (tokens: number) => void, fn: () => Promise<T>): Promise<T>;
  /** Links the entities of a memory written verbatim (`infer: false` skips Mem0's own linking). */
  link(id: string, text: string, scope: Record<string, string>): Promise<void>;
  /** Opens both stores, bringing the cache in step with the memory files. */
  initialize(): Promise<void>;
}

/** Mem0 over the project's files: the project's LangChain models, no OpenAI, no history database, no telemetry. */
export function createMemoryEngine(opts: { records: Records; cache: Client; embeddings: EmbeddingsInterface; model: BaseChatModel }): MemoryEngine {
  const registry = new Map<string, FileVectorStore>();
  let instance: Memory | undefined;
  const make = () => new Memory({
    embedder: { provider: "langchain", config: { model: opts.embeddings } },
    llm: { provider: "langchain", config: { model: counted(opts.model, new TokenCounter()) } },
    // The dimension only stops Mem0 from probing the embedder at start; the file store doesn't need it.
    vectorStore: { provider: "osiris-files", config: { collectionName: COLLECTION, dimension: 1, records: opts.records, cache: opts.cache, embeddings: opts.embeddings, registry } },
    disableHistory: true,
    customInstructions: "Zapisuj fakta stručně, každé zvlášť, v jazyce, kterým píše uživatel (obvykle česky). Nezapisuj hesla ani klíče.",
  } as never);
  type Internal = {
    _ensureInitialized(): Promise<void>;
    getEntityStore(): Promise<unknown>;
    _linkEntitiesForMemory(id: string, text: string, filters: Record<string, string>): Promise<void>;
  };
  const internal = () => (instance ??= make()) as unknown as Internal;
  return {
    get memory() {
      return (instance ??= make());
    },
    async points() {
      await internal()._ensureInitialized();
      return registry.get(COLLECTION)!;
    },
    paidBy: (pay, fn) => payer.run(pay, fn),
    link: (id, text, scope) => internal()._linkEntitiesForMemory(id, text, scope),
    // Mem0 initializes a store once, when it creates it; a project's init (a restore, a lost cache) needs it again.
    async initialize() {
      await (await this.points()).initialize();
      await ((await internal().getEntityStore()) as FileVectorStore).initialize();
    },
  };
}
