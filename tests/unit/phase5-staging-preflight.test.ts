import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE STAGING PREFLIGHT — Phase 5.
 *
 * WHAT IT IS AND WHY IT IS TESTED THROUGH THE REAL COMMAND. Bringing up a Railway
 * environment means pasting several dozen variables across five services, and the
 * failure mode is not a crash: it is a service that starts and is subtly wrong.
 * This suite runs the ACTUAL command an operator will run, because the property
 * worth asserting is what that command prints and what it exits with — a test of
 * an internal helper would not have caught a preflight that reports beautifully
 * and always exits 0.
 *
 * NO VALUE MAY EVER BE PRINTED. An operator will paste this output into an issue
 * or a screenshot, so a leak here is a leak in the place people are least
 * guarded. That is asserted explicitly below against a fixture whose values are
 * distinctive enough to find.
 */

const ROOT = path.resolve(__dirname, '../..');

/** Values distinctive enough that finding one in the output is unambiguous. */
const SECRET_MARKER = 'zzsecretzz';

const COMMON = [
  'NODE_ENV=production',
  'APP_ENV=staging',
  'DATA_REGION=eu-west',
  'REDIS_URL=redis://default:pw@redis.railway.internal:6379',
  'PUBLIC_WEB_URL=https://staging-web.up.railway.app',
  'PUBLIC_API_BASE_URL=https://staging-api.up.railway.app',
  'PUBLIC_DASHBOARD_BASE_URL=https://staging-dash.up.railway.app',
  'PUBLIC_ADMIN_BASE_URL=https://staging-admin.up.railway.app',
  'STORAGE_ENDPOINT=https://account.r2.cloudflarestorage.com',
  'STORAGE_BUCKET=brandspace-staging-media',
  `STORAGE_ACCESS_KEY_ID=staging-r2-key-${SECRET_MARKER}`,
  `STORAGE_SECRET_ACCESS_KEY=staging-r2-secret-${SECRET_MARKER}-aaaaaaaaaaaa`,
];
const APP_DB = 'DATABASE_URL=postgresql://brandspace_app:pw@postgres.railway.internal:5432/railway';
const PLATFORM_DB =
  'DATABASE_PLATFORM_URL=postgresql://brandspace_platform:pw@postgres.railway.internal:5432/railway';

const SERVICE_LINES: Record<string, string[]> = {
  web: [],
  dashboard: [
    APP_DB,
    'CLIENT_ORIGIN_STRATEGY=railway-edge',
    `CUSTOMER_SESSION_SECRET=staging-customer-session-${SECRET_MARKER}-aaaaaaaa`,
    `CUSTOMER_MFA_VAULT_KEK=staging-customer-mfa-kek-${SECRET_MARKER}-bbbbbbbb`,
    `INTERNAL_SERVICE_TOKEN=staging-internal-token-${SECRET_MARKER}-cccccccccc`,
  ],
  admin: [
    APP_DB,
    PLATFORM_DB,
    `PLATFORM_SESSION_SECRET=staging-platform-session-${SECRET_MARKER}-dddddddd`,
    `SECRET_VAULT_KEK=staging-secret-vault-kek-${SECRET_MARKER}-eeeeeeeeeeee`,
    `INTERNAL_SERVICE_TOKEN=staging-internal-token-${SECRET_MARKER}-cccccccccc`,
  ],
  api: [
    APP_DB,
    PLATFORM_DB,
    'CLIENT_ORIGIN_STRATEGY=railway-edge',
    `SECRET_VAULT_KEK=staging-secret-vault-kek-${SECRET_MARKER}-eeeeeeeeeeee`,
    `SOCIAL_TOKEN_VAULT_KEK=staging-social-kek-${SECRET_MARKER}-ffffffffffff`,
    `CUSTOMER_MFA_VAULT_KEK=staging-customer-mfa-kek-${SECRET_MARKER}-bbbbbbbb`,
    `INTERNAL_SERVICE_TOKEN=staging-internal-token-${SECRET_MARKER}-cccccccccc`,
    `BILLING_DEV_WEBHOOK_SECRET=staging-billing-${SECRET_MARKER}-gggggggggggg`,
  ],
  worker: [APP_DB, `SOCIAL_TOKEN_VAULT_KEK=staging-social-kek-${SECRET_MARKER}-ffffffffffff`],
};

/** A directory of per-service files, which is how Railway keeps variables. */
function stagingDir(mutate: (lines: Record<string, string[]>) => void = () => undefined): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-preflight-'));
  const lines: Record<string, string[]> = {};
  for (const [service, extra] of Object.entries(SERVICE_LINES)) {
    // `web` holds nothing at all, not even storage.
    const base = service === 'web' ? COMMON.filter((l) => !l.startsWith('STORAGE_')) : COMMON;
    lines[service] = [...base, ...extra];
  }
  mutate(lines);
  for (const [service, content] of Object.entries(lines)) {
    writeFileSync(path.join(dir, `${service}.env`), `${content.join('\n')}\n`);
  }
  return dir;
}

