import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { notifyLearningReviewers } from '@brandspace/intelligence';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 6 · P6-11 — PULSE READS SIX MORE KINDS OF TENANT DATA, ON THE SCREEN
 * EVERY MEMBER LANDS ON.
 *
 * Learnings awaiting review, unseen findings, expiring connections, empty
 * campaigns, idle calendars and the credit forecast. Each is a count, and a
 * count is a disclosure: "3 learnings are waiting" says three exist, and a
 * wrong tenant predicate says it about somebody else's brand. CLAUDE.md §2.1
 * counts enumeration and inference as leaks.
 *
 * EACH SOURCE IS PINNED FOUR WAYS:
 *
 *   1. ANOTHER WORKSPACE'S ROWS NEVER MOVE THIS WORKSPACE'S COUNT — proven
 *      twice, once under the application role inside `withWorkspace` (RLS on)
 *      and once through the platform pool, which RLS does not narrow, so the
 *      application predicate is shown to hold on its own (the two independent
 *      layers of §2.1);
 *   2. BRAND SCOPE IS HONOURED, so a member restricted to one brand is not told
 *      about another;
 *   3. A MEMBER WITHOUT THE PERMISSION GETS NO ITEM AT ALL — the source does
 *      not run, so Home never links to a route that answers 404;
 *   4. THE ITEM EXISTS ONLY WHEN THE CONDITION IS TRUE.
 *
 * And the learning-review notification is pinned for the same boundary: it
 * reaches reviewers of THIS brand in THIS workspace, once per batch.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;
let reviewerOfOtherBrandOnly: string;

const NOW = new Date();
const DAY = 86_400_000;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ALL_PERMISSIONS = [
  'content.read',
  'integrations.read',
  'brand_brain.read',
  'brand_brain.review',
  'strategy.read',
  'campaigns.read',
  'credits.read',
  'billing.read',
];

function sessionA(overrides: Partial<CustomerWorkspaceContext> = {}): CustomerWorkspaceContext {
  return {
    workspaceId: fixtures.a.workspaceId,
    workspaceName: 'A',
    workspaceSlug: 'a',
    workspaceStatus: 'ACTIVE',
    roleKey: 'workspace_owner',
    roleNameEn: 'Owner',
    roleNameAr: 'مالك',
    permissionKeys: ALL_PERMISSIONS,
    brandScope: [],
    ...overrides,
  };
}

/** The count Pulse reports for `kind`, via the RLS-bound application role. */
async function countA(kind: string, session = sessionA()): Promise<number> {
  const items = await inA((db) => attentionItems(db, session));
  return items.find((item) => item.kind === kind)?.count ?? 0;
}

/** The same, through the platform pool — the APPLICATION predicate alone. */
async function countAUnbounded(kind: string, session = sessionA()): Promise<number> {
  const items = await attentionItems(platform as unknown as TenantScopedClient, session);
  return items.find((item) => item.kind === kind)?.count ?? 0;
}

async function expectBothLayers(kind: string, expected: number, session = sessionA()) {
  expect(await countA(kind, session)).toBe(expected);
  expect(await countAUnbounded(kind, session)).toBe(expected);
}

async function insightIn(
  run: typeof inA,
  workspaceId: string,
  brandId: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return run(async (db) => {
    const insight = await db.insight.create({
      data: {
        workspaceId,
        brandId,
        type: 'ANALYTICS_EXPLANATION',
        status: 'NEW',
        basis: 'OWN_PERFORMANCE',
        title: { ar: 'شرح', en: 'An explanation' },
        body: {},
        periodStart: new Date(NOW.getTime() - 28 * DAY),
        periodEnd: NOW,
        generatedByUserId: userId,
        idempotencyKey: `pulse-${randomUUID()}`,
        ...overrides,
      },
    });
    return insight.id;
  });
}

