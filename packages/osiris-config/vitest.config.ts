import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'dot-osiris',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
