import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EntitlementService,
  QuotaExceededError,
  TOTAL_RESOURCE_DIMENSIONS,
  UsageService,
  type CatalogueSource,
} from '@brandspace/entitlements';
import type { TenantScopedClient } from '@brandspace/database';

/**
 * PHASE 6 · P6-03b — THE FOUR CASES THE OWNER REQUIRED, AGAINST REAL POSTGRESQL.
 *
 * The staging blocker was that a newly created workspace could not create its
 * FIRST brand: it was refused with "This workspace has reached a limit on its
 * plan" on a workspace that had no plan. Root cause and chain are in
 * docs/CURRENT-EXECUTION-PHASE-6.md §4.3; the pure-engine regression is
 * tests/unit/phase6-quota-default.test.ts.
 *
 * WHY THIS FILE ALSO EXISTS, given the unit test. The unit test pins the
 * precedence RULE. What it cannot show is the rule composed with the things
 * that only a database has: the plan-quota projection materialised from a plan
 * document, the usage counter row and its lock, the live population of brands
 * that already exist, and the idempotency key that makes a double submit take
 * one slot rather than two. The blocker lived in the composition, so the proof
 * has to be of the composition.
 *
 * NO ALLOWANCE IS HARD-CODED BY THE FIX OR BY THIS FILE. Every number below is
 * a FIXTURE plan written by the test, standing in for configuration an owner
 * enters from Platform Admin. Case 1 is the only one that reaches a default at
 * all, and what it asserts is that an ABSENT ceiling is absent — not that some
 * particular number was invented for it.
 */

let platform: PrismaClient;
let entitlements: EntitlementService;
let usage: UsageService;

/** A catalogue the test controls directly, standing in for activated config. */
class StubCatalogue implements CatalogueSource {
  #documents: Record<string, Record<string, unknown>> = {
    entitlements: {},
    plans: {},
    'feature-flags': {},
  };

  set(domain: string, document: Record<string, unknown>): void {
    this.#documents[domain] = document;
  }

  async load(domain: string): Promise<Record<string, unknown>> {
    return this.#documents[domain] ?? {};
  }

  readonly versionIds: Record<string, string> = {
    entitlements: '44444444-4444-4444-8444-444444444444',
    plans: '55555555-5555-4555-8555-555555555555',
    'feature-flags': '66666666-6666-4666-8666-666666666666',
  };

  async versionId(domain: string): Promise<string | null> {
    return this.versionIds[domain] ?? null;
  }
}

/**
 * Two fixture plans that differ ONLY in their brand ceiling.
 *
 * `brands: 0` and `brands: 1` are the two the owner named. They are projected
 * into `limit.brands` by the plan-quota projection, which is the path a real
 * plan takes — so cases 2 and 3 are decided at the PLAN rung, above the default
 * the fix touched, and prove the fix did not reach them.
 */
const PLANS = [
  {
    key: 'p6-no-brands',
    name: { ar: 'ص', en: 'No brands' },
    description: { ar: 'و', en: 'd' },
    tier: 1,
    status: 'active',
    visibility: 'public',
    prices: [{ currency: 'USD', monthlyMinor: 100, annualMinor: 1000 }],
    monthlyCredits: 0,
    trialDays: 0,
    trialCredits: 0,
    quotas: { brands: 0 },
    creditRollover: { policy: 'capped', capMultiplier: 1 },
    downgradeBehavior: {
      timing: 'period_end',
      excessResources: 'read_only',
      excessCredits: 'retain_until_expiry',
    },
    sortOrder: 1,
  },
  {
    key: 'p6-one-brand',
    name: { ar: 'ص', en: 'One brand' },
    description: { ar: 'و', en: 'd' },
    tier: 2,
    status: 'active',
    visibility: 'public',
    prices: [{ currency: 'USD', monthlyMinor: 200, annualMinor: 2000 }],
    monthlyCredits: 0,
    trialDays: 0,
    trialCredits: 0,
    quotas: { brands: 1 },
    creditRollover: { policy: 'capped', capMultiplier: 1 },
    downgradeBehavior: {
      timing: 'period_end',
      excessResources: 'read_only',
      excessCredits: 'retain_until_expiry',
    },
    sortOrder: 2,
  },
];

