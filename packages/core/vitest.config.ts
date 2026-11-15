import { defineConfig } from 'vitest/config';

/** Unit and contract tests: no network, no Docker. Integration tests: vitest.integration.config.ts */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/integration/**', '**/node_modules/**'],
    environment: 'node',
  },
});
