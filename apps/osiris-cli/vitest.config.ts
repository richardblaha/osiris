import { defineConfig } from "vitest/config";

// The terminal's texts are English in tests, whatever the machine's language.
// Longer timeout: `pnpm test` runs the packages side by side.
export default defineConfig({ test: { env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }, testTimeout: 30_000, hookTimeout: 30_000 } });
