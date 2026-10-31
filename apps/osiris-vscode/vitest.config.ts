import { defineConfig } from "vitest/config";

// `pnpm test` runs the packages side by side: on a busy machine a first import alone can take more than Vitest's 5 s.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
