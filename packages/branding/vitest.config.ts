import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'branding',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
