import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Module boundary enforcement — docs/ARCHITECTURE.md §4.1.
 *
 * These tests exist because the boundary rules were, at one point, silently NOT
 * enforced: in ESLint flat config a later block setting the same rule replaces it
 * entirely, so a separate `no-restricted-imports` block wiped the boundary
 * patterns. Lint passed and every violation was allowed.
 *
 * A lint rule nobody has watched fail is not known to work, so each boundary is
 * asserted in both directions: forbidden imports are rejected, permitted ones are
 * not.
 */

/**
 * Lint a probe AS IF it lived at `relativeFile`, without writing it there.
 *
 * `--stdin-filename` makes ESLint apply exactly the configuration that path
 * would get. The probe used to be written into the real source tree and
 * deleted after — and every other suite that walks those directories could
 * list it and then find it gone (ENOENT), failing on a file that was never
 * source. Nothing touches the disk now, so there is nothing to race.
 */
function lintSnippet(relativeFile: string, source: string): string {
  try {
    execFileSync('pnpm', ['eslint', '--stdin', '--stdin-filename', relativeFile], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: `${source}\nexport const probe = 1;\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return '';
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const VIOLATION = /Module boundary violation|Only packages\/database/;

describe('forbidden imports are rejected', () => {
  it.each([
    [
      'packages/shared/src/__boundary_probe.ts',
      "import '@brandspace/billing';",
      'shared may import nothing',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/billing';",
      'config may not import billing',
    ],
    [
      'packages/billing/src/__boundary_probe.ts',
      "import '@brandspace/ai-gateway';",
      'sibling domain packages',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/worker';",
      'a package may not import an app',
    ],
    [
      'packages/entitlements/src/__boundary_probe.ts',
      "import '@prisma/client';",
      'direct Prisma outside database',
    ],
    ['apps/api/src/__boundary_probe.ts', "import 'pg';", 'direct pg connection from an app'],
    [
      'apps/web/src/__boundary_probe.ts',
      "import '@brandspace/admin';",
      'an app may not import another app',
    ],
  ])('rejects %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).toMatch(VIOLATION);
  });
});

describe('permitted imports are allowed', () => {
  it.each([
    [
      'packages/entitlements/src/__boundary_probe.ts',
      "import '@brandspace/config';",
      'declared in the allowlist',
    ],
    [
      'packages/database/src/__boundary_probe.ts',
      "import '@prisma/client';",
      'database is the one DB exception',
    ],
    [
      'apps/api/src/__boundary_probe.ts',
      "import '@brandspace/database';",
      'apps may use any package',
    ],
  ])('allows %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).not.toMatch(VIOLATION);
  });
});

/**
 * Phase 2A boundaries — F-07.
 *
 * Two modules can leak the whole platform if they end up in the wrong bundle:
 *
 *   - `@brandspace/secrets` holds the ONLY decrypt path for platform credentials;
 *   - `@brandspace/database/platform` opens a connection with cross-tenant
 *     visibility.
 *
 * `import 'server-only'` and the pools' runtime guards are the other two
 * controls. This one is the cheapest and the earliest, so it is also the one
 * most likely to be silently disabled by an unrelated lint edit — hence probes
 * in both directions.
 */
const RESTRICTED = /Restricted module/;

describe('the Secret Service is unreachable from tenant-facing surfaces (F-07)', () => {
  it.each([
    ['apps/web/src/__boundary_probe.ts', 'the public website'],
    ['apps/dashboard/src/__boundary_probe.ts', 'the customer dashboard'],
    ['apps/worker/src/__boundary_probe.ts', 'background workers'],
    ['packages/entitlements/src/__boundary_probe.ts', 'an ordinary domain package'],
    ['packages/ui/src/__boundary_probe.ts', 'the design system'],
    ['packages/storage/src/__boundary_probe.ts', 'the object-storage boundary'],
  ])('rejects @brandspace/secrets in %s (%s)', (file) => {
    expect(lintSnippet(file, "import '@brandspace/secrets';")).toMatch(RESTRICTED);
  });

  it.each([
    ['packages/auth/src/__boundary_probe.ts', 'auth resolves the TOTP seed at MFA verification'],
    ['apps/admin/src/__boundary_probe.ts', 'the Control Center manages secrets'],
    ['apps/api/src/__boundary_probe.ts', 'server-side platform routes'],
  ])('allows @brandspace/secrets in %s (%s)', (file) => {
    expect(lintSnippet(file, "import '@brandspace/secrets';")).not.toMatch(RESTRICTED);
  });

  it('rejects a deep relative import that bypasses the package specifier', () => {
    expect(
      lintSnippet(
        'apps/dashboard/src/__boundary_probe.ts',
        "import '../../../packages/secrets/src/service';",
      ),
    ).toMatch(RESTRICTED);
  });
});

describe('the platform database client is unreachable outside admin and api (F-07)', () => {
  it.each([
    ['apps/web/src/__boundary_probe.ts', 'the public website'],
    ['apps/dashboard/src/__boundary_probe.ts', 'the customer dashboard'],
    ['apps/worker/src/__boundary_probe.ts', 'background workers'],
    ['packages/config/src/__boundary_probe.ts', 'a package must take its client as a parameter'],
    ['packages/auth/src/__boundary_probe.ts', 'auth included'],
  ])('rejects @brandspace/database/platform in %s (%s)', (file) => {
    expect(lintSnippet(file, "import '@brandspace/database/platform';")).toMatch(RESTRICTED);
  });

  it.each([
    ['apps/admin/src/__boundary_probe.ts', 'the Control Center'],
    ['apps/api/src/__boundary_probe.ts', 'server-side platform routes'],
    ['packages/database/src/__boundary_probe.ts', 'the package that owns the seam'],
  ])('allows @brandspace/database/platform in %s (%s)', (file) => {
    expect(lintSnippet(file, "import '@brandspace/database/platform';")).not.toMatch(RESTRICTED);
  });

  it('still rejects the raw platform pool everywhere, including apps/admin', () => {
    // The approved seam is the client, not the pool. asPlatform() is the only
    // audited entrance to cross-tenant reads of TENANT data.
    expect(
      lintSnippet(
        'apps/admin/src/__boundary_probe.ts',
        "import '@brandspace/database/platform-pool';",
      ),
    ).toMatch(RESTRICTED);
  });
});

describe('Phase 2A packages stay inside their declared dependencies', () => {
  it.each([
    [
      'packages/observability/src/__boundary_probe.ts',
      "import '@brandspace/database';",
      'observability must not reach the database',
    ],
    [
      'packages/secrets/src/__boundary_probe.ts',
      "import '@brandspace/config';",
      'secrets must not depend on configuration',
    ],
    [
      /*
       * Phase 10. The Integrations Hub reads configuration, MASKED secret
       * metadata and its own health table — and nothing else. It must not
       * reach an adapter package: an import of `ai-gateway`, `billing`,
       * `social-connectors` or `storage` would put it at the centre of the
       * dependency graph and let a Control Center screen reach a customer
       * OAuth token.
       */
      'packages/integrations/src/__boundary_probe.ts',
      "import '@brandspace/ai-gateway';",
      'the Integrations Hub must not import an adapter package',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/auth';",
      'configuration must not depend on auth',
    ],
    [
      'packages/secrets/src/__boundary_probe.ts',
      "import '@prisma/client';",
      'only packages/database may import Prisma directly',
    ],
    [
      'packages/observability/src/__boundary_probe.ts',
      "import '@brandspace/admin';",
      'a package may never import an app',
    ],
  ])('rejects %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).toMatch(/Module boundary violation|Only packages\/database/);
  });

  it.each([
    [
      'packages/secrets/src/__boundary_probe.ts',
      "import '@brandspace/database';",
      'secrets takes its Prisma client from the database package',
    ],
    [
      'packages/config/src/__boundary_probe.ts',
      "import '@brandspace/database';",
      'so does configuration',
    ],
    [
      'packages/providers/src/__boundary_probe.ts',
      "import '@brandspace/config';",
      'adapters are configured, not hard-coded',
    ],
    [
      'packages/observability/src/__boundary_probe.ts',
      "import '@brandspace/shared';",
      'observability reuses the shared redaction layer',
    ],
  ])('allows %s (%s)', (file, source) => {
    expect(lintSnippet(file, source)).not.toMatch(
      /Module boundary violation|Only packages\/database/,
    );
  });
});
