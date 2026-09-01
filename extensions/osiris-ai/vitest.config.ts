import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'osiris-ai',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
  },
});
