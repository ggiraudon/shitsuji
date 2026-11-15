import { defineConfig } from 'vitest/config';

/** Tests against real services (Postgres in Docker via Testcontainers). Run: pnpm test:integration */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/integration/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
