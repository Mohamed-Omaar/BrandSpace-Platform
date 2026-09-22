import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import {
  QUOTA_FEATURES,
  TOTAL_RESOURCE_DIMENSIONS,
  createTotalResourceQuota,
} from '@brandspace/entitlements';
import { appRoleClient, ensurePlatformRole, platformRoleClient } from './fixtures';

/**
 * A TOTAL QUOTA COUNTS WHAT EXISTS, NOT WHAT IT WAS TOLD ABOUT.
 *
 * A usage counter records what has been consumed THROUGH it. The things a
 * `total` dimension counts — brands, connected accounts — predate the day their
 * dimension was wired up, so the counter starts at zero over a population that
 * does not. A workspace holding four of something under a limit of five was
 * admitted four more, and two concurrent creates could take the same last slot
 * because the counter neither of them had ever known about the other four.
 *
 * THE BRAND DIMENSION IS ASSERTED HERE RATHER THAN THROUGH THE PRODUCT because
 * the product has exactly one brand-creation path and it is reachable only
 * while the workspace has NO brand (D-243): "historical brands already fill the
 * ceiling" cannot be reached from a screen that only exists when there are
 * none. The end-to-end suite covers the call site; this covers the rule the
 * call site applies, built the way the call site builds it.
 */

let platform: PrismaClient;
let app: PrismaClient;
let ownerId: string;
const RUN = crypto.randomUUID().slice(0, 8);
const created: string[] = [];

async function freshWorkspace(): Promise<string> {
  const id = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `p3q-${id}@example.local`,
      name: 'Baseline Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p3q-${id.slice(0, 12)}`,
      name: 'Baseline Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      currency: 'SAR',
      defaultLocale: 'EN',
      timezone: 'UTC',
      planKey: null,
    },
  });
  created.push(id);
  return id;
}

/**
 * Brands written STRAIGHT INTO THE TABLE, which is what "historical" means.
 *
 * Not through the action — the whole point is that nothing told the counter.
 */
async function historicalBrands(workspaceId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await platform.brand.create({
      data: {
        workspaceId,
        slug: `historical-${RUN}-${index}-${crypto.randomUUID().slice(0, 6)}`,
        name: `Historical Brand ${index + 1}`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN'],
      },
    });
  }
}

/** The ceiling, set the way an operator sets one. */
async function setCeiling(workspaceId: string, limitValue: number | null): Promise<void> {
  await platform.workspaceOverride.deleteMany({
    where: { workspaceId, featureKey: QUOTA_FEATURES.brands },
  });
  await platform.workspaceOverride.create({
    data: {
      workspaceId,
      featureKey: QUOTA_FEATURES.brands,
      enabled: true,
      limitValue,
      reason: 'Phase 3 fixture: an explicit brand ceiling.',
      grantedByPlatformUserId: ownerId,
    },
  });
}

/** Take one brand slot exactly as `createBrandAction` does. */
async function takeBrandSlot(workspaceId: string, key: string): Promise<boolean> {
  return withWorkspace(
    workspaceId,
    async (db) =>
      createTotalResourceQuota({
        db,
        workspaceId,
        environment: 'DEVELOPMENT',
        dimension: 'brands',
      }).consume(key),
    { prisma: app },
  );
}

async function counted(workspaceId: string): Promise<number> {
  const row = await platform.usageCounter.findFirst({
    where: { workspaceId, featureKey: QUOTA_FEATURES.brands },
  });
  return row?.usedValue ?? 0;
}

beforeAll(async () => {
  platform = platformRoleClient();
  app = appRoleClient();
  const roleId = await ensurePlatformRole(platform);
  const owner = await platform.platformUser.create({
    data: {
      email: `p3q-owner-${RUN}@brandspace.local`,
      name: 'Baseline Owner',
      status: 'ACTIVE',
      roleId,
    },
  });
  ownerId = owner.id;
}, 60_000);

afterAll(async () => {
  if (created.length > 0) {
    await platform.workspace.deleteMany({ where: { id: { in: created } } }).catch(() => undefined);
  }
  await platform.$disconnect().catch(() => undefined);
  await app.$disconnect().catch(() => undefined);
});

describe('brands that already exist fill the plan ceiling', () => {
  it('E — HISTORICAL BRANDS ARE COUNTED, so the next one is the fourth and not the first', async () => {
    const workspaceId = await freshWorkspace();
    await historicalBrands(workspaceId, 3);
    await setCeiling(workspaceId, 5);
    expect(await counted(workspaceId)).toBe(0);

    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-a`)).toBe(true);

    // FOUR. The three that were already there plus the one just taken — not
    // one, which is all the counter had ever been told about.
    expect(await counted(workspaceId)).toBe(4);
  });

  it('F — THE NEXT BRAND IS REFUSED WHEN HISTORY ALREADY FILLS THE CEILING', async () => {
    const workspaceId = await freshWorkspace();
    await historicalBrands(workspaceId, 3);
    await setCeiling(workspaceId, 3);

    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-b`)).toBe(false);
    // Refused, and nothing was recorded as consumed by the attempt.
    expect(await counted(workspaceId)).toBe(0);

    // Raising the ceiling admits exactly one more, and the counter then states
    // the truth about the workspace rather than the history of this counter.
    await setCeiling(workspaceId, 4);
    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-c`)).toBe(true);
    expect(await counted(workspaceId)).toBe(4);
  });

  it('D — REPEATING IT DOES NOT DOUBLE-COUNT', async () => {
    const workspaceId = await freshWorkspace();
    await historicalBrands(workspaceId, 2);
    await setCeiling(workspaceId, null);

    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-d1`)).toBe(true);
    expect(await counted(workspaceId)).toBe(3);

    // A SECOND slot, with the counter now at 3 and the live population still 2:
    // the greater of the two is one of them, never their sum.
    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-d2`)).toBe(true);
    expect(await counted(workspaceId)).toBe(4);

    // And the SAME request replayed consumes nothing further.
    expect(await takeBrandSlot(workspaceId, `brand-${RUN}-d2`)).toBe(true);
    expect(await counted(workspaceId)).toBe(4);
  });

  it('TWO CONCURRENT CREATES AT THE LAST HISTORICAL SLOT: exactly one is admitted', async () => {
    const workspaceId = await freshWorkspace();
    await historicalBrands(workspaceId, 4);
    await setCeiling(workspaceId, 5);

    /*
     * BOTH START WITH A COUNTER OF ZERO AND FOUR ROWS ALREADY THERE. Without
     * the baseline each would have seen 0 then 1 against a limit of 5 and both
     * would have been admitted, leaving six brands under a ceiling of five.
     * The counter row's lock is what serialises them, and the live count taken
     * behind it is what the second one loses to.
     */
    const outcomes = await Promise.all([
      takeBrandSlot(workspaceId, `brand-${RUN}-race-1`),
      takeBrandSlot(workspaceId, `brand-${RUN}-race-2`),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await counted(workspaceId)).toBe(5);
  });

  it('the live predicate ignores a soft-deleted brand', async () => {
    const workspaceId = await freshWorkspace();
    await historicalBrands(workspaceId, 2);
    const doomed = await platform.brand.findFirstOrThrow({
      where: { workspaceId },
      select: { id: true },
    });
    await platform.brand.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });

    const live = await withWorkspace(
      workspaceId,
      async (db) => TOTAL_RESOURCE_DIMENSIONS.brands.live(db, workspaceId),
      { prisma: app },
    );
    expect(live).toBe(1);
  });
});
