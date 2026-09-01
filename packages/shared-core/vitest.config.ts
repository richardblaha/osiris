import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shared-core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
