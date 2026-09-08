import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SecretService,
  buildSecretRef,
  DEFAULT_SECRET_PAGE_SIZE,
  MAX_SECRET_PAGE_SIZE,
} from '@brandspace/secrets';
import { PLATFORM_PERMISSIONS } from '@brandspace/shared';
import { ensurePlatformRole, platformRoleClient } from './fixtures';
import {
  deleteTestSecrets,
  isTestSecretProvider,
  testSecretProvider,
} from '../support/secret-fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * Server-side pagination for the secrets listing — F-53.
 *
 * The defect this closes: `listSecrets` returned every matching record, the
 * Control Center rendered all of them, and a database that had accumulated 853
 * made the page slow enough to fail a ten-second ceiling. The query was never
 * the problem — loading an unbounded result set was.
 *
 * These run against real PostgreSQL because the properties are properties of
 * the QUERY: that a page reads at most `pageSize` rows, that the order is total
 * enough for offsets to be well defined, and that the count matches the filter
 * the rows came from.
 *
 * Every secret here carries this run's cleanup token, and `afterAll` removes
 * exactly those — a suite about not accumulating records that accumulated
 * records would be self-refuting.
 */

let prisma: PrismaClient;
let secrets: SecretService;
let ownerId: string;

const TEST_SECRET_PROVIDER = testSecretProvider();
const ENV = 'DEVELOPMENT' as const;
const OWNER_PERMISSIONS = PLATFORM_PERMISSIONS.map((p) => p.key);

function actor() {
  return {
    platformUserId: ownerId,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: OWNER_PERMISSIONS,
  };
}

/** A category used ONLY by this suite, so its pages contain only its rows. */
const CATEGORY = 'ai_provider' as const;

/** Create `count` secrets whose names sort predictably. */
async function seedSecrets(count: number, namePrefix = 'p'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    // Zero-padded so lexical order matches numeric order and the assertions can
    // name which record should be on which page.
    const ordinal = String(i).padStart(4, '0');
    await secrets.createSecret(actor(), {
      ref: buildSecretRef({
        category: CATEGORY,
        provider: TEST_SECRET_PROVIDER,
        environment: 'development',
        name: `${namePrefix}-${ordinal}`,
      }),
      name: `${namePrefix}-${ordinal}`,
      category: CATEGORY,
      environment: ENV,
      value: `sk-fixture-${ordinal}-abcdefghijklmnop`,
    });
  }
}

/** Every row this run created, and no other run's. */
function scoped(extra: Record<string, unknown> = {}) {
  return { environment: ENV, search: TEST_SECRET_PROVIDER, ...extra };
}

/**
 * One GROUP of this run's rows.
 *
 * Each block below seeds its own prefix, and they share a database: scoping an
 * assertion to the run rather than the group makes it depend on which other
 * blocks have already run, which is how a suite becomes order-dependent.
 * `ref` is `category/provider/environment/name`, so the prefix pins it.
 */
function group(prefix: string, extra: Record<string, unknown> = {}) {
  return {
    environment: ENV,
    search: `${TEST_SECRET_PROVIDER}/development/${prefix}-`,
    ...extra,
  };
}

