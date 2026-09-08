import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretService, buildSecretRef } from '@brandspace/secrets';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import {
  deleteTestSecrets,
  isTestSecretProvider,
  testSecretProvider,
} from '../support/secret-fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * The cleanup contract itself — F-53.
 *
 * The other half of the fix. Pagination stops an unbounded listing from being
 * slow; this stops the database from growing without limit in the first place,
 * which is what produced 853 records and the failure that started all of it.
 *
 * What is asserted here is that cleanup is NARROW: it removes exactly the rows
 * one run created, leaves every other row alone, and refuses outright when it
 * cannot tell which are which. A cleanup that is merely effective is a
 * `deleteMany` waiting to take the wrong table with it.
 */

let prisma: PrismaClient;
let secrets: SecretService;
let ownerId: string;

const TEST_SECRET_PROVIDER = testSecretProvider();
const ENV = 'DEVELOPMENT' as const;

function actor() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: PLATFORM_PERMISSIONS.map((p) => p.key),
  };
}

async function createFor(provider: string, name: string): Promise<string> {
  const meta = await secrets.createSecret(actor(), {
    ref: buildSecretRef({
      category: 'ai_provider',
      provider,
      environment: 'development',
      name,
    }),
    name,
    category: 'ai_provider',
    environment: ENV,
    value: `sk-cleanup-${name}-abcdefghijklmnop`,
  });
  return meta.id;
}

beforeAll(async () => {
  prisma = platformRoleClient();
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'k'.repeat(48) } });

  const roleId = await ensurePlatformRole(prisma);
  const created = await prisma.platformUser.create({
    data: {
      email: `cleanup-${crypto.randomUUID()}@brandspace.local`,
      name: 'Cleanup Fixture Owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  ownerId = created.id;
}, 120_000);

afterAll(async () => {
  if (prisma) await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);
  await prisma?.$disconnect();
});

describe('cleanup removes exactly what one run created', () => {
  it('deletes its own rows and their versions', async () => {
    const id = await createFor(TEST_SECRET_PROVIDER, 'own-row');

    expect(await prisma.secretRecord.count({ where: { id } })).toBe(1);
    expect(await prisma.secretVersion.count({ where: { secretRecordId: id } })).toBe(1);

    const deleted = await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.secretRecord.count({ where: { id } })).toBe(0);
    // The version goes with it: the foreign key would otherwise refuse the
    // delete, and a version left behind would reference nothing.
    expect(await prisma.secretVersion.count({ where: { secretRecordId: id } })).toBe(0);
  });

  it("leaves another run's rows completely alone", async () => {
    // THE PROPERTY THAT MATTERS. Two suites run in parallel against one
    // database; a cleanup that removed "everything created since I started"
    // would delete the other suite's fixtures mid-test.
    const otherRun = testSecretProvider();
    const mine = await createFor(TEST_SECRET_PROVIDER, 'mine');
    const theirs = await createFor(otherRun, 'theirs');

    await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);

    expect(await prisma.secretRecord.count({ where: { id: mine } })).toBe(0);
    expect(await prisma.secretRecord.count({ where: { id: theirs } })).toBe(1);

    await deleteTestSecrets(prisma, otherRun);
    expect(await prisma.secretRecord.count({ where: { id: theirs } })).toBe(0);
  });

  it('leaves rows that are not test fixtures at all', async () => {
    // A record whose ref carries no marker: whatever else cleanup does, it must
    // never touch one of these.
    const production = await prisma.secretRecord.create({
      data: {
        ref: `ai_provider/a-real-provider/development/key-${crypto.randomUUID().slice(0, 8)}`,
        name: 'Not a fixture',
        category: 'ai_provider',
        environment: ENV,
        status: 'ACTIVE',
        createdByPlatformUserId: ownerId,
      },
    });

    await createFor(TEST_SECRET_PROVIDER, 'alongside');
    await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER);

    expect(await prisma.secretRecord.count({ where: { id: production.id } })).toBe(1);

    // Remove the probe explicitly by id — not through the cleanup helper, which
    // is exactly the point: it cannot reach this row.
    await prisma.secretRecord.delete({ where: { id: production.id } });
  });

  it('is idempotent: a second cleanup finds nothing and does not fail', async () => {
    await createFor(TEST_SECRET_PROVIDER, 'twice');
    expect(await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER)).toBeGreaterThanOrEqual(1);
    expect(await deleteTestSecrets(prisma, TEST_SECRET_PROVIDER)).toBe(0);
  });
});

describe('cleanup refuses when it cannot tell what it owns', () => {
  it.each([
    ['an empty string', ''],
    ['a bare word', 'secrets'],
    ['a SQL wildcard', '%'],
    ['the marker with no token', 'zz-testfixture'],
    ['a malformed token', 'zz-testfixture-NOTHEX!'],
    ['a token of the wrong length', 'zz-testfixture-abc'],
  ])('refuses %s', async (_label, provider) => {
    // Throwing, not returning zero. An unrecognised token means the caller has
    // lost track of what it owns, and the safe answer to that is to stop — the
    // failure mode of a broad deleteMany is silent and total.
    await expect(deleteTestSecrets(prisma, provider)).rejects.toThrow(/Refusing to delete/);
  });

  it('recognises a well-formed token and nothing else', () => {
    expect(isTestSecretProvider(TEST_SECRET_PROVIDER)).toBe(true);
    expect(isTestSecretProvider('zz-testfixture-0123abcd')).toBe(true);
    expect(isTestSecretProvider('zz-testfixture-0123abcde')).toBe(false);
    expect(isTestSecretProvider('prefix-zz-testfixture-0123abcd')).toBe(false);
    expect(isTestSecretProvider('')).toBe(false);
  });
});

describe('repeated runs do not accumulate', () => {
  it('returns the table to its starting size after several cycles', async () => {
    // The regression F-53 exists to prevent, in miniature: run the create-and-
    // clean cycle repeatedly and the row count must come back to where it
    // started, not climb.
    const before = await prisma.secretRecord.count();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const runProvider = testSecretProvider();
      for (let i = 0; i < 4; i += 1) {
        await createFor(runProvider, `cycle${cycle}-${i}`);
      }
      expect(await prisma.secretRecord.count()).toBe(before + 4);
      await deleteTestSecrets(prisma, runProvider);
      expect(await prisma.secretRecord.count()).toBe(before);
    }

    expect(await prisma.secretRecord.count()).toBe(before);
  });
});
