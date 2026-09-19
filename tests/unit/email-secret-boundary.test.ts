import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * F-07 — the customer dashboard sends real email without ever holding a
 * credential that could send it.
 *
 * THE PRESSURE THIS RESISTS. Four email operations originate in the customer
 * dashboard: signup verification, its resend, password reset and workspace
 * invitations. Making them send for real means resolving the active provider
 * and decrypting its key, which needs `SECRET_VAULT_KEK`. The cheapest way to
 * ship working email is to put that key in the dashboard's environment — one
 * variable, ten seconds, and the platform's entire blast-radius separation is
 * gone. It would also pass every functional test, which is why this file is a
 * test rather than a paragraph in a document.
 *
 * WHAT ACTUALLY HAPPENS INSTEAD. The dashboard asks; the API sends
 * (`apps/api/src/routes/internal-email.ts`). The flow logic, transactions and
 * anti-enumeration behaviour are untouched — only the last hop moved to a
 * process already allowed to hold a provider credential.
 *
 * FOUR INDEPENDENT CHECKS, because any one of them alone could rot:
 *   1. the dashboard's source never names the vault key,
 *   2. the dashboard never constructs a real provider adapter,
 *   3. the resolver that CAN decrypt lives in exactly one place, and
 *   4. the Railway blueprint does not grant the dashboard the key either.
 */

/**
 * Strip comments before searching.
 *
 * A file that only NAMES the key in prose — "must never receive
 * `SECRET_VAULT_KEK`" — is documenting the boundary, not crossing it. Matching
 * raw text would make the correct comment a build failure and quietly train
 * people to delete the explanation.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '.git') {
      continue;
    }
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

const DASHBOARD_FILES = walk(path.join(repoRoot, 'apps', 'dashboard', 'src'));
const WORKER_FILES = walk(path.join(repoRoot, 'apps', 'worker', 'src'));

function relative(file: string): string {
  return path.relative(repoRoot, file);
}

describe('the customer dashboard never holds a key that can send mail', () => {
  it('names SECRET_VAULT_KEK nowhere in its source', () => {
    const offenders = DASHBOARD_FILES.filter((file) =>
      code(readFileSync(file, 'utf8')).includes('SECRET_VAULT_KEK'),
    ).map(relative);

    expect(offenders, 'F-07: the dashboard must not read the platform vault key').toEqual([]);
  });

  it('never constructs the Secret Service, which is the only path to a value', () => {
    const offenders = DASHBOARD_FILES.filter((file) => {
      const source = code(readFileSync(file, 'utf8'));
      return /new\s+SecretService|getSecretService|resolveSecret\s*\(/.test(source);
    }).map(relative);

    expect(offenders).toEqual([]);
  });

  it('never constructs a real email provider adapter', () => {
    /*
     * `OutboxEmailProvider` is permitted: it writes an auditable row, delivers
     * nothing, and REFUSES to construct in production. What must not appear is
     * an adapter that can reach a vendor — one of those in the dashboard means
     * a credential reached the dashboard to feed it.
     */
    const offenders = DASHBOARD_FILES.filter((file) =>
      /new\s+ResendEmailProvider/.test(code(readFileSync(file, 'utf8'))),
    ).map(relative);

    expect(offenders).toEqual([]);
  });

  it('constructs its email provider in exactly one file', () => {
    /*
     * Three call sites each answering "which provider sends" for themselves is
     * how a platform ends up sending through one nobody activated. The
     * dashboard's single answer is `customer-context.ts`, which returns the
     * outbox in development and the API-delegating adapter in production.
     */
    const constructors = DASHBOARD_FILES.filter((file) =>
      /new\s+(OutboxEmailProvider|ApiEmailProvider)/.test(code(readFileSync(file, 'utf8'))),
    ).map(relative);

    expect(constructors).toEqual(['apps/dashboard/src/server/customer-context.ts']);
  });
});

describe('the worker holds no sending credential either', () => {
  it('names SECRET_VAULT_KEK nowhere in its source', () => {
    const offenders = WORKER_FILES.filter((file) =>
      code(readFileSync(file, 'utf8')).includes('SECRET_VAULT_KEK'),
    ).map(relative);

    expect(offenders).toEqual([]);
  });

  it('constructs no email provider at all', () => {
    /*
     * It sends through the notification pipeline. A provider constructed here
     * would be a second sending path with no configuration behind it.
     */
    const offenders = WORKER_FILES.filter((file) =>
      /new\s+\w*EmailProvider/.test(code(readFileSync(file, 'utf8'))),
    ).map(relative);

    expect(offenders).toEqual([]);
  });
});