beforeAll(async () => {
  prisma = platformRoleClient();
  secrets = new SecretService({ prisma, env: { SECRET_VAULT_KEK: 'k'.repeat(48) } });

  // Bootstrapped, not assumed: CI applies migrations and runs no seed.
  const roleId = await ensurePlatformRole(prisma);
  const created = await prisma.platformUser.create({
    data: {
      email: `pagination-${crypto.randomUUID()}@brandspace.local`,
      name: 'Pagination Fixture Owner',
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

describe('the cleanup token itself', () => {
  it('is a recognisable test-fixture token', () => {
    expect(isTestSecretProvider(TEST_SECRET_PROVIDER)).toBe(true);
  });

  it('refuses to delete for anything that is not one', async () => {
    // The guard that makes this safe. A bug passing an empty string must throw,
    // not match every row: the failure mode of a broad deleteMany is silent and
    // total.
    for (const bad of ['', 'secrets', '%', 'zz-testfixture', 'zz-testfixture-GGGGGGGG']) {
      await expect(deleteTestSecrets(prisma, bad)).rejects.toThrow(/Refusing to delete/);
    }
  });
});

describe('an empty result set', () => {
  it('reports zeroes rather than a nonsensical range', async () => {
    const page = await secrets.listSecrets(actor(), scoped());
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    // NOT "showing 1–0 of 0".
    expect(page.from).toBe(0);
    expect(page.to).toBe(0);
    expect(page.hasPrevious).toBe(false);
    expect(page.hasNext).toBe(false);
    // One page, so the UI has a coherent "page 1 of 1" to render.
    expect(page.totalPages).toBe(1);
  });
});

describe('one secret', () => {
  it('is a single full page with no navigation', async () => {
    await seedSecrets(1, 'single');
    const page = await secrets.listSecrets(actor(), group('single'));

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.from).toBe(1);
    expect(page.to).toBe(1);
    expect(page.totalPages).toBe(1);
    expect(page.hasPrevious).toBe(false);
    expect(page.hasNext).toBe(false);
  });
});

describe('exactly one full page', () => {
  it('does not offer a next page for a boundary-sized result', async () => {
    // The off-by-one that produces an empty "page 2": with `total` an exact
    // multiple of `pageSize`, `Math.ceil` must not round up.
    await seedSecrets(5, 'exact');
    const page = await secrets.listSecrets(actor(), group('exact', { pageSize: 5 }));

    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(5);
    expect(page.totalPages).toBe(1);
    expect(page.hasNext).toBe(false);
    expect(page.to).toBe(5);
  });
});

describe('more than one page', () => {
  it('walks first, middle and last with no gap and no repeat', async () => {
    await seedSecrets(12, 'walk');
    const size = 5;

    const first = await secrets.listSecrets(actor(), group('walk', { pageSize: size, page: 1 }));
    const middle = await secrets.listSecrets(actor(), group('walk', { pageSize: size, page: 2 }));
    const last = await secrets.listSecrets(actor(), group('walk', { pageSize: size, page: 3 }));

    expect(first.total).toBe(12);
    expect(first.totalPages).toBe(3);

    expect(first.items).toHaveLength(5);
    expect(middle.items).toHaveLength(5);
    expect(last.items).toHaveLength(2);

    expect([first.from, first.to]).toEqual([1, 5]);
    expect([middle.from, middle.to]).toEqual([6, 10]);
    expect([last.from, last.to]).toEqual([11, 12]);

    expect([first.hasPrevious, first.hasNext]).toEqual([false, true]);
    expect([middle.hasPrevious, middle.hasNext]).toEqual([true, true]);
    expect([last.hasPrevious, last.hasNext]).toEqual([true, false]);

    // THE PROPERTY THAT MATTERS: every record appears exactly once across the
    // pages. A partial order would put one row on two pages and another on none.
    const walked = [...first.items, ...middle.items, ...last.items].map((s) => s.id);
    expect(new Set(walked).size).toBe(12);
  });
});

describe('a large dataset', () => {
  it('returns one page from a set comparable to the 853-record failure', async () => {
    // Not 853 rows created one at a time — that is minutes of encryption for no
    // extra signal. `createMany` writes the records directly; the property under
    // test is that the QUERY reads a page rather than the table, and it does not
    // care how the rows arrived. Versions are omitted deliberately: a record
    // with no active version must still paginate, and `maskedHint` is then null.
    const bulk = Array.from({ length: 900 }, (_, i) => ({
      ref: `${CATEGORY}/${TEST_SECRET_PROVIDER}/development/bulk-${String(i).padStart(4, '0')}`,
      name: `bulk-${String(i).padStart(4, '0')}`,
      category: CATEGORY,
      environment: ENV,
      status: 'ACTIVE' as const,
      createdByPlatformUserId: ownerId,
    }));
    await prisma.secretRecord.createMany({ data: bulk });

    const page = await secrets.listSecrets(actor(), scoped({ pageSize: 25, page: 1 }));

    expect(page.total).toBeGreaterThanOrEqual(900);
    // The whole point: one page, not nine hundred rows.
    expect(page.items).toHaveLength(25);
    expect(page.totalPages).toBe(Math.ceil(page.total / 25));

    const deep = await secrets.listSecrets(actor(), scoped({ pageSize: 25, page: 20 }));
    expect(deep.items).toHaveLength(25);
    expect(deep.page).toBe(20);
    expect(deep.from).toBe(476);
  });

  it('caps the page size without hiding anything', async () => {
    // A crafted URL cannot make one request materialise the whole table. The
    // cap is on the REQUEST; `total` still reports every match, so nothing is
    // silently withheld — which is the distinction F-53 turns on.
    const page = await secrets.listSecrets(actor(), scoped({ pageSize: 100_000 }));
    expect(page.pageSize).toBe(MAX_SECRET_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(MAX_SECRET_PAGE_SIZE);
    expect(page.total).toBeGreaterThanOrEqual(900);
  });

  it('falls back rather than throwing on a nonsensical page size', async () => {
    for (const size of [0, -5, Number.NaN]) {
      const page = await secrets.listSecrets(actor(), scoped({ pageSize: size }));
      expect(page.pageSize).toBe(DEFAULT_SECRET_PAGE_SIZE);
    }
  });
});

describe('out-of-range pages recover', () => {
  it('returns the last page and says which page that is', async () => {
    const size = 25;
    const total = (await secrets.listSecrets(actor(), scoped({ pageSize: size }))).total;
    const lastPage = Math.ceil(total / size);

    const beyond = await secrets.listSecrets(actor(), scoped({ pageSize: size, page: 99_999 }));

    // A stale bookmark shows something useful instead of an error or a blank
    // table, and the response reports the page it actually returned.
    expect(beyond.page).toBe(lastPage);
    expect(beyond.items.length).toBeGreaterThan(0);
    expect(beyond.hasNext).toBe(false);
  });

  it('clamps a zero or negative page to the first', async () => {
    for (const page of [0, -3]) {
      const result = await secrets.listSecrets(actor(), scoped({ page }));
      expect(result.page).toBe(1);
      expect(result.hasPrevious).toBe(false);
    }
  });
});

describe('deterministic ordering', () => {
  it('is stable across repeated identical queries', async () => {
    const a = await secrets.listSecrets(actor(), scoped({ pageSize: 10, page: 3 }));
    const b = await secrets.listSecrets(actor(), scoped({ pageSize: 10, page: 3 }));
    expect(a.items.map((s) => s.id)).toEqual(b.items.map((s) => s.id));
  });

  it('is total even when name and category collide', async () => {
    // The tie-breaker's reason for existing. Ten records agreeing on category
    // AND name — a partial order leaves their relative position undefined, so
    // page boundaries could shift between the count and the fetch.
    const collidingName = 'identical-name';
    await prisma.secretRecord.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        ref: `${CATEGORY}/${TEST_SECRET_PROVIDER}/development/tie-${i}`,
        name: collidingName,
        category: CATEGORY,
        environment: ENV,
        status: 'ACTIVE' as const,
        createdByPlatformUserId: ownerId,
      })),
    });

    const scopedTies = group('tie');
    const first = await secrets.listSecrets(actor(), { ...scopedTies, pageSize: 4, page: 1 });
    const second = await secrets.listSecrets(actor(), { ...scopedTies, pageSize: 4, page: 2 });
    const third = await secrets.listSecrets(actor(), { ...scopedTies, pageSize: 4, page: 3 });

    const all = [...first.items, ...second.items, ...third.items].map((s) => s.id);
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);

    // And repeating the walk gives the same partition, not merely the same set.
    const again = await secrets.listSecrets(actor(), { ...scopedTies, pageSize: 4, page: 2 });
    expect(again.items.map((s) => s.id)).toEqual(second.items.map((s) => s.id));
  });
});

