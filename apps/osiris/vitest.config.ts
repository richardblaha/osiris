import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@langchain/langgraph-checkpoint-validation` relies on Jest-style global describe/it/beforeAll.
  // Half the cores and a longer timeout: these tests start projects, servers and child processes, and with a worker
  // per core on a small machine (or next to other packages' tests in `pnpm test`) they time out without failing.
  test: { globals: true, maxWorkers: "50%", testTimeout: 30_000, hookTimeout: 30_000 },
});
