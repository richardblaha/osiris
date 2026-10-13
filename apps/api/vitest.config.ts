import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@langchain/langgraph-checkpoint-validation` relies on Jest-style global describe/it/beforeAll.
  test: { globals: true },
});
