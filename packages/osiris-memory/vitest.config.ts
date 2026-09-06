import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'memory',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