interface Run {
  readonly status: number;
  readonly output: string;
}

function preflight(args: readonly string[]): Run {
  try {
    const output = execFileSync('pnpm', ['exec', 'tsx', 'scripts/staging-preflight.ts', ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('a complete staging environment passes', () => {
  it('reports every service ready and exits 0', () => {
    const run = preflight(['--env-dir', stagingDir()]);
    expect(run.output).toContain('every service is ready');
    expect(run.status).toBe(0);
  }, 120_000);

  it('NEVER PRINTS A VALUE, only names and statuses', () => {
    // The whole point: this output gets pasted into issues and screenshots.
    const run = preflight(['--env-dir', stagingDir()]);
    expect(run.output).not.toContain(SECRET_MARKER);
    expect(run.output).not.toContain('postgresql://');
    expect(run.output).not.toContain('redis://');
  }, 120_000);
});

describe('it refuses an environment that would deploy wrong', () => {
  it('FAILS when APP_ENV is missing, which would make staging think it is development', () => {
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        for (const service of Object.keys(lines)) {
          lines[service] = lines[service]!.filter((l) => !l.startsWith('APP_ENV='));
        }
      }),
    ]);
    expect(run.output).toMatch(/APP_ENV: warning/);
    expect(run.status).toBe(1);
  }, 120_000);

  it('FAILS when APP_ENV says production, which is the dangerous direction', () => {
    /*
     * A staging environment that believes it is production would be held to the
     * production KMS contract and would look, to every guard in the system, like
     * the real thing. Catching it here costs nothing; catching it later costs a
     * cross-environment key.
     */
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        lines['dashboard'] = lines['dashboard']!.map((l) =>
          l === 'APP_ENV=staging' ? 'APP_ENV=production' : l,
        );
      }),
    ]);
    expect(run.output).toMatch(/APP_ENV: warning/);
    expect(run.status).toBe(1);
  }, 120_000);

  it('FAILS a service holding a key domain it must not have', () => {
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        // Long enough to pass the schema's minimum, so the rule that fires is
        // the BOUNDARY one and not a length complaint.
        lines['dashboard'] = [
          ...lines['dashboard']!,
          `SECRET_VAULT_KEK=staging-platform-kek-${SECRET_MARKER}-hhhhhhhhhhhh`,
        ];
      }),
    ]);
    expect(run.output).toMatch(/not permitted/);
    expect(run.status).toBe(1);
  }, 120_000);

  it('FAILS a PARTIAL storage contract, which is worse than none', () => {
    // Half a storage contract is a service that believes it can store and cannot.
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        lines['dashboard'] = lines['dashboard']!.filter(
          (l) => !l.startsWith('STORAGE_SECRET_ACCESS_KEY='),
        );
      }),
    ]);
    expect(run.output).toMatch(/partially configured/);
    expect(run.status).toBe(1);
  }, 120_000);

  it('FAILS a template value that every other rule would accept', () => {
    // `REPLACE_WITH_…` in a bucket name carries no word the secret-placeholder
    // scan looks for, so it passes the schema and fails at the first upload.
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        lines['api'] = lines['api']!.map((l) =>
          l.startsWith('STORAGE_BUCKET=') ? 'STORAGE_BUCKET=REPLACE_WITH_STAGING_BUCKET' : l,
        );
      }),
    ]);
    expect(run.output).toMatch(/still holds a template value/);
    expect(run.status).toBe(1);
  }, 120_000);

  it('REPORTS absent storage as unavailable rather than failing, per the architecture', () => {
    /*
     * Storage is optional in the schema and required by `createObjectStore` at
     * the moment a file is stored. A staging deploy without it is not invalid —
     * it is one where uploads will fail, and saying so is more useful than
     * either silence or refusal.
     */
    const run = preflight([
      '--env-dir',
      stagingDir((lines) => {
        lines['worker'] = lines['worker']!.filter((l) => !l.startsWith('STORAGE_'));
      }),
      '--service',
      'worker',
    ]);
    expect(run.output).toMatch(/object storage: unavailable/);
    expect(run.status).toBe(0);
  }, 120_000);
});

describe('it refuses to be used in a way that would mislead', () => {
  it('rejects a single --env-file with no --service', () => {
    // Railway keeps variables PER SERVICE, so one file is one service. Checking
    // a combined file against all five reports every service as holding
    // variables it must not — true, and useless.
    const dir = stagingDir();
    const run = preflight(['--env-file', path.join(dir, 'api.env')]);
    expect(run.output).toMatch(/holds ONE service/);
    expect(run.status).toBe(2);
  }, 120_000);

  it('rejects an unknown service name', () => {
    const run = preflight(['--env-dir', stagingDir(), '--service', 'nonesuch']);
    expect(run.status).toBe(2);
  }, 120_000);
});
