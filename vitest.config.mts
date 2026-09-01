import { defineConfig } from 'vitest/config';

/**
 * Two projects with different needs:
 *   - `unit`      : pure logic, no I/O, fast, runs everywhere.
 *   - `isolation` : requires a real PostgreSQL. These tests are the enforcement
 *                   mechanism for tenant isolation and are never mocked — mocking
 *                   the database would make every assertion vacuous.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'isolation',
          include: ['tests/isolation/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./tests/isolation/global-setup.ts'],
          setupFiles: ['./tests/isolation/setup.ts'],
          // Isolation tests share fixture rows; run them serially so one test's
          // transaction cannot race another's assertions.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