async function freshWorkspace(planKey: string | null): Promise<string> {
  const run = crypto.randomUUID();
  const user = await platform.user.create({
    data: {
      email: `p6q-${run}@example.local`,
      name: 'Brand Quota Fixture',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
  });
  const workspace = await platform.workspace.create({
    data: {
      id: run,
      workspaceId: run,
      slug: `p6q-${run.slice(0, 12)}`,
      name: 'Brand Quota Fixture Workspace',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      planKey,
    },
  });
  return workspace.id;
}

/**
 * Creating a brand exactly as the product does.
 *
 * The same order, the same idempotency key and the same live population as
 * `apps/dashboard/src/app/[locale]/brand-brain/actions.ts`: consume the slot
 * first, and only then write the row — so a refusal leaves no brand behind and
 * a failed write takes its consumption with it.
 *
 * `baselineCount` is the DECLARED predicate from `TOTAL_RESOURCE_DIMENSIONS`,
 * not a `where` clause re-typed here. A test that wrote its own would be
 * measuring its own opinion of what occupies a slot.
 */
async function createBrand(workspaceId: string, name: string): Promise<void> {
  await usage.consume({
    workspaceId,
    featureKey: 'limit.brands',
    limitValue: await entitlements.limit(workspaceId, 'limit.brands'),
    period: 'total',
    idempotencyKey: `brand:${workspaceId}:${name.toLowerCase()}`,
    baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
  });
  await platform.brand.create({
    data: {
      workspaceId,
      name,
      slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
    },
  });
}

function liveBrands(workspaceId: string): Promise<number> {
  return TOTAL_RESOURCE_DIMENSIONS.brands.live(
    platform as unknown as TenantScopedClient,
    workspaceId,
  );
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const catalogue = new StubCatalogue();
  /*
   * DELIBERATELY EMPTY. `limit.brands` is declared by NOTHING here — no feature
   * definition, no plan entitlement — which is exactly the staging condition:
   * an environment with no configured customer plans. The key still resolves
   * because the bootstrap quota projection supplies the DEFINITION (so the
   * engine's typo guard has something to recognise) while leaving every NUMBER
   * to configuration, per CLAUDE.md §2.2.
   */
  catalogue.set('entitlements', { features: [], planEntitlements: [] });
  catalogue.set('plans', { plans: PLANS });
  catalogue.set('feature-flags', { flags: [] });

  entitlements = new EntitlementService({
    prisma: platform,
    catalogueSource: catalogue,
    environment: 'DEVELOPMENT',
  });
  usage = new UsageService({ prisma: platform });
}, 60_000);

afterAll(async () => {
  await platform?.$disconnect();
});

describe('P6-03b case 1 · a workspace with no applicable plan', () => {
  it('resolves limit.brands as no ceiling rather than a ceiling of zero', async () => {
    const workspaceId = await freshWorkspace(null);
    // THE REGRESSION, at the layer the product asks. Before the fix this was 0.
    expect(await entitlements.limit(workspaceId, 'limit.brands')).toBeNull();
  });

  it('is NOT refused its first brand', async () => {
    // The blocker itself: a workspace nobody could onboard.
    const workspaceId = await freshWorkspace(null);
    await expect(createBrand(workspaceId, 'Northwind')).resolves.toBeUndefined();
    expect(await liveBrands(workspaceId)).toBe(1);
  });

  it('is not refused its second either — an absent ceiling is absent, not one', async () => {
    // Stated precisely so the assertion cannot be mistaken for "the default is
    // 1". There is no default. The ceiling arrives when configuration states
    // one, and until then nothing constrains the dimension.
    const workspaceId = await freshWorkspace(null);
    await createBrand(workspaceId, 'Northwind');
    await expect(createBrand(workspaceId, 'Southwind')).resolves.toBeUndefined();
    expect(await liveBrands(workspaceId)).toBe(2);
  });
});