async function learningIn(
  run: typeof inA,
  workspaceId: string,
  brandId: string,
  userId: string,
): Promise<string> {
  const insightId = await insightIn(run, workspaceId, brandId, userId, { status: 'ACCEPTED' });
  return run(async (db) => {
    const candidate = await db.brandKnowledgeCandidate.create({
      data: {
        workspaceId,
        brandId,
        sourceKind: 'ANALYTICS',
        insightId,
        area: 'LEARNINGS',
        itemKey: `learning.${randomUUID().slice(0, 8)}`,
        extractedTitle: { en: 'A learning', ar: 'درس' },
        extractedBody: { en: 'Body', ar: 'نص' },
        confidenceMilli: 400,
        evidence: {},
        status: 'PENDING',
      },
    });
    return candidate.id;
  });
}

async function connectionIn(
  run: typeof inA,
  workspaceId: string,
  brandId: string,
  tokenExpiresAt: Date | null,
): Promise<string> {
  return run(async (db) => {
    const row = await db.socialConnection.create({
      data: {
        workspaceId,
        brandId,
        provider: 'INSTAGRAM',
        externalAccountId: `ext-${randomUUID()}`,
        displayName: 'Pulse fixture',
        targetKind: 'PROFILE',
        status: 'ACTIVE',
        connectedAt: NOW,
        tokenExpiresAt,
      },
    });
    return row.id;
  });
}

async function campaignIn(
  run: typeof inA,
  workspaceId: string,
  brandId: string,
  name = 'Pulse campaign',
): Promise<string> {
  return run(async (db) => {
    const campaign = await db.campaign.create({
      data: { workspaceId, brandId, name, objective: 'AWARENESS', status: 'ACTIVE' },
    });
    return campaign.id;
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  otherBrandId = await inA(async (db) => {
    const brand = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: 'Pulse other brand',
        slug: `pulse-other-${randomUUID().slice(0, 8)}`,
      },
    });
    return brand.id;
  });

  /*
   * A SECOND MEMBER OF WORKSPACE A, restricted to the OTHER brand, holding the
   * owner's role so they differ in BrandScope and nothing else. The user row is
   * workspace B's, because the app role may not write `user` — one person in two
   * workspaces is ordinary in this product.
   */
  reviewerOfOtherBrandOnly = await inA(async (db) => {
    const owner = await db.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
      select: { roleId: true },
    });
    const membership = await db.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.b.userId,
        roleId: owner.roleId,
        status: 'ACTIVE',
        brandScope: [otherBrandId],
        invitedByUserId: fixtures.a.userId,
      },
    });
    return membership.userId;
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('P6-11 · a brand-scoped member still gets a Command Center', () => {
  it('every source runs for a member restricted to one brand — none fails and takes the rest down', async () => {
    /*
     * THE DEFECT THIS PINS. `brandsWithNoKnowledge` filtered the BRAND table
     * with the CHILD-row helper (`brandId`), which the brand table does not
     * have. For any member with a non-empty BrandScope the query failed
     * validation, and because the sources are dispatched together the failure
     * rejected every other source too — Home told a scoped member that nothing
     * was waiting, whatever was. The fixture brand has a pending candidate, an
     * unseen finding, an expiring connection and an empty campaign by the time
     * the suites below have run; this test seeds its own so it stands alone.
     */
    const brand = await inA(async (db) => {
      const created = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          name: 'Scoped member brand',
          slug: `scoped-${randomUUID().slice(0, 8)}`,
        },
      });
      return created.id;
    });
    await learningIn(inA, fixtures.a.workspaceId, brand, fixtures.a.userId);
    await campaignIn(inA, fixtures.a.workspaceId, brand, 'Scoped campaign');

    const scoped = sessionA({ brandScope: [brand] });
    const items = await inA((db) => attentionItems(db, scoped));
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain('learnings-pending');
    expect(kinds).toContain('campaign-empty');
    // The brand has no knowledge: the source that used to throw now answers.
    expect(kinds).toContain('brand-brain-empty');
    expect(items.find((item) => item.kind === 'brand-brain-empty')?.detail).toBe(
      'Scoped member brand',
    );
  });
});

