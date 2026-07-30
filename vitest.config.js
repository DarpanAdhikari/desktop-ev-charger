import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['main/__tests__/**/*.test.js'],
    environment: 'node',
  },
});
