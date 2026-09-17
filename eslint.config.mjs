// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

/**
 * Module boundary matrix — docs/ARCHITECTURE.md §4.1.
 * Each package may import ONLY from the packages listed here.
 * A package may never import from an app; an app may never import from another app.
 */
const ALLOWED_IMPORTS = {
  shared: [],
  database: ['shared'],
  observability: ['shared'],
  // The envelope-encryption primitives and the KEK seam, and NOTHING else —
  // no table, no service, no policy (D-136). Both the platform Secret Service
  // and the tenant social-token vault build on it, which is only safe because
  // it holds no privileged data path of its own.
  vault: ['shared'],
  secrets: ['shared', 'database', 'vault'],
  config: ['shared', 'database'],
  // auth needs secrets to resolve the TOTP seed at MFA verification.
  auth: ['shared', 'database', 'secrets'],
  ui: ['shared'],
  // The object-storage boundary and the signed-download grant. `shared` only:
  // it is infrastructure, and a driver that could reach the database or a
  // domain package would stop being swappable for a vendor adapter.
  storage: ['shared'],
  // Queue definitions and the dispatch client. `shared` only: a producer must
  // be able to import this without pulling the database or the domain packages
  // in, and the payloads are pointers rather than data (payloads.ts).
  jobs: ['shared'],
  providers: ['shared', 'config'],
  entitlements: ['shared', 'database', 'config'],
  'ai-gateway': ['shared', 'database', 'config', 'entitlements', 'providers'],
  // Brand Brain reads configuration, enforces entitlements, and routes every
  // AI operation through the gateway rather than touching a provider itself.
  'brand-brain': ['shared', 'database', 'config', 'entitlements', 'ai-gateway', 'storage'],
  // The Asset Library. It reads configuration, enforces entitlements and
  // quotas, and reaches object storage through the same boundary Brand Brain
  // uses. NOT `ai-gateway`: nothing in this phase generates anything, and an
  // import nobody needs is a dependency somebody later uses.
  assets: ['shared', 'database', 'config', 'entitlements', 'storage'],
  // Phase 6 — Social Publishing. It reaches the vault for CUSTOMER OAuth
  // tokens, which are their own key domain (D-136), and `jobs` to dispatch
  // publish work.
  //
  // NOT `secrets`: a customer token is TENANT data and must never travel the
  // platform credential path (F-07).
  //
  // NOT the content package either. The publish pipeline needs one answer from
  // Approvals — "is this item cleared to go?" — and takes it through a narrow
  // interface the caller injects, exactly as the calendar takes `ApprovalGate`.
  // A package dependency would have bought the same answer and a cycle risk.
  'social-connectors': [
    'shared',
    'database',
    'config',
    'entitlements',
    'providers',
    'vault',
    'jobs',
  ],
  billing: ['shared', 'database', 'config', 'entitlements', 'providers'],
  /*
   * Phase 7 — the measurement half.
   *
   * It reaches `social-connectors` for ONE thing: the shared provider request
   * budget. A platform's rate limit belongs to our relationship with that
   * platform rather than to whichever feature is talking to it, so the budget
   * lives with the package that owns the relationship and analytics draws on it
   * — which is what stops a backfill spending the allowance a scheduled post
   * needs.
   *
   * NOT `secrets`, and NOT `vault`: a customer's social token is resolved by the
   * caller and handed in already decrypted (F-07, D-136). Nothing here can open
   * a credential.
   *
   * NOT `brand-brain` and NOT `content`: reasoning about the numbers is
   * `intelligence`'s job, and an import nobody needs is a dependency somebody
   * later uses.
   */
  analytics: [
    'shared',
    'database',
    'config',
    'entitlements',
    'ai-gateway',
    'jobs',
    'social-connectors',
  ],
  /*
   * Phase 7 — the reasoning half: strategy, monthly plans, content gaps and the
   * Brand Brain write-back D-64 left open.
   *
   * It imports `brand-brain` because an inferred learning re-enters the brand
   * through THAT module's existing governance — a second approval system would
   * be a second answer to "who decides what is true about this brand".
   */
  intelligence: [
    'shared',
    'database',
    'config',
    'entitlements',
    'ai-gateway',
    'brand-brain',
    'analytics',
  ],
  /*
   * Phase 7 — the Copilot.
   *
   * IT IS AN ORCHESTRATOR OVER DOMAIN SERVICES, NOT A DATABASE SHORTCUT, and this
   * list is where that is enforced: it imports the domains whose tools it
   * exposes, each of which performs its own authorization. There is no path by
   * which a Copilot tool reaches a table a domain service does not already own.
   */
  copilot: [
    'shared',
    'database',
    'config',
    'entitlements',
    'ai-gateway',
    'brand-brain',
    'analytics',
    'intelligence',
    'content',
  ],
  /*
   * Phase 7 — the automation engine.
   *
   * NOT `ai-gateway`: no automation action in this phase spends AI credits, and
   * the import that does not exist is the one that cannot be used to add one
   * without a deliberate change to this matrix.
   */
  automation: ['shared', 'database', 'config', 'entitlements', 'jobs'],
};

