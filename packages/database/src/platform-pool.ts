import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { loadRepoEnv, requireDatabaseUrl } from './env-file';
import { assertServerSide } from './server-only-guard';

/**
 * PLATFORM CONNECTION POOL — RESTRICTED MODULE.
 *
 * ============================================================================
 * This module opens a connection as `brandspace_platform`, the ONE database
 * identity that RLS policies grant cross-tenant visibility to.
 *
 * IT MUST ONLY BE IMPORTED BY packages/database/src/platform.ts.
 *
 * That restriction is enforced three ways, so it cannot rot:
 *   1. It is NOT exported from the package index, so `@brandspace/database`
 *      consumers cannot reach it.
 *   2. An ESLint rule forbids importing this path from anywhere else, including
 *      every app.
 *   3. tests/unit/platform-pool-boundary.test.ts asserts both of the above, and
 *      that no app imports it.
 * ============================================================================
 *
 * The credential itself lives in DATABASE_PLATFORM_URL, which is set ONLY in
 * deployments that perform platform operations. It is never present in the
 * public website, the customer dashboard, tenant-facing API processes, or
 * ordinary workers — see .env.example and docs/SECURITY.md §2.4.
 */

const PLATFORM_URL_VAR = 'DATABASE_PLATFORM_URL';

let platformClient: PrismaClient | undefined;

/**
 * The platform pool. Fails closed when DATABASE_PLATFORM_URL is absent, with an
 * error that names the variable and never prints its value.
 */
export function getPlatformPrisma(repoRoot?: string): PrismaClient {
  // Fail loudly if a bundler ever pulled this into client code, rather than
  // shipping a database credential to a browser.
  assertServerSide('The platform database pool');
  if (platformClient) return platformClient;

  if (repoRoot !== undefined) loadRepoEnv(repoRoot);

  const connectionString = requireDatabaseUrl(
    [PLATFORM_URL_VAR],
    'this is an audited platform operation requiring the platform database role',
  );

  platformClient = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      // Platform work is rare and deliberate. A small pool limits the blast
      // radius of a leaked credential and makes unusual volume visible.
      max: 4,
    }),
  });
  return platformClient;
}

/** Test seam: inject a pre-built platform client. */
export function setPlatformPrismaForTesting(client: PrismaClient | undefined): void {
  platformClient = client;
}

export async function disconnectPlatformPrisma(): Promise<void> {
  if (platformClient) {
    await platformClient.$disconnect();
    platformClient = undefined;
  }
}

/**
 * Assert the connection really is the platform role and cannot bypass RLS.
 * Called on first use so a misconfigured URL fails immediately and loudly
 * rather than silently running platform work as some other identity.
 */
export async function assertPlatformRole(client: PrismaClient): Promise<void> {
  const rows = await client.$queryRaw<
    { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;

  const row = rows[0];
  if (!row) throw new Error('Could not resolve the platform database role.');

  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `The platform connection must not be superuser or BYPASSRLS. ` +
        `Its access comes from a role-targeted RLS policy that is evaluated normally, ` +
        `so WITH CHECK still applies. (role="${row.current_user}")`,
    );
  }
  if (row.current_user !== 'brandspace_platform') {
    throw new Error(
      `${PLATFORM_URL_VAR} must connect as brandspace_platform, not "${row.current_user}". ` +
        `Cross-tenant visibility is granted by role, so the wrong role would either ` +
        `fail closed or, worse, run platform work under a tenant identity.`,
    );
  }
}
