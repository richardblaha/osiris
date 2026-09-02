import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'container-sync',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