const ALL_PACKAGES = Object.keys(ALLOWED_IMPORTS);
const ALL_APPS = ['web', 'dashboard', 'admin', 'api', 'worker'];

/**
 * Restriction on direct database access. `packages/database` is the only package
 * permitted to talk to PostgreSQL — docs/ARCHITECTURE.md §4.1, CLAUDE.md §3.
 *
 * NOTE: this lives inside every generated block rather than in a separate one.
 * In ESLint flat config a later block setting the same rule REPLACES it, so a
 * standalone `no-restricted-imports` block would silently wipe the boundary
 * patterns below. They must be declared together.
 */
/**
 * F-01: the platform connection pool opens the ONE identity with cross-tenant
 * visibility. Only packages/database/src/platform.ts may import it — that file
 * is `asPlatform()`, the single audited entrance.
 *
 * Declared as a pattern so relative and package-style specifiers are both
 * caught, and merged into every block below because in ESLint flat config a
 * later block setting the same rule REPLACES it.
 */
const PLATFORM_POOL_PATTERN = {
  group: ['**/platform-pool', '**/platform-pool.*', '@brandspace/database/platform-pool'],
  message:
    'Restricted module: the platform database pool has cross-tenant visibility and may only be ' +
    'imported by packages/database/src/platform.ts (asPlatform), the single audited entrance. ' +
    'Use asPlatform() from @brandspace/database instead. See docs/SECURITY.md §2.4.',
};

const DB_ACCESS_PATHS = [
  {
    name: '@prisma/client',
    message:
      'Only packages/database may import @prisma/client directly. ' +
      'Use the tenant-scoped client exported by @brandspace/database. ' +
      'See docs/ARCHITECTURE.md §4.1 and CLAUDE.md §3.',
  },
  {
    name: 'pg',
    message: 'Only packages/database may open a PostgreSQL connection.',
  },
];