describe('the one place that resolves the active email provider', () => {
  const RESOLVER = path.join(repoRoot, 'apps', 'api', 'src', 'email-provider.ts');

  it('is the only file in the repository that constructs ResendEmailProvider for delivery', () => {
    /*
     * ONE PROCESS, ONE CONSTRUCTOR, and the list got shorter rather than
     * longer. The Control Center used to construct one as well, for a Test
     * Connection button; that button is gone, because the credential the
     * platform asks for is a Resend Sending-access key restricted to the
     * verified domain and Resend refuses it every read-only check. Anything
     * outside this list is a second answer to "which provider sends", which is
     * the failure this asserts against.
     */
    const ALLOWED = [
      'apps/api/src/email-provider.ts',
      // The adapter's own tests. `packages/auth/src/email-resend.ts` is
      // deliberately absent: it DEFINES the class and never constructs one.
      'tests/unit/production-adapters.test.ts',
    ];

    const found = [
      ...walk(path.join(repoRoot, 'apps')),
      ...walk(path.join(repoRoot, 'packages')),
      ...walk(path.join(repoRoot, 'tests')),
    ]
      .map(relative)
      // This file is the scanner: it names the constructor in a pattern, not a
      // call, and matching itself would make the assertion self-defeating.
      .filter((file) => file !== 'tests/unit/email-secret-boundary.test.ts')
      .filter((file) =>
        /new\s+ResendEmailProvider/.test(code(readFileSync(path.join(repoRoot, file), 'utf8'))),
      )
      .sort();

    expect(found).toEqual(ALLOWED.sort());
  });

  it('decrypts through the Secret Service and hands the value straight to the adapter', () => {
    const source = readFileSync(RESOLVER, 'utf8');
    expect(source).toContain('resolveSecret');
    expect(source).toContain('new ResendEmailProvider');

    /*
     * THE VALUE MUST NOT BE LOGGED OR RETURNED. The file logs the FROM address,
     * which is configuration an operator needs to see, and nothing else about
     * the credential. This catches the obvious regression — a debug line added
     * while chasing a delivery failure, which is exactly when somebody reaches
     * for one.
     */
    const stripped = code(source);
    expect(stripped).not.toMatch(/log\.\w+\([^)]*apiKey/);
    expect(stripped).not.toMatch(/console\./);
  });
});

describe('the deployment blueprint grants the same boundary', () => {
  const blueprint = readFileSync(path.join(repoRoot, '.railway', 'railway.ts'), 'utf8');

  /** The `env: { … }` block of one service declaration. */
  function serviceEnv(name: string): string {
    const start = blueprint.indexOf(`const ${name} = service('${name}'`);
    expect(start, `${name} is missing from the blueprint`).toBeGreaterThan(-1);
    const envAt = blueprint.indexOf('env: {', start);
    const end = blueprint.indexOf('\n  });', envAt);
    return blueprint.slice(envAt, end);
  }

  it('does not give the dashboard SECRET_VAULT_KEK', () => {
    const env = code(serviceEnv('dashboard'));
    expect(env).not.toContain('SECRET_VAULT_KEK');
    expect(env).not.toContain('SOCIAL_TOKEN_VAULT_KEK');
    // It DOES get the MFA key: the login surface verifies a TOTP code (D-206).
    expect(env).toContain('CUSTOMER_MFA_VAULT_KEK');
  });

  it('gives the dashboard the service token instead, which sends nothing by itself', () => {
    expect(code(serviceEnv('dashboard'))).toContain('INTERNAL_SERVICE_TOKEN');
  });

  it('gives the API the vault key, because it is the process that decrypts', () => {
    const env = code(serviceEnv('api'));
    expect(env).toContain('vaultEnv');
    expect(env).toContain('INTERNAL_SERVICE_TOKEN');
  });

  it('gives the worker neither the vault key nor the service token', () => {
    const env = code(serviceEnv('worker'));
    expect(env).not.toContain('SECRET_VAULT_KEK');
    expect(env).not.toContain('INTERNAL_SERVICE_TOKEN');
  });

  it('gives object-storage credentials only to the three services that move bytes', () => {
    for (const name of ['dashboard', 'api', 'worker']) {
      expect(code(serviceEnv(name)), `${name} needs STORAGE_*`).toContain('storageEnv');
    }
    for (const name of ['admin', 'web']) {
      expect(code(serviceEnv(name)), `${name} must not hold a bucket credential`).not.toContain(
        'storageEnv',
      );
    }
  });

  it('declares no storage value, only the variable names', () => {
    /*
     * A bucket name, an account id or a key pasted into this file is a
     * credential in git history. Every STORAGE_* entry is an `ownerSecret(…)`
     * declaration carrying a description and nothing else.
     */
    for (const name of [
      'STORAGE_ENDPOINT',
      'STORAGE_BUCKET',
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'INTERNAL_SERVICE_TOKEN',
    ]) {
      const at = blueprint.indexOf(`${name}: `);
      expect(at, `${name} is missing from the blueprint`).toBeGreaterThan(-1);
      expect(blueprint.slice(at, at + 60)).toMatch(
        new RegExp(`${name}: (ownerSecret|internalServiceToken)`),
      );
    }
  });
});
