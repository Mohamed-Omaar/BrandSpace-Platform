import { z } from 'zod';

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

  // --- Redis ----------------------------------------------------------------
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // --- Object storage (S3-compatible; Cloudflare R2 intended) ---------------
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().default('auto'),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

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
  CUSTOMER_SESSION_SECRET: z.string().min(32),
  PLATFORM_SESSION_SECRET: z.string().min(32),

  // --- Encryption -----------------------------------------------------------
  /** Key-encryption key for the secret vault (envelope encryption). KMS-ready. */
  SECRET_VAULT_KEK: z.string().min(32).optional(),

  // --- Observability --------------------------------------------------------
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default('brandspace'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Guard rails that cannot be expressed in the schema alone.
 * CLAUDE.md §2.2: bootstrap fallbacks are never used when NODE_ENV=production.
 */
function assertProductionSafety(env: Env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.CUSTOMER_SESSION_SECRET === env.PLATFORM_SESSION_SECRET) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET and PLATFORM_SESSION_SECRET must differ: ' +
        'the two session realms must not share a signing key (docs/SECURITY.md §3).',
    );
  }
  const placeholders = ['change-me', 'placeholder', 'example', 'devonly', 'localhost'];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!/SECRET|KEK|PASSWORD|KEY/i.test(key)) continue;
    if (placeholders.some((p) => value.toLowerCase().includes(p))) {
      throw new Error(`${key} still holds a placeholder value in production.`);
    }
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
  assertProductionSafety(parsed.data);
  return parsed.data;
}
