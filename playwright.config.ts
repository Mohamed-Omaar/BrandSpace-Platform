import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration — F-04.
 *
 * CHROMIUM ONLY, deliberately. Phase 1 has three near-identical scaffold pages;
 * running three engines over them would triple CI time to re-assert the same
 * markup. The value of cross-browser testing arrives with real interactive
 * features, so more projects are added when there is behaviour that could
 * plausibly differ between engines (recorded in docs/DECISIONS.md).
 *
 * Every test is offline: the apps are statically rendered and no test touches an
 * external API, so runs are deterministic.
 */

const PORTS = { web: 3100, dashboard: 3101, admin: 3102 } as const;

/**
 * Optional override for the Chromium binary.
 *
 * CI installs the exact browser build this Playwright version expects, so it
 * leaves this unset. It exists for sandboxes and developer machines that already
 * have a compatible Chromium and should not re-download one. Setting it never
 * changes what is tested — only which binary runs the tests.
 */
const chromiumExecutable = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'];
const launchOptions = chromiumExecutable ? { executablePath: chromiumExecutable } : {};

/** Build once, then serve — production output is what CI and users actually get. */
function server(app: keyof typeof PORTS) {
  return {
    command: `pnpm --filter @brandspace/${app} start --port ${PORTS[app]}`,
    url: `http://127.0.0.1:${PORTS[app]}/en`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: {
      // Build/serve-time placeholder only; no test touches a database.
      DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
    },
  };
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Under exactOptionalPropertyTypes an explicit `undefined` is not assignable,
  // so the key is omitted entirely to fall back to Playwright's default.
  ...(process.env['CI'] ? { workers: 2 } : {}),
  // 'dot' keeps CI logs short; the HTML report is uploaded only on failure.
  reporter: process.env['CI']
    ? [['dot'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'], launchOptions },
    },
  ],

  webServer: [server('web'), server('dashboard'), server('admin')],
});
