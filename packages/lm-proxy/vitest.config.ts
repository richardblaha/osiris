import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'lm-proxy', environment: 'node', include: ['test/**/*.test.ts'] },
});
