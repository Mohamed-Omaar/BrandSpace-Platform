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
          // Playwright owns tests/e2e; Vitest must never try to run those specs.
          // NOTE: `exclude` REPLACES Vitest's defaults, so node_modules must be
          // listed explicitly — omitting it makes Vitest scan every dependency.
          exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
          environment: 'node',
          /*
           * WHY 30s RATHER THAN THE 5s DEFAULT.
           *
           * Most of this project is pure logic and finishes in single-digit
           * milliseconds, but three suites SPAWN A PROCESS to assert something
           * that cannot be asserted any other way: the module-boundary and
           * platform-pool guards run ESLint over a planted snippet, and the
           * Prisma configuration guard runs `prisma generate` with a scrubbed
           * environment. Each spawn is seconds of real work, and when the
           * runner schedules several of them at once on a loaded machine they
           * cross five seconds and fail for a reason that has nothing to do
           * with the thing under test.
           *
           * This raises the ceiling; it does not skip, weaken or shorten a
           * single assertion. A genuinely hung test still fails, thirty
           * seconds later.
           */
          testTimeout: 30_000,
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
