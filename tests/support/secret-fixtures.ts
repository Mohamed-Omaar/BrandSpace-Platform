/**
 * Test-owned secret fixtures and their cleanup — F-53.
 *
 * WHY THIS EXISTS. The isolation suites create roughly thirty-six secrets per
 * run and the E2E suite one, and none of them cleaned up. On a long-lived local
 * database that reached 853 records, which made the Control Center's secrets
 * page slow enough to fail a ten-second test ceiling. CI never saw it because
 * CI builds a fresh database every run — which is exactly why it went unnoticed
 * for two phases.
 *
 * ============================ SAFETY, DELIBERATELY ==========================
 *
 * THIS IS TEST-HARNESS CODE AND MUST NEVER BE REACHABLE FROM THE PRODUCT.
 * It lives under `tests/`, is imported only by suites, and is not exported from
 * any package. There is no product-facing secret deletion path and this does not
 * create one: the Secret Service still offers only disable and revoke, which are
 * audited state changes that keep the row.
 *
 * The deletion is narrow by construction, not by care:
 *
 *   1. It deletes ONLY rows whose `ref` carries a marker that production refs
 *      can never contain, combined with a token unique to one suite run.
 *   2. It REFUSES to run without a well-formed token. A bug that passes an
 *      empty string throws instead of matching every row — the failure mode of
 *      a broad `deleteMany` is silent and total, so the guard is an assertion
 *      rather than a default.
 *   3. Being per-run, two suites running in parallel cannot delete each other's
 *      fixtures, which a "delete everything created since I started" approach
 *      would do.
 *
 * ===========================================================================
 */
import type { PrismaClient } from '@prisma/client';

/**
 * The marker every test-created secret carries in its `ref`.
 *
 * `buildSecretRef` slugs each segment to `[a-z0-9-]`, so this survives into the
 * stored ref verbatim. No real provider is called this.
 */
export const TEST_SECRET_MARKER = 'zz-testfixture';

/** `zz-testfixture-<random>` — unique to one suite run. */
export function testSecretProvider(): string {
  return `${TEST_SECRET_MARKER}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Does this look like a token `deleteTestSecrets` may safely act on? */
export function isTestSecretProvider(provider: string): boolean {
  return new RegExp(`^${TEST_SECRET_MARKER}-[0-9a-f]{8}$`).test(provider);
}

/**
 * Delete the secrets one run created, and nothing else.
 *
 * Versions first, then records: `secret_version` references `secret_record`, and
 * the foreign key is what would otherwise refuse the delete.
 *
 * Returns how many records went, so a suite can assert its own cleanup rather
 * than assume it.
 */
export async function deleteTestSecrets(prisma: PrismaClient, provider: string): Promise<number> {
  if (!isTestSecretProvider(provider)) {
    // Not a warning and not a no-op. An unrecognised token means the caller has
    // lost track of what it owns, and the safe response to that is to stop.
    throw new Error(
      `Refusing to delete secrets for "${provider}": not a test-fixture token. ` +
        'Cleanup only ever removes rows this run created.',
    );
  }

  // A bare `contains` is safe here because the TOKEN is the safety property,
  // not its position: `zz-testfixture-<8 hex>` cannot occur in a real ref, and
  // the guard above has already refused anything that is not one. Matching on
  // position instead would force every suite to put the token in the same ref
  // segment, and they legitimately cannot — `platform-auth` asserts its MFA
  // refs start `mfa-totp/platform/`, which is a real property of the product
  // and not something a cleanup scheme may bend.
  const where = { ref: { contains: provider } } as const;

  const records = await prisma.secretRecord.findMany({ where, select: { id: true } });
  if (records.length === 0) return 0;

  const ids = records.map((r) => r.id);
  await prisma.secretVersion.deleteMany({ where: { secretRecordId: { in: ids } } });
  const deleted = await prisma.secretRecord.deleteMany({ where: { id: { in: ids } } });
  return deleted.count;
}
