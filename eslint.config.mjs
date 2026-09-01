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
  config: ['shared', 'database'],
  auth: ['shared', 'database'],
  ui: ['shared'],
  entitlements: ['shared', 'database', 'config'],
  'ai-gateway': ['shared', 'database', 'config', 'entitlements'],
  'social-connectors': ['shared', 'database', 'config', 'entitlements'],
  billing: ['shared', 'database', 'config', 'entitlements'],
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

/** Apps may use any package, but never another app, and never the database directly. */
function appBoundary(app) {
  return {
    files: [`apps/${app}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: DB_ACCESS_PATHS,
          patterns: ALL_APPS.filter((a) => a !== app).map((other) => ({
            group: [`@brandspace/${other}`, `@brandspace/${other}/*`, `**/apps/${other}/**`],
            message: `Module boundary violation: apps/${app} may not import apps/${other}.`,
          })),
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
      '**/*.d.ts',
      'packages/database/prisma/migrations/**',
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

  // --- Config, scripts and tests are allowed to be noisier ----------------
  {
    files: ['**/*.config.{ts,mts,js,mjs}', 'scripts/**/*.ts', 'tests/**/*.ts', '**/seed.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
