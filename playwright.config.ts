import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Load `.env.test` into this process.
 *
 * The Control Center is a real database-backed application from Phase 2A
 * onwards, so the served admin app needs the test database's connection details.
 *
 * This does NOT reuse `loadEnvFile` from @brandspace/database, deliberately:
 * Playwright transpiles this config to CommonJS, and loading a module from
 * `tests/` here would register a CommonJS copy of it that then breaks the ESM
 * import of the same module from the spec files. The behaviour is identical —
 * an existing variable is never overwritten, so CI-injected values still win.
 */
function loadTestEnv(): void {
  const file = path.join(__dirname, '.env.test');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === '' || key in process.env) continue;
    process.env[key] = trimmed.slice(separator + 1).trim();
  }
}

loadTestEnv();

/**
 * Playwright configuration — F-04, extended in Phase 2A.
 *
 * CHROMIUM ONLY, deliberately. The value of cross-browser testing arrives with
 * behaviour that could plausibly differ between engines; more projects are added
 * when there is such behaviour (recorded in docs/DECISIONS.md).
 *
 * No test contacts an external service. The public website and the customer
 * dashboard are statically rendered; the Control Center talks only to the local
 * test database, signing in with a throwaway account that `pnpm e2e:seed`
 * creates seconds earlier. No real credential is involved anywhere.
 */

const PORTS = { web: 3100, dashboard: 3101, admin: 3102, api: 3103 } as const;

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

const PLACEHOLDER_DATABASE_URL = 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

/**
 * Environment for a served app.
 *
 * THE ABSENCE OF A CREDENTIAL IS PART OF WHAT IS UNDER TEST. Each app gets
 * exactly what its job needs and nothing more (F-07: a tenant-facing process
 * must not be able to open a cross-tenant connection even if it tried).
 *
 *   - web       — a PLACEHOLDER database url. The marketing site is statically
 *                 rendered and touches no database at all.
 *   - dashboard — the real TENANT url and the customer signing key. From Phase
 *                 2B this is a real database-backed application: it
 *                 authenticates customers and reads workspace data through the
 *                 tenant role. It is given NO `DATABASE_PLATFORM_URL` and NO
 *                 `SECRET_VAULT_KEK`, so a cross-tenant read is impossible in
 *                 the served process rather than merely un-attempted.
 *   - admin     — additionally the PLATFORM url and the vault key, because
 *                 signing in, activating configuration and storing a secret are
 *                 the journeys the admin suite exercises.
 *
 * Every value comes from .env.test; none is hard-coded.
 */
