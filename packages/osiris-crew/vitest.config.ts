import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'crew',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