/** Build the merged no-restricted-imports config block for one package. */
function packageBoundary(pkg) {
  const allowed = new Set(ALLOWED_IMPORTS[pkg]);
  const forbiddenPackages = ALL_PACKAGES.filter((p) => p !== pkg && !allowed.has(p)).map(
    (p) => `@brandspace/${p}`,
  );
  const forbiddenApps = ALL_APPS.map((a) => `@brandspace/${a}`);
  const allowedLabel = [...allowed].map((a) => `@brandspace/${a}`).join(', ') || '(none)';

  return {
    files: [`packages/${pkg}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // packages/database is the sole exception to the DB access rule.
          paths: pkg === 'database' ? [] : DB_ACCESS_PATHS,
          patterns: [
            PLATFORM_POOL_PATTERN,
            // Only auth may reach the Secret Service among packages.
            ...(pkg === 'auth' || pkg === 'secrets' ? [] : [SECRETS_PATTERN]),
            // No package outside database may open a platform-scoped client.
            ...(pkg === 'database' ? [] : [PLATFORM_CLIENT_PATTERN]),
            ...[...forbiddenPackages, ...forbiddenApps].map((name) => ({
              group: [name, `${name}/*`],
              message:
                `Module boundary violation: packages/${pkg} may not import ${name}. ` +
                `Allowed: ${allowedLabel}. See docs/ARCHITECTURE.md §4.1.`,
            })),
            {
              group: ['**/apps/**'],
              message: 'Module boundary violation: a package may never import from an app.',
            },
          ],
        },
      ],
    },
  };
}

/**
 * F-07: the Secret Service holds the decrypt path for every platform
 * credential. Tenant-facing surfaces have no legitimate reason to import it, and
 * a bundler that pulled it into a client build would be a catastrophic leak.
 *
 * Allowed: apps/admin and apps/api (server-side platform routes), and
 * packages/auth (resolves the TOTP seed at MFA verification).
 */
const SECRETS_PATTERN = {
  group: ['@brandspace/secrets', '@brandspace/secrets/*', '**/packages/secrets/**'],
  message:
    'Restricted module: @brandspace/secrets can decrypt platform credentials and is server-only. ' +
    'It may not be imported by the public website, the customer dashboard or ordinary workers. ' +
    'See docs/SECURITY.md §2.4 and docs/DECISIONS.md F-07.',
};

/** Apps that must never touch platform credentials. */
const TENANT_FACING_APPS = new Set(['web', 'dashboard', 'worker']);

/**
 * F-07: the platform database client is the narrow, approved seam for
 * server-side platform surfaces. apps/admin and apps/api may use it; nothing
 * else may, because it connects with cross-tenant visibility.
 */
const PLATFORM_CLIENT_PATTERN = {
  group: ['@brandspace/database/platform', '**/platform-client', '**/platform-client.*'],
  message:
    'Restricted module: the platform database client has cross-tenant visibility and may only be ' +
    'used by apps/admin and apps/api. Tenant code must use withWorkspace() from ' +
    '@brandspace/database. See docs/SECURITY.md §2.4 and docs/DECISIONS.md F-07.',
};

/** The only apps permitted to open a platform-scoped database client. */
const PLATFORM_SURFACE_APPS = new Set(['admin', 'api']);

/** Apps may use any package, but never another app, and never the database directly. */
function appBoundary(app) {
  return {
    files: [`apps/${app}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: DB_ACCESS_PATHS,
          patterns: [
            PLATFORM_POOL_PATTERN,
            ...(TENANT_FACING_APPS.has(app) ? [SECRETS_PATTERN] : []),
            ...(PLATFORM_SURFACE_APPS.has(app) ? [] : [PLATFORM_CLIENT_PATTERN]),
            ...ALL_APPS.filter((a) => a !== app).map((other) => ({
              group: [`@brandspace/${other}`, `@brandspace/${other}/*`, `**/apps/${other}/**`],
              message: `Module boundary violation: apps/${app} may not import apps/${other}.`,
            })),
          ],
        },
      ],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      /*
       * PLAYWRIGHT'S OWN OUTPUT. Both are gitignored and neither is source: the
       * report bundles minified vendor JavaScript, which ESLint dutifully reports
       * as hundreds of `no-undef` and `eqeqeq` errors the moment anybody runs the
       * E2E suite before `pnpm verify`. Since `verify:all` runs verify and then
       * the suite, a SECOND run of it failed on the first run's artefacts.
       */
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      'packages/database/prisma/migrations/**',
      // The owner-approved visual reference, vendored VERBATIM. It is evidence
      // of what was approved, not source we own — linting or reformatting it
      // would make it stop being an exact copy of what was reviewed.
      'docs/visual-reference/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { 'import-x': importX },
    languageOptions: {
      parserOptions: { projectService: false },
    },
    rules: {
      // `any` requires a written justification comment — CLAUDE.md §5.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'import-x/no-cycle': ['error', { maxDepth: 6 }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Use the injected clock rather than `new Date()` so time-dependent logic is testable.',
        },
      ],
    },
  },

  // --- Module boundaries -------------------------------------------------
  ...ALL_PACKAGES.map(packageBoundary),
  ...ALL_APPS.map(appBoundary),

  // --- The single approved importer of the platform pool ------------------
  // packages/database/src/platform.ts IS asPlatform(). It is the audited
  // entrance, so it is the one file permitted to open the platform connection.
  {
    files: [
      'packages/database/src/platform.ts',
      'packages/database/src/platform-pool.ts',
      'packages/database/src/platform-client.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [], patterns: [] }],
    },
  },

  // --- Config, scripts and tests are allowed to be noisier ----------------
  {
    files: ['**/*.config.{ts,mts,js,mjs}', 'scripts/**/*.ts', 'tests/**/*.ts', '**/seed.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
