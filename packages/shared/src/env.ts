import { z } from 'zod';
import { currentEnvironment, type DeploymentEnvironment } from './deployment';

/**
 * Environment schema. Parsed once at boot — the process refuses to start on a bad
 * environment rather than failing later at an unpredictable point.
 *
 * D-02: infrastructure is provider-agnostic. Every host, bucket, and endpoint is an
 * environment variable, so Render / Cloudflare R2 (the intended initial target) can be
 * swapped without a code change.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);

export const envSchema = z.object({
  NODE_ENV: nodeEnv.default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  // --- Data region (D-03: GCC / Middle East residency when deployed) --------
  DATA_REGION: z.string().min(1).default('local'),

  // --- Database -------------------------------------------------------------
  /** Runtime connection. MUST be a role with NOBYPASSRLS that does not own the tables. */
  DATABASE_URL: z.string().url(),
  /** Migration connection. Owns the schema. Never used to serve a request. */
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  /**
   * PLATFORM connection — the one identity RLS grants cross-tenant visibility.
   *
   * Set ONLY in processes that perform audited platform operations. It must be
   * absent from the public website, the customer dashboard, tenant-facing API
   * processes and ordinary workers. See docs/SECURITY.md §2.4.
   */
  DATABASE_PLATFORM_URL: z.string().url().optional(),

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // --- Object storage (S3-compatible; Cloudflare R2 is the first target) ----
  /*
   * OPTIONAL IN THE SCHEMA, REQUIRED IN PRODUCTION BY THE FACTORY. A developer
   * with no bucket must still be able to start; a production deployment with no
   * bucket must not accept an upload. `createObjectStore` is where that second
   * rule lives, because it is the only place that knows whether the caller is
   * about to store a customer's file — see packages/storage/src/factory.ts.
   */
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * Path-style addressing instead of virtual-host style.
   *
   * The one genuinely provider-dependent switch: R2 and AWS serve virtual-host
   * style, MinIO and several self-hosted gateways serve only path-style, and a
   * client that guesses wrong fails at DNS rather than with a useful error.
   * Absent means virtual-host, which is what R2 wants.
   */
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),

  // --- Hostnames (D-04) -----------------------------------------------------
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),
  DASHBOARD_URL: z.string().url().default('http://localhost:3001'),
  ADMIN_URL: z.string().url().default('http://localhost:3002'),
  API_URL: z.string().url().default('http://localhost:3003'),

  // --- Session realms -------------------------------------------------------
  /**
   * Separate signing keys per realm. docs/SECURITY.md §3: a customer session
   * presented to Admin must be cryptographically unusable, not merely rejected by policy.
   */
  CUSTOMER_SESSION_SECRET: z.string().min(32).optional(),
  PLATFORM_SESSION_SECRET: z.string().min(32).optional(),

  // --- Encryption -----------------------------------------------------------
  /*
   * THREE KEY DOMAINS, THREE KEYS (D-136, D-206). One key, one blast radius:
   * the publish worker must unwrap a CUSTOMER token and must never be able to
   * unwrap a PLATFORM credential; the login surface must verify a TOTP code and
   * must never be able to reach either of the others.
   *
   * All optional in the schema and REQUIRED IN PRODUCTION by
   * `assertProductionSafety` below — because "optional" here means "a local
   * developer who is not using the vault need not invent one", and that is a
   * different question from whether a deployment may run without it.
   */
  /** Key-encryption key for the platform secret vault. KMS-ready. */
  SECRET_VAULT_KEK: z.string().min(32).optional(),
  /** Phase 6 — customers' own social OAuth tokens (D-136). */
  SOCIAL_TOKEN_VAULT_KEK: z.string().min(32).optional(),
  /** Phase 9 — customers' own MFA seeds, reachable from the login surface (D-206). */
  CUSTOMER_MFA_VAULT_KEK: z.string().min(32).optional(),

  // --- Public base URLs -----------------------------------------------------
  /*
   * Every OAuth callback and every return URL is built from these at request
   * time rather than written down in code, which is what lets staging use its
   * own hostnames with no code change.
   */
  PUBLIC_API_BASE_URL: z.string().url().default('http://localhost:3003'),
  PUBLIC_DASHBOARD_BASE_URL: z.string().url().default('http://localhost:3001'),
  /** Where the dashboard reaches the API server-side; internal, not browser-visible. */
  BRANDSPACE_API_URL: z.string().url().default('http://localhost:3003'),

  /**
   * The service token the dashboard presents to the API's internal email
   * delivery route.
   *
   * NOT A PROVIDER CREDENTIAL, and not a session secret: it authenticates a
   * PROCESS to another process across the private network. It exists because a
   * customer signing up has no session to forward, and the dashboard must not
   * hold the key that decrypts the email provider's own credential (F-07).
   *
   * Optional in the schema because a developer running only the dashboard does
   * not need it. Without it in production, customer email is not sent and the
   * API says so at boot.
   */
  INTERNAL_SERVICE_TOKEN: z.string().min(32).optional(),

  // --- Development billing provider ----------------------------------------
  /**
   * NOT A PAYMENT CREDENTIAL, and there is none in this repository to be one
   * (D-204). It signs and verifies the loopback events the development payment
   * adapter produces, so a forged one is refused exactly as a real provider's
   * would be. Absent in production is correct: the development adapter cannot
   * run there at all.
   */
  BILLING_DEV_WEBHOOK_SECRET: z.string().min(16).optional(),

  // --- Observability --------------------------------------------------------
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('brandspace'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Guard rails that cannot be expressed in the schema alone.
 *
 * PHASE 10 §18 WIDENED THE GATE from `NODE_ENV` to "either NODE_ENV or APP_ENV
 * says production". `NODE_ENV=production` is true of every built app, including
 * the one the E2E suite serves, so it alone under-fires on a real deployment
 * that forgot to set it and over-fires on a developer checking a bundle. Both
 * are checked: a deployment is production if EITHER says so, which is the
 * cautious direction.
 */
export type StartupServiceProfile = 'complete' | 'api' | 'worker';

function requireProductionValue(
  env: Env,
  name: keyof Env,
): void {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${String(name)} is required in production for this service.`);
  }
}

function forbidProductionValue(
  env: Env,
  name: keyof Env,
): void {
  const value = env[name];
  if (value !== undefined && value !== '') {
    throw new Error(
      `${String(name)} must not be present in production for this service; ` +
        'keeping unused credentials out preserves the intended blast-radius boundary.',
    );
  }
}

function assertProductionSafety(
  env: Env,
  profile: StartupServiceProfile = 'complete',
): void {
  const deployment = currentEnvironment({ APP_ENV: env.APP_ENV });
  if (env.NODE_ENV !== 'production' && deployment !== 'PRODUCTION') return;

  if (
    env.CUSTOMER_SESSION_SECRET !== undefined &&
    env.PLATFORM_SESSION_SECRET !== undefined &&
    env.CUSTOMER_SESSION_SECRET === env.PLATFORM_SESSION_SECRET
  ) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET and PLATFORM_SESSION_SECRET must differ: ' +
        'the two session realms must not share a signing key (docs/SECURITY.md §3).',
    );
  }
  if (env.DATABASE_PLATFORM_URL !== undefined && env.DATABASE_PLATFORM_URL === env.DATABASE_URL) {
    throw new Error(
      'DATABASE_PLATFORM_URL and DATABASE_URL must be different roles: the whole point ' +
        'of the two-pool model is that the tenant connection cannot reach cross-tenant data ' +
        '(docs/SECURITY.md §2.4).',
    );
  }

  const placeholders = [
    'change-me',
    'placeholder',
    'example',
    'devonly',
    'localhost',
    // Phase 10. The three markers the shipped templates and CI actually use.
    // A value copied straight out of `.env.example` is not a secret, and
    // finding that out at the first sign-in is finding out too late.
    'replace_with',
    'ci-only',
    'test-only',
  ];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!/SECRET|KEK|PASSWORD|KEY/i.test(key)) continue;
    if (placeholders.some((p) => value.toLowerCase().includes(p))) {
      throw new Error(`${key} still holds a placeholder value in production.`);
    }
  }

  /*
   * SERVICE-AWARE SECRET REQUIREMENTS.
   *
   * The complete contract is useful for local verification and CI, but no
   * production process should receive secrets it cannot use. In particular,
   * the worker must never receive the platform-vault or MFA key, and the API
   * does not need either session-signing key. The per-service profile enforces
   * the minimum set each process is designed to hold while preserving the
   * blast-radius boundaries in docs/SECURITY.md and the Railway env matrix.
   */
  if (profile === 'complete') {
    requireProductionValue(env, 'CUSTOMER_SESSION_SECRET');
    requireProductionValue(env, 'PLATFORM_SESSION_SECRET');
    requireProductionValue(env, 'SECRET_VAULT_KEK');
    requireProductionValue(env, 'SOCIAL_TOKEN_VAULT_KEK');
    requireProductionValue(env, 'CUSTOMER_MFA_VAULT_KEK');
  } else if (profile === 'api') {
    requireProductionValue(env, 'DATABASE_PLATFORM_URL');
    requireProductionValue(env, 'SECRET_VAULT_KEK');
    requireProductionValue(env, 'SOCIAL_TOKEN_VAULT_KEK');
    requireProductionValue(env, 'CUSTOMER_MFA_VAULT_KEK');
    forbidProductionValue(env, 'CUSTOMER_SESSION_SECRET');
    forbidProductionValue(env, 'PLATFORM_SESSION_SECRET');
  } else {
    requireProductionValue(env, 'SOCIAL_TOKEN_VAULT_KEK');
    forbidProductionValue(env, 'DATABASE_PLATFORM_URL');
    forbidProductionValue(env, 'CUSTOMER_SESSION_SECRET');
    forbidProductionValue(env, 'PLATFORM_SESSION_SECRET');
    forbidProductionValue(env, 'SECRET_VAULT_KEK');
    forbidProductionValue(env, 'CUSTOMER_MFA_VAULT_KEK');
    forbidProductionValue(env, 'INTERNAL_SERVICE_TOKEN');
  }

  const keyDomains = [
    env.SECRET_VAULT_KEK,
    env.SOCIAL_TOKEN_VAULT_KEK,
    env.CUSTOMER_MFA_VAULT_KEK,
  ].filter((value): value is string => value !== undefined);
  const distinct = new Set(keyDomains);
  if (distinct.size !== keyDomains.length) {
    throw new Error(
      'SECRET_VAULT_KEK, SOCIAL_TOKEN_VAULT_KEK and CUSTOMER_MFA_VAULT_KEK must all differ when present. ' +
        'Sharing one collapses separate blast radii into one (D-136, D-206).',
    );
  }

  /*
   * NO PRODUCTION DEPLOYMENT CARRIES THE DEVELOPMENT BILLING SECRET. Its only
   * consumer is the development payment adapter, which cannot run in
   * production at all — so its presence means a production environment was
   * assembled by copying a development one, and the next thing copied might
   * not be harmless.
   */
  if (env.BILLING_DEV_WEBHOOK_SECRET) {
    throw new Error(
      'BILLING_DEV_WEBHOOK_SECRET must not be set in production: it belongs to the ' +
        'development payment adapter, which cannot run there (D-204).',
    );
  }

  if (env.PUBLIC_WEB_URL.startsWith('http://') || env.PUBLIC_API_BASE_URL.startsWith('http://')) {
    throw new Error(
      'Public URLs must use https in production. An OAuth callback or a session cookie ' +
        'sent over http is readable by anything on the path.',
    );
  }
}

/**
 * VALIDATE THE ENVIRONMENT AT START-UP — Phase 10 §18.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. `parseEnv` and the whole schema above have
 * been in the repository since Phase 1, and until Phase 10 the only thing that
 * ever called them was a unit test. Every guarantee in this file — the two
 * session realms differing, no placeholder secret, the platform pool being a
 * different role — was therefore asserted against a fixture and enforced
 * nowhere. Processes call this on the way up, so the checks apply to the thing
 * they were written about.
 *
 * IT REFUSES TO START IN PRODUCTION AND WARNS EVERYWHERE ELSE. A developer with
 * half an environment should get a readable warning and a running process; a
 * production deployment with half an environment should not come up at all,
 * because the alternative is finding out from a customer.
 */
export interface StartupConfigurationResult {
  readonly environment: DeploymentEnvironment;
  readonly ok: boolean;
  /** Human-readable problems. Never contains a value, only variable names. */
  readonly problems: readonly string[];
}

export function validateStartupConfiguration(
  source: NodeJS.ProcessEnv = process.env,
  profile: StartupServiceProfile = 'complete',
): StartupConfigurationResult {
  const environment = currentEnvironment(source as Record<string, string | undefined>);
  try {
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    assertProductionSafety(parsed.data, profile);
    return { environment, ok: true, problems: [] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid environment configuration.';
    const problems = message.split('\n').filter((line) => line.trim().length > 0);
    if (environment === 'PRODUCTION') throw error;
    return { environment, ok: false, problems };
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // The message names the failing variables but never prints their values.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertProductionSafety(parsed.data, 'complete');
  return parsed.data;
}
