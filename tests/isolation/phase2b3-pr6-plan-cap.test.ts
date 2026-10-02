import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTOMATION_AI_ACTIONS_FEATURE,
  EntitlementService,
  type CatalogueSource,
} from '@brandspace/entitlements';

/**
 * PHASE 2B-3 PR 6 — THE AI AUTOMATION CAP THROUGH `EntitlementService`, AGAINST
 * A REAL DATABASE.
 *
 * What needs the database: the subscription status that decides whether the
 * trial value applies, and that `can()`, `limit()` and `resolveAll()` agree.
 * Every plan here is a FIXTURE; the owner enters the real values (D-458).
 */

let platform: PrismaClient;
let entitlements: EntitlementService;

class StubCatalogue implements CatalogueSource {
  readonly documents: Record<string, Record<string, unknown>> = {
    entitlements: { features: [], planEntitlements: [] },
    'feature-flags': { flags: [] },
    plans: {
      plans: [
        {
          key: 'pr6-capped',
          status: 'active',
          quotas: {
            seats: 2,
            automationAiActionsPerMonth: { kind: 'limited', value: 4 },
            trialAutomationAiActionsPerMonth: { kind: 'limited', value: 2 },
          },
        },
        {
          key: 'pr6-no-trial-cap',
          status: 'active',
          quotas: { automationAiActionsPerMonth: { kind: 'unlimited' } },
        },
        { key: 'pr6-not-set', status: 'active', quotas: { seats: 2 } },
      ],
    },
  };

  async load(domain: string): Promise<Record<string, unknown>> {
    return this.documents[domain] ?? {};
  }

  async versionId(): Promise<string | null> {
    return null;
  }
}

async function workspaceOn(
  planKey: string | null,
  subscription: 'TRIALING' | 'ACTIVE' | 'EXPIRED' | null,
): Promise<string> {
  const id = randomUUID();
  const user = await platform.user.create({
    data: { email: `pr6-cap-${id}@example.local`, name: 'Cap', status: 'ACTIVE', timezone: 'UTC' },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `pr6-cap-${id.slice(0, 12)}`,
      name: 'PR 6 cap fixture',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'SA',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      planKey,
    },
  });
  if (subscription && planKey) {
    await platform.workspaceSubscription.create({
      data: {
        workspaceId: id,
        planKey,
        status: subscription,
        currency: 'USD',
        pinnedMonthlyMinor: 0,
        pinnedAnnualMinor: 0,
        currentPeriodStart: new Date('2026-10-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
  }
  return id;
}

beforeAll(async () => {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  platform = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  entitlements = new EntitlementService({
    prisma: platform,
    catalogueSource: new StubCatalogue(),
    environment: 'DEVELOPMENT',
    cacheTtlMs: 0,
  });
}, 60_000);

afterAll(async () => {
  await platform.$disconnect();
});

const answer = async (workspaceId: string) => ({
  can: await entitlements.can(workspaceId, AUTOMATION_AI_ACTIONS_FEATURE),
  limit: await entitlements.limit(workspaceId, AUTOMATION_AI_ACTIONS_FEATURE),
  all: (await entitlements.resolveAll(workspaceId)).decisions.find(
    (decision) => decision.featureKey === AUTOMATION_AI_ACTIONS_FEATURE,
  ),
});

describe('limit.automation_ai_actions through EntitlementService', () => {
  it('ACTIVE on a capped plan: the plan value', async () => {
    const result = await answer(await workspaceOn('pr6-capped', 'ACTIVE'));
    expect(result).toMatchObject({ can: true, limit: 4, all: { enabled: true, limitValue: 4 } });
  });

  it('TRIALING on the same plan: the trial value, everywhere', async () => {
    const result = await answer(await workspaceOn('pr6-capped', 'TRIALING'));
    expect(result).toMatchObject({ can: true, limit: 2, all: { enabled: true, limitValue: 2 } });
  });

  it('TRIALING on a plan with no trial value: off', async () => {
    const result = await answer(await workspaceOn('pr6-no-trial-cap', 'TRIALING'));
    expect(result).toMatchObject({ can: false, limit: 0, all: { enabled: false } });
  });

  it('ACTIVE and unlimited: enabled, no limit', async () => {
    const result = await answer(await workspaceOn('pr6-no-trial-cap', 'ACTIVE'));
    expect(result).toMatchObject({ can: true, limit: null });
  });

  it('a plan that does not set it, no plan, and an ended plan: off', async () => {
    for (const workspaceId of [
      await workspaceOn('pr6-not-set', 'ACTIVE'),
      await workspaceOn(null, null),
      await workspaceOn('pr6-capped', 'EXPIRED'),
    ]) {
      expect(await answer(workspaceId)).toMatchObject({ can: false, limit: 0 });
    }
  });
});