describe('P6-11 · learnings waiting for review', () => {
  it('counts this workspace’s pending candidates and never another’s', async () => {
    const before = await countA('learnings-pending');
    await learningIn(inB, fixtures.b.workspaceId, fixtures.b.brandId, fixtures.b.userId);
    await learningIn(inB, fixtures.b.workspaceId, fixtures.b.brandId, fixtures.b.userId);
    await expectBothLayers('learnings-pending', before);

    await learningIn(inA, fixtures.a.workspaceId, fixtures.a.brandId, fixtures.a.userId);
    await expectBothLayers('learnings-pending', before + 1);
  });

  it('honours brand scope', async () => {
    const scoped = sessionA({ brandScope: [fixtures.a.brandId] });
    const before = await countA('learnings-pending', scoped);
    const unrestrictedBefore = await countA('learnings-pending');
    await learningIn(inA, fixtures.a.workspaceId, otherBrandId, fixtures.a.userId);
    expect(await countA('learnings-pending', scoped)).toBe(before);
    expect(await countA('learnings-pending')).toBe(unrestrictedBefore + 1);
  });

  it('is not run for a member who cannot review', async () => {
    const readOnly = sessionA({
      permissionKeys: ALL_PERMISSIONS.filter((key) => key !== 'brand_brain.review'),
    });
    expect(await countA('learnings-pending', readOnly)).toBe(0);
  });

  it('stops counting a candidate once a person has decided on it', async () => {
    const before = await countA('learnings-pending');
    const id = await learningIn(inA, fixtures.a.workspaceId, fixtures.a.brandId, fixtures.a.userId);
    expect(await countA('learnings-pending')).toBe(before + 1);
    await inA((db) =>
      db.brandKnowledgeCandidate.update({ where: { id }, data: { status: 'REJECTED' } }),
    );
    expect(await countA('learnings-pending')).toBe(before);
  });
});

describe('P6-11 · findings nobody has looked at', () => {
  it('counts NEW, unexpired findings in this workspace only', async () => {
    const before = await countA('insights-new');
    await insightIn(inB, fixtures.b.workspaceId, fixtures.b.brandId, fixtures.b.userId);
    await expectBothLayers('insights-new', before);

    await insightIn(inA, fixtures.a.workspaceId, fixtures.a.brandId, fixtures.a.userId);
    await expectBothLayers('insights-new', before + 1);
  });

  it('does not count a finding that was seen, expired, or is a plan rather than a finding', async () => {
    const before = await countA('insights-new');
    const a = [fixtures.a.workspaceId, fixtures.a.brandId, fixtures.a.userId] as const;
    await insightIn(inA, ...a, { status: 'SEEN' });
    await insightIn(inA, ...a, { expiresAt: new Date(NOW.getTime() - DAY) });
    await insightIn(inA, ...a, { type: 'STRATEGY' });
    expect(await countA('insights-new')).toBe(before);
  });

  it('honours brand scope, and is not run without strategy.read', async () => {
    const scoped = sessionA({ brandScope: [fixtures.a.brandId] });
    const before = await countA('insights-new', scoped);
    await insightIn(inA, fixtures.a.workspaceId, otherBrandId, fixtures.a.userId);
    expect(await countA('insights-new', scoped)).toBe(before);

    const blind = sessionA({
      permissionKeys: ALL_PERMISSIONS.filter((key) => key !== 'strategy.read'),
    });
    expect(await countA('insights-new', blind)).toBe(0);
  });
});