describe('P6-03b case 2 · a plan stating brands = 0', () => {
  it('refuses the first brand', async () => {
    const workspaceId = await freshWorkspace('p6-no-brands');
    expect(await entitlements.limit(workspaceId, 'limit.brands')).toBe(0);
    await expect(createBrand(workspaceId, 'Northwind')).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('leaves no brand behind when it refuses', async () => {
    // The refusal happens BEFORE the row is written, so a refused request is
    // not a half-made brand.
    const workspaceId = await freshWorkspace('p6-no-brands');
    await expect(createBrand(workspaceId, 'Northwind')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await liveBrands(workspaceId)).toBe(0);
  });
});

describe('P6-03b case 3 · a plan stating brands = 1', () => {
  it('admits the first and refuses the second', async () => {
    const workspaceId = await freshWorkspace('p6-one-brand');
    expect(await entitlements.limit(workspaceId, 'limit.brands')).toBe(1);

    await expect(createBrand(workspaceId, 'Northwind')).resolves.toBeUndefined();
    await expect(createBrand(workspaceId, 'Southwind')).rejects.toBeInstanceOf(QuotaExceededError);

    expect(await liveBrands(workspaceId)).toBe(1);
  });

  it('counts brands that already existed, not only the ones it consumed', async () => {
    // A ceiling of 1 on a workspace that ALREADY has a brand admits none. The
    // live population is what makes the plan ceiling and the table agree; a
    // counter starting at zero would have handed out a free slot.
    const workspaceId = await freshWorkspace('p6-one-brand');
    await platform.brand.create({
      data: { workspaceId, name: 'Pre-existing', slug: `pre-${workspaceId.slice(0, 8)}` },
    });

    await expect(createBrand(workspaceId, 'Northwind')).rejects.toBeInstanceOf(QuotaExceededError);
    expect(await liveBrands(workspaceId)).toBe(1);
  });
});

describe('P6-03b case 4 · a replayed submit consumes no second slot', () => {
  it('is idempotent on the brand identity, under a ceiling of 1', async () => {
    const workspaceId = await freshWorkspace('p6-one-brand');

    // The same normalised name is the same request typed twice, not two
    // brands — so the second consume returns the state the first left and does
    // NOT refuse, even though the ceiling is already met.
    await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: await entitlements.limit(workspaceId, 'limit.brands'),
      period: 'total',
      idempotencyKey: `brand:${workspaceId}:northwind`,
      baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
    });
    const replay = await usage.consume({
      workspaceId,
      featureKey: 'limit.brands',
      limitValue: await entitlements.limit(workspaceId, 'limit.brands'),
      period: 'total',
      idempotencyKey: `brand:${workspaceId}:northwind`,
      baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
    });

    expect(replay.used).toBe(1);
  });

  it('two simultaneous submits of the SAME brand take one slot between them', async () => {
    // Two clicks, genuinely concurrent. A read-then-write implementation passes
    // the sequential case above and fails this one.
    const workspaceId = await freshWorkspace('p6-one-brand');
    const limitValue = await entitlements.limit(workspaceId, 'limit.brands');
    const submit = (): Promise<unknown> =>
      usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue,
        period: 'total',
        idempotencyKey: `brand:${workspaceId}:northwind`,
        baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
      });

    const results = await Promise.allSettled([submit(), submit()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

    const counter = await platform.usageCounter.findFirst({
      where: { workspaceId, featureKey: 'limit.brands' },
    });
    expect(counter?.usedValue).toBe(1);
  });

  it('two simultaneous submits of DIFFERENT brands cannot both pass a ceiling of 1', async () => {
    // The other half of the same property: idempotency must not become a way
    // around the ceiling for two genuinely different requests.
    const workspaceId = await freshWorkspace('p6-one-brand');
    const limitValue = await entitlements.limit(workspaceId, 'limit.brands');
    const submit = (name: string): Promise<unknown> =>
      usage.consume({
        workspaceId,
        featureKey: 'limit.brands',
        limitValue,
        period: 'total',
        idempotencyKey: `brand:${workspaceId}:${name}`,
        baselineCount: (scoped) => TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, workspaceId),
      });

    const results = await Promise.allSettled([submit('northwind'), submit('southwind')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
