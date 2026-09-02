import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'orchestrator',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