describe('P6-11 · connections about to lose access', () => {
  it('counts an ACTIVE token expiring inside the window, in this workspace only', async () => {
    const before = await countA('connection-expiring');
    await connectionIn(
      inB,
      fixtures.b.workspaceId,
      fixtures.b.brandId,
      new Date(NOW.getTime() + 3600_000),
    );
    await expectBothLayers('connection-expiring', before);

    await connectionIn(
      inA,
      fixtures.a.workspaceId,
      fixtures.a.brandId,
      new Date(NOW.getTime() + 3600_000),
    );
    await expectBothLayers('connection-expiring', before + 1);
  });

  it('ignores a token with days left, and one with no expiry at all', async () => {
    const before = await countA('connection-expiring');
    await connectionIn(
      inA,
      fixtures.a.workspaceId,
      fixtures.a.brandId,
      new Date(NOW.getTime() + 3 * DAY),
    );
    await connectionIn(inA, fixtures.a.workspaceId, fixtures.a.brandId, null);
    expect(await countA('connection-expiring')).toBe(before);
  });

  it('honours brand scope, and is not run without integrations.read', async () => {
    const scoped = sessionA({ brandScope: [fixtures.a.brandId] });
    const before = await countA('connection-expiring', scoped);
    await connectionIn(
      inA,
      fixtures.a.workspaceId,
      otherBrandId,
      new Date(NOW.getTime() + 3600_000),
    );
    expect(await countA('connection-expiring', scoped)).toBe(before);

    const blind = sessionA({
      permissionKeys: ALL_PERMISSIONS.filter((key) => key !== 'integrations.read'),
    });
    expect(await countA('connection-expiring', blind)).toBe(0);
  });
});

describe('P6-11 · running campaigns with nothing in them', () => {
  it('counts an empty ACTIVE campaign in this workspace only, and names it when alone', async () => {
    const scoped = sessionA({ brandScope: [fixtures.a.brandId] });
    const before = await countA('campaign-empty', scoped);
    await campaignIn(inB, fixtures.b.workspaceId, fixtures.b.brandId, 'Foreign campaign');
    expect(await countA('campaign-empty', scoped)).toBe(before);
    expect(await countAUnbounded('campaign-empty', scoped)).toBe(before);

    const id = await campaignIn(inA, fixtures.a.workspaceId, fixtures.a.brandId, 'Autumn launch');
    const items = await inA((db) => attentionItems(db, scoped));
    const item = items.find((entry) => entry.kind === 'campaign-empty');
    expect(item?.count).toBe(before + 1);
    if (before === 0) {
      // One campaign: named, and the link goes straight to it.
      expect(item?.detail).toBe('Autumn launch');
      expect(item?.href).toBe(`/campaigns/${id}`);
    }
    // No other workspace's campaign name can appear.
    expect(JSON.stringify(items)).not.toContain('Foreign campaign');
  });

  it('stops counting a campaign once content is attached, or once it has ended', async () => {
    const before = await countA('campaign-empty');
    const withContent = await campaignIn(inA, fixtures.a.workspaceId, fixtures.a.brandId);
    await inA((db) =>
      db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          campaignId: withContent,
          title: 'Attached',
          status: 'DRAFT',
        },
      }),
    );
    await inA((db) =>
      db.campaign.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: 'Ended',
          objective: 'AWARENESS',
          status: 'ACTIVE',
          endDate: new Date(NOW.getTime() - 3 * DAY),
        },
      }),
    );
    await inA((db) =>
      db.campaign.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: 'Draft',
          objective: 'AWARENESS',
          status: 'DRAFT',
        },
      }),
    );
    expect(await countA('campaign-empty')).toBe(before);
  });

  it('is not run without campaigns.read', async () => {
    const blind = sessionA({
      permissionKeys: ALL_PERMISSIONS.filter((key) => key !== 'campaigns.read'),
    });
    expect(await countA('campaign-empty', blind)).toBe(0);
  });
});

describe('P6-11 · a brand that can publish and has nothing going out', () => {
  /** A fresh brand in A with one ACTIVE connection and nothing scheduled. */
  async function connectedIdleBrand(): Promise<string> {
    const brandId = await inA(async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          name: 'Connected idle brand',
          slug: `idle-${randomUUID().slice(0, 8)}`,
        },
      });
      return brand.id;
    });
    await connectionIn(inA, fixtures.a.workspaceId, brandId, null);
    return brandId;
  }

  it('counts a connected brand with nothing going out, in this workspace only', async () => {
    const brandId = await connectedIdleBrand();
    const scoped = sessionA({ brandScope: [brandId] });
    await expectBothLayers('calendar-gap', 1, scoped);

    // Workspace B gets a connected, idle brand; A's count does not move.
    await connectionIn(inB, fixtures.b.workspaceId, fixtures.b.brandId, null);
    await expectBothLayers('calendar-gap', 1, scoped);
  });

  it('clears when something is scheduled inside the horizon — and not for a slot beyond it', async () => {
    const brandId = await connectedIdleBrand();
    const scoped = sessionA({ brandScope: [brandId] });
    expect(await countA('calendar-gap', scoped)).toBe(1);

    const slotAt = async (at: Date) =>
      inA(async (db) => {
        const item = await db.contentItem.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId,
            title: 'Going out',
            status: 'SCHEDULED',
          },
        });
        await db.calendarSlot.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId,
            contentItemId: item.id,
            scheduledAtUtc: at,
            scheduledLocalTime: at.toISOString().slice(0, 16),
            timezone: 'UTC',
            status: 'SCHEDULED',
          },
        });
      });

    await slotAt(new Date(Date.now() + 30 * DAY));
    expect(await countA('calendar-gap', scoped)).toBe(1);
    await slotAt(new Date(Date.now() + 2 * DAY));
    expect(await countA('calendar-gap', scoped)).toBe(0);
  });

  it('is silent for a brand with no connection — that is not a calendar problem', async () => {
    const quiet = await inA(async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          name: 'Unconnected',
          slug: `unconnected-${randomUUID().slice(0, 8)}`,
        },
      });
      return brand.id;
    });
    expect(await countA('calendar-gap', sessionA({ brandScope: [quiet] }))).toBe(0);
  });
});

describe('P6-11 · credits projected to run out before they renew', () => {
  async function charge(
    run: typeof inA,
    workspaceId: string,
    walletId: string,
    amount: bigint,
    daysAgo: number,
  ) {
    await run((db) =>
      db.creditTransaction.create({
        data: {
          workspaceId,
          walletId,
          type: 'USAGE_CHARGE',
          amountMilliCredits: amount,
          balanceAfterMilliCredits: 0n,
          reason: 'pulse fixture',
          idempotencyKey: `pulse-charge-${randomUUID()}`,
          actorType: 'SYSTEM',
          occurredAt: new Date(NOW.getTime() - daysAgo * DAY),
        },
      }),
    );
  }

  it('is silent while the renewal date is unknown', async () => {
    await inA((db) =>
      db.creditWallet.update({
        where: { id: fixtures.a.walletId },
        data: { nextResetAt: null },
      }),
    );
    await charge(inA, fixtures.a.workspaceId, fixtures.a.walletId, -56_000n, 2);
    expect(await countA('credits-forecast')).toBe(0);
  });

  it('forecasts from THIS workspace’s ledger, and another’s spending cannot move it', async () => {
    const wallet = await inA((db) =>
      db.creditWallet.update({
        where: { id: fixtures.a.walletId },
        data: { nextResetAt: new Date(NOW.getTime() + 25 * DAY) },
      }),
    );
    const spendable = wallet.balanceMilliCredits - wallet.reservedMilliCredits;
    // Net usage in A's window so far: every USAGE_CHARGE/REFUND in the last 28 days.
    const net = await inA(async (db) => {
      const rows = await db.creditTransaction.findMany({
        where: {
          walletId: fixtures.a.walletId,
          type: { in: ['USAGE_CHARGE', 'REFUND'] },
          occurredAt: { gte: new Date(NOW.getTime() - 28 * DAY) },
        },
        select: { amountMilliCredits: true },
      });
      return -rows.reduce((sum, row) => sum + row.amountMilliCredits, 0n);
    });
    const expectedDays = Math.max(1, Math.floor(Number(spendable) / (Number(net) / 28)));

    const items = await inA((db) => attentionItems(db, sessionA()));
    const item = items.find((entry) => entry.kind === 'credits-forecast');
    expect(item?.count).toBe(expectedDays);
    expect(item?.href).toBe('/plan');
    expect(item?.secondDate?.toISOString()).toBe(wallet.nextResetAt?.toISOString());

    // Workspace B spends a fortune. A's forecast does not move.
    await charge(inB, fixtures.b.workspaceId, fixtures.b.walletId, -9_000_000n, 1);
    await expectBothLayers('credits-forecast', expectedDays);
  });

  it('needs BOTH credits.read and billing.read', async () => {
    for (const missing of ['credits.read', 'billing.read']) {
      const partial = sessionA({
        permissionKeys: ALL_PERMISSIONS.filter((key) => key !== missing),
      });
      expect(await countA('credits-forecast', partial)).toBe(0);
    }
  });
});

