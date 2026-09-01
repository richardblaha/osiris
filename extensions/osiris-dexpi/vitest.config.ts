import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'osiris-dexpi',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
