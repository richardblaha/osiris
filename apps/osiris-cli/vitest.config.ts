import { defineConfig } from "vitest/config";

// The terminal's texts are English in tests, whatever the machine's language.
export default defineConfig({ test: { env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } } });
