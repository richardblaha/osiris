import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop-host',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