describe('search and filter happen on the server', () => {
  it('narrows the total, not just the page', async () => {
    // If the filter ran after fetching, `total` would still be the unfiltered
    // count and "showing 1–3 of 900" would be a lie.
    const all = await secrets.listSecrets(actor(), scoped());
    const narrowed = await secrets.listSecrets(actor(), group('walk'));

    expect(narrowed.total).toBe(12);
    expect(narrowed.total).toBeLessThan(all.total);
    expect(narrowed.items.every((s) => s.ref.includes('walk-'))).toBe(true);
  });

  it('matches the name as well as the ref, case-insensitively', async () => {
    const byName = await secrets.listSecrets(actor(), {
      environment: ENV,
      search: 'SINGLE-0000',
    });
    expect(byName.total).toBeGreaterThanOrEqual(1);
    expect(byName.items.some((s) => s.name === 'single-0000')).toBe(true);
  });

  it('paginates the filtered set', async () => {
    const filtered = await secrets.listSecrets(actor(), group('walk', { pageSize: 5, page: 2 }));
    expect(filtered.total).toBe(12);
    expect(filtered.items).toHaveLength(5);
    expect([filtered.from, filtered.to]).toEqual([6, 10]);
  });

  it('a filter matching nothing is an empty page, not an error', async () => {
    const none = await secrets.listSecrets(actor(), {
      environment: ENV,
      search: 'no-secret-has-this-in-its-name-or-ref',
    });
    expect(none.total).toBe(0);
    expect(none.items).toEqual([]);
    expect(none.page).toBe(1);
  });

  it('a category filter and a search compose', async () => {
    const composed = await secrets.listSecrets(actor(), group('walk', { category: CATEGORY }));
    expect(composed.total).toBe(12);

    const wrongCategory = await secrets.listSecrets(actor(), {
      environment: ENV,
      category: 'email_provider',
      search: TEST_SECRET_PROVIDER,
    });
    expect(wrongCategory.total).toBe(0);
  });
});

