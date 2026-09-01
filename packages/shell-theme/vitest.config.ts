import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'shell-theme',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
