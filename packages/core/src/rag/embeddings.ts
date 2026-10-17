import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { OpenAIEmbeddings } from "@langchain/openai";

/** Creates embeddings from a `provider:model` spec, e.g. `mistralai:mistral-embed`. */
export function createEmbeddings(spec: string): EmbeddingsInterface {
  const [provider, model] = spec.split(/:(.+)/);
  switch (provider) {
    case "openai":
      return new OpenAIEmbeddings({ model });
    case "mistralai":
      return new MistralAIEmbeddings({ model });
    default:
      throw new Error(`Unsupported embedding provider "${provider}" in EMBEDDING_MODEL=${spec}`);
  }
}