describe('P6-11 · a proposed learning notifies this brand’s reviewers, once', () => {
  it('tells an unrestricted reviewer and a reviewer of THIS brand, and nobody else', async () => {
    const candidateId = randomUUID();
    const insightId = randomUUID();
    const created = await inA((db) =>
      notifyLearningReviewers(db, fixtures.a.workspaceId, {
        brandId: fixtures.a.brandId,
        insightId,
        createdCandidateIds: [candidateId],
      }),
    );
    expect(created).toBeGreaterThanOrEqual(1);

    const rows = await inA((db) =>
      db.notification.findMany({
        where: { templateKey: 'brand_brain.learning_proposed', resourceId: insightId },
        select: { userId: true, workspaceId: true, linkPath: true, payload: true },
      }),
    );
    const recipients = rows.map((row) => row.userId);
    expect(recipients).toContain(fixtures.a.userId);
    // Restricted to the other brand: not told about this one.
    expect(recipients).not.toContain(reviewerOfOtherBrandOnly);
    for (const row of rows) {
      expect(row.workspaceId).toBe(fixtures.a.workspaceId);
      expect(row.linkPath).toBe('/brand-brain');
      // A pointer, not a copy: nothing of the learning travels.
      expect(row.payload).toEqual({});
    }

    // Workspace B's inbox is untouched, seen from B's own session.
    const inBInbox = await inB((db) => db.notification.count({ where: { resourceId: insightId } }));
    expect(inBInbox).toBe(0);
  });

  it('reaches the other brand’s reviewer about the other brand', async () => {
    const insightId = randomUUID();
    await inA((db) =>
      notifyLearningReviewers(db, fixtures.a.workspaceId, {
        brandId: otherBrandId,
        insightId,
        createdCandidateIds: [randomUUID()],
      }),
    );
    const recipients = await inA((db) =>
      db.notification.findMany({ where: { resourceId: insightId }, select: { userId: true } }),
    );
    expect(recipients.map((row) => row.userId)).toContain(reviewerOfOtherBrandOnly);
  });

  it('is one notice per batch — a replay adds nothing, and nothing new means no notice', async () => {
    const insightId = randomUUID();
    const batch = [randomUUID(), randomUUID()];
    const first = await inA((db) =>
      notifyLearningReviewers(db, fixtures.a.workspaceId, {
        brandId: fixtures.a.brandId,
        insightId,
        createdCandidateIds: batch,
      }),
    );
    const replay = await inA((db) =>
      notifyLearningReviewers(db, fixtures.a.workspaceId, {
        brandId: fixtures.a.brandId,
        insightId,
        // Same batch, different order: still the same event.
        createdCandidateIds: [...batch].reverse(),
      }),
    );
    const nothingNew = await inA((db) =>
      notifyLearningReviewers(db, fixtures.a.workspaceId, {
        brandId: fixtures.a.brandId,
        insightId,
        createdCandidateIds: [],
      }),
    );
    expect(first).toBeGreaterThanOrEqual(1);
    expect(replay).toBe(0);
    expect(nothingNew).toBe(0);
    const perReader = await inA((db) =>
      db.notification.count({ where: { resourceId: insightId, userId: fixtures.a.userId } }),
    );
    expect(perReader).toBe(1);
  });
});