describe('the count matches the rows', () => {
  it('countSecrets agrees with listSecrets over the same filter', async () => {
    // They are two queries and must not drift: a total computed over a
    // different predicate than the fetch makes "showing 1–25 of N" wrong.
    const query = group('walk');
    const listed = await secrets.listSecrets(actor(), query);
    const counted = await secrets.countSecrets(actor(), query);
    expect(counted).toBe(listed.total);
  });
});

describe('a page carries masked metadata and nothing else', () => {
  it('never contains a value, ciphertext or key material', async () => {
    // The `walk-` group, because those went through `createSecret` and so have
    // an active version. The bulk rows deliberately have none — a record with
    // no version must still paginate — and picking the wrong group here would
    // assert on a null mask rather than a real one.
    const page = await secrets.listSecrets(actor(), group('walk', { pageSize: 50 }));
    const serialised = JSON.stringify(page);

    // The fixture values all share this prefix.
    expect(serialised).not.toContain('sk-fixture-');
    // Nor any column that holds encrypted material.
    for (const forbidden of [
      'ciphertext',
      'cipherText',
      'nonce',
      'authTag',
      'keyId',
      'wrappedKey',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    // What it DOES carry is the mask and the fingerprint.
    const withVersion = page.items.find((s) => s.maskedHint !== null);
    expect(withVersion?.maskedHint).toMatch(/^….{4}$/u);
    expect(withVersion?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('RBAC is enforced in the service, not only the page', () => {
  it('refuses an actor without platform.secret.read', async () => {
    const bare = {
      platformUserId: ownerId,
      roleKey: 'support_agent',
      mfaVerified: true,
      permissionKeys: ['platform.workspace.read'],
    };
    await expect(secrets.listSecrets(bare, scoped())).rejects.toThrow(/platform\.secret\.read/);
    await expect(secrets.countSecrets(bare, scoped())).rejects.toThrow(/platform\.secret\.read/);
  });

  it('refuses an actor whose MFA is not verified', async () => {
    const noMfa = { ...actor(), mfaVerified: false };
    await expect(secrets.listSecrets(noMfa, scoped())).rejects.toThrow();
    await expect(secrets.countSecrets(noMfa, scoped())).rejects.toThrow();
  });
});