function serverEnv(app: keyof typeof PORTS): Record<string, string> {
  if (app === 'web') {
    return { DATABASE_URL: PLACEHOLDER_DATABASE_URL };
  }

  const env: Record<string, string> = {
    DATABASE_URL: process.env['DATABASE_URL'] ?? PLACEHOLDER_DATABASE_URL,
    APP_ENV: 'development',
  };

  // The design showcase is opt-in and refused in production. The suite enables
  // it for the dashboard only, which is also the assertion that the gate works:
  // the admin app never sets it, so a showcase route there stays a 404.
  if (app === 'dashboard') {
    env['BRANDSPACE_DESIGN_SHOWCASE'] = '1';
    // Brand Brain chat is proxied to the API service. Without this the proxy
    // answers an honest 503 and the chat suite would be testing the fallback.
    env['BRANDSPACE_API_URL'] = `http://127.0.0.1:${PORTS.api}`;
  }

  const keys =
    app === 'admin'
      ? ['DATABASE_PLATFORM_URL', 'SECRET_VAULT_KEK', 'PLATFORM_SESSION_SECRET']
      : app === 'api'
        ? // The API is the platform surface for customer-initiated AI: it
          // resolves a CUSTOMER session on the tenant pool and runs the gateway
          // on the platform one, so it needs both credentials.
          ['DATABASE_PLATFORM_URL', 'CUSTOMER_SESSION_SECRET', 'SECRET_VAULT_KEK']
        : ['CUSTOMER_SESSION_SECRET'];

  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Build once, then serve — production output is what CI and users actually get. */
function server(app: keyof typeof PORTS) {
  if (app === 'api') {
    // Fastify, not Next: it takes its port from the environment and its
    // readiness probe is the public liveness endpoint rather than a locale root.
    return {
      command: `pnpm --filter @brandspace/api start`,
      url: `http://127.0.0.1:${PORTS.api}/health/live`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { ...serverEnv('api'), PORT: String(PORTS.api) },
    };
  }
  return {
    command: `pnpm --filter @brandspace/${app} start --port ${PORTS[app]}`,
    // The admin root redirects to /en/login when signed out, which is a 307 and
    // a perfectly good readiness signal.
    url: `http://127.0.0.1:${PORTS[app]}/en`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: serverEnv(app),
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
    // Three suites sign in and mutate shared state, so none may run twice
    // concurrently against one database: the Control Center activates
    // configuration and stores secrets, the Phase 3 suite edits the plan and
    // flag drafts, and the customer suite accepts a single-use invitation and
    // edits workspace settings. Each runs in a serial project and is excluded
    // from the two viewport projects.
    //
    // `plans-entitlements` and `secrets-pagination` share the `admin-console`
    // project rather than getting their own: all three drive the same signed-in
    // Control Center against the same configuration drafts and the same secret
    // table, and two serial projects would still run in parallel WITH EACH
    // OTHER — which is exactly the interleaving the serial mode exists to
    // prevent. `secrets-pagination` in particular seeds sixty records and
    // asserts a total; a concurrent suite storing a secret would break it.
    {
      name: 'chromium-desktop',
      testIgnore:
        /(admin-console|plans-entitlements|secrets-pagination|customer-app|brand-brain|design-system|demo-reference)\.(spec|screenshots\.spec)\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      name: 'chromium-mobile',
      testIgnore:
        /(admin-console|plans-entitlements|secrets-pagination|customer-app|brand-brain|design-system|demo-reference)\.(spec|screenshots\.spec)\.ts/,
      use: { ...devices['Pixel 5'], launchOptions },
    },
    {
      name: 'admin-console',
      testMatch: /(admin-console|plans-entitlements|secrets-pagination)\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    /*
     * VISUAL-REVIEW EVIDENCE — OPT-IN, and now actually opt-in.
     *
     * This project writes PNGs into `docs/visual-review/`; it asserts almost
     * nothing. The comment here has always said "not run by default", but
     * Playwright runs every project in this array unless `--project` is given,
     * so it ran in `pnpm test:e2e` — including in CI, where the files it
     * produces are discarded when the runner is torn down.
     *
     * That was merely wasteful at eight captures. At fifty-five, several of
     * them full-page shots of a document twelve thousand pixels tall, it turned
     * a three-minute CI step into one that did not finish. The intent is now
     * implemented rather than described: `pnpm e2e:screenshots` sets the flag,
     * and nothing else runs it.
     */
    ...(process.env['BRANDSPACE_VISUAL_REVIEW'] === '1'
      ? [
          {
            name: 'visual-review',
            testMatch: /\.screenshots\.spec\.ts$/,
            fullyParallel: false,
            use: {
              ...devices['Desktop Chrome'],
              viewport: { width: 1440, height: 900 },
              launchOptions,
            },
          },
        ]
      : []),
    {
      // The design system's own suite: the shell, the showcase, responsive
      // behaviour and accessibility. It signs in for the shell journeys, so it
      // is serial for the same reason the other two are.
      name: 'design-system',
      testMatch: /design-system\.spec\.ts$/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      name: 'customer-app',
      testMatch: /customer-app\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      /*
       * Brand Brain gets its own project for the same reason the customer app
       * does: it signs in, mutates real workspace state and asserts against it.
       * Running it in parallel with itself would have two browsers creating a
       * brand in the same workspace and each asserting on the other's rows.
       */
      name: 'brand-brain',
      testMatch: /brand-brain\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
  ],

  webServer: [server('web'), server('dashboard'), server('admin'), server('api')],
});
