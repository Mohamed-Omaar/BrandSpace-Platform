import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { BrandKnowledgeService, type StalenessPolicy } from '@brandspace/brand-brain';
import { commercePolicyFrom, type CommercePolicy } from '@brandspace/billing';
import { findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceOnboardingService } from '@brandspace/onboarding';
import { saveSetupGoal } from '../../apps/dashboard/src/server/setup-goal';
import {
  GOAL_ITEM_KEY,
  GOAL_ITEM_SELECT,
  storedGoal,
} from '../../apps/dashboard/src/server/setup-wizard-state';
import {
  appRoleClient,
  createIsolationFixtures,
  ensureWorkspaceRbac,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';

/**
 * PROTOTYPE v94 PHASE 2B-1, ITEM 9 — G8 / C6 (D-335), AGAINST REAL POSTGRESQL.
 *
 * What setup records reaches the Brand Brain through its OWN service, marked
 * SETUP: facts accepted on the wizard's Review step, and the first goal (with
 * its key on the brand). Only the wizard's own brand in its own workspace is
 * ever written; a brand of another workspace is a 404 shaped like a miss. A
 * new workspace keeps a city for Egypt only.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
const POLICY: StalenessPolicy = { reviewIntervalDays: 90 };

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

type ScopedDb = TenantScopedClient;

function inA<T>(fn: (svc: BrandKnowledgeService, db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => fn(new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }), db),
    { prisma: app },
  );
}

const actorA = (brandScope: string[] = []) => ({
  userId: fixtures.a.userId,
  permissionKeys: [] as string[],
  brandScope,
});

let sequence = 0;
const uniqueKey = (stem: string) => `${stem}.p2b1.${(sequence += 1)}`;

async function candidate(db: ScopedDb, itemKey: string, sourceKind: 'DOCUMENT' | 'ANALYTICS') {
  // An inference has no document; the CHECK requires the insight it came from.
  const insightId =
    sourceKind === 'ANALYTICS'
      ? (
          await db.insight.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId: fixtures.a.brandId,
              type: 'ANALYTICS_EXPLANATION',
              status: 'NEW',
              basis: 'OWN_PERFORMANCE',
              title: { ar: 'شرح', en: 'An explanation' },
              body: {},
              periodStart: new Date(Date.UTC(2026, 8, 1)),
              periodEnd: new Date(Date.UTC(2026, 8, 28)),
              generatedByUserId: fixtures.a.userId,
              idempotencyKey: `p2b1-setup-${crypto.randomUUID()}`,
            },
          })
        ).id
      : null;
  return db.brandKnowledgeCandidate.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      area: sourceKind === 'ANALYTICS' ? 'LEARNINGS' : 'AUDIENCE',
      itemKey,
      sourceKind,
      sourceDocumentId: sourceKind === 'DOCUMENT' ? fixtures.a.sourceDocumentId : null,
      insightId,
      extractedTitle: { en: 'Extracted' },
      extractedBody: { en: 'extracted text' },
      confidenceMilli: 700,
      evidence: [{ chunkId: fixtures.a.sourceChunkId, locator: 'page 1' }],
    },
  });
}

describe('D-335 · a fact accepted on the Review step is SETUP', () => {
  it('SETUP from the wizard, DOCUMENT from Brand Brain — same candidate kind, same service', async () => {
    const [inSetup, inBrandBrain] = await inA(async (svc, db) => {
      const origins: (string | undefined)[] = [];
      for (const acceptedInSetup of [true, false]) {
        const row = await candidate(db, uniqueKey('audience.setup'), 'DOCUMENT');
        const outcome = await svc.reviewCandidate({
          candidateId: row.id,
          decision: 'accept',
          actor: actorA(),
          policy: POLICY,
          acceptedInSetup,
        });
        const item = await db.brandKnowledgeItem.findUnique({
          where: { id: outcome.itemId ?? '' },
          select: { origin: true, sourceDocumentId: true, brandId: true, workspaceId: true },
        });
        expect(item?.sourceDocumentId).toBe(fixtures.a.sourceDocumentId);
        expect(item?.brandId).toBe(fixtures.a.brandId);
        expect(item?.workspaceId).toBe(fixtures.a.workspaceId);
        origins.push(item?.origin);
      }
      return origins;
    });
    expect(inSetup).toBe('SETUP');
    expect(inBrandBrain).toBe('DOCUMENT');
  });

  it('an analytics candidate stays AI_INFERRED even when accepted in setup', async () => {
    const origin = await inA(async (svc, db) => {
      const row = await candidate(db, uniqueKey('learning.setup'), 'ANALYTICS');
      const outcome = await svc.reviewCandidate({
        candidateId: row.id,
        decision: 'accept',
        actor: actorA(),
        policy: POLICY,
        acceptedInSetup: true,
      });
      return (
        await db.brandKnowledgeItem.findUnique({
          where: { id: outcome.itemId ?? '' },
          select: { origin: true },
        })
      )?.origin;
    });
    expect(origin).toBe('AI_INFERRED');
  });

  it('a SETUP fact can still be refreshed by a newer document and edited by a person', async () => {
    /*
     * An item's origin says where the ROW came from and never changes; each
     * later change is a version. What matters is that neither later change is
     * refused: SETUP shares DOCUMENT's rank, so it does not lock the fact.
     */
    const key = uniqueKey('audience.refresh');
    const result = await inA(async (svc, db) => {
      const first = await candidate(db, key, 'DOCUMENT');
      const accepted = await svc.reviewCandidate({
        candidateId: first.id,
        decision: 'accept',
        actor: actorA(),
        policy: POLICY,
        acceptedInSetup: true,
      });
      const newer = await candidate(db, key, 'DOCUMENT');
      const refreshed = await svc.reviewCandidate({
        candidateId: newer.id,
        decision: 'accept',
        actor: actorA(),
        policy: POLICY,
      });
      const edited = await svc.updateItem({
        itemId: accepted.itemId ?? '',
        title: { en: 'Mine' },
        body: { en: 'Edited by a person' },
        actor: actorA(),
        policy: POLICY,
      });
      const versions = await db.brandKnowledgeVersion.findMany({
        where: { knowledgeItemId: edited.id },
        orderBy: { version: 'asc' },
        select: { changeKind: true },
      });
      return { accepted, refreshed, edited, versions: versions.map((v) => v.changeKind) };
    });
    expect(result.refreshed.itemId).toBe(result.accepted.itemId);
    expect(result.edited).toMatchObject({ origin: 'SETUP', version: 3 });
    expect(result.versions).toEqual(['approved', 'approved', 'edited']);
  });
});

describe('D-335 · the first goal', () => {
  it('is a SETUP item in STRATEGY, with its key on the brand, audited', async () => {
    const result = await inA(async (svc, db) => {
      await saveSetupGoal(db, svc, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        goal: 'LEADS',
        actor: actorA(),
        staleness: POLICY,
      });
      const item = await db.brandKnowledgeItem.findFirstOrThrow({
        where: { brandId: fixtures.a.brandId, area: 'STRATEGY', itemKey: GOAL_ITEM_KEY },
        select: { origin: true, status: true, id: true },
      });
      const brand = await db.brand.findUniqueOrThrow({
        where: { id: fixtures.a.brandId },
        select: { primaryGoalKey: true },
      });
      const audits = await db.auditEvent.findMany({
        where: {
          resourceId: { in: [item.id, fixtures.a.brandId] },
          action: {
            in: [
              'brand_brain.knowledge.created',
              'brand_brain.knowledge.updated',
              'brand.profile.updated',
            ],
          },
        },
        select: { action: true },
      });
      return { item, brand, audits: audits.map((a) => a.action) };
    });
    expect(result.item).toMatchObject({ origin: 'SETUP', status: 'ACTIVE' });
    expect(result.brand.primaryGoalKey).toBe('LEADS');
    expect(result.audits).toContain('brand.profile.updated');
  });

  it('a Brand Brain edit stops the key describing it; choosing again in setup restores it', async () => {
    const read = (db: ScopedDb) =>
      db.brandKnowledgeItem.findFirstOrThrow({
        where: { brandId: fixtures.a.brandId, area: 'STRATEGY', itemKey: GOAL_ITEM_KEY },
        select: { id: true, version: true, ...GOAL_ITEM_SELECT },
      });
    const result = await inA(async (svc, db) => {
      const chosen = await read(db);
      await svc.updateItem({
        itemId: chosen.id,
        title: { en: 'Our own goal' },
        body: { en: 'Written in Brand Brain' },
        actor: actorA(),
        policy: POLICY,
      });
      const edited = await read(db);
      await saveSetupGoal(db, svc, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        goal: 'TRAFFIC',
        actor: actorA(),
        staleness: POLICY,
      });
      const again = await read(db);
      const count = await db.brandKnowledgeItem.count({
        where: { brandId: fixtures.a.brandId, area: 'STRATEGY', itemKey: GOAL_ITEM_KEY },
      });
      return { chosen, edited, again, count };
    });
    // Read by its key while setup wrote it …
    expect(storedGoal(result.chosen)).toBe('LEADS');
    // … by its title once a person rewrote it — "Our own goal" is no preset …
    expect(storedGoal(result.edited)).toBeNull();
    // … and by its key again once it is chosen again in setup: one item, a new version.
    expect(storedGoal(result.again)).toBe('TRAFFIC');
    expect(result.again.id).toBe(result.chosen.id);
    expect(result.again.version).toBe(result.chosen.version + 2);
    expect(result.again.origin).toBe('SETUP');
    expect(result.count).toBe(1);
  });

  it('a goal written before SETUP existed (a HUMAN row) is chosen again without a refusal', async () => {
    const brand = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `legacy-goal-${crypto.randomUUID().slice(0, 8)}`,
        name: 'Legacy goal',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const goal = await inA(async (svc, db) => {
      await svc.createItem({
        brandId: brand.id,
        area: 'STRATEGY',
        itemKey: GOAL_ITEM_KEY,
        title: { en: 'Get more leads' },
        body: { en: 'Before D-335' },
        actor: actorA(),
        policy: POLICY,
      });
      await saveSetupGoal(db, svc, {
        workspaceId: fixtures.a.workspaceId,
        brandId: brand.id,
        goal: 'RETENTION',
        actor: actorA(),
        staleness: POLICY,
      });
      return db.brandKnowledgeItem.findFirstOrThrow({
        where: { brandId: brand.id, itemKey: GOAL_ITEM_KEY },
        select: GOAL_ITEM_SELECT,
      });
    });
    expect(goal.origin).toBe('HUMAN');
    expect(storedGoal(goal)).toBe('RETENTION');
  });

  it('another workspace’s brand is a 404, and nothing is written there', async () => {
    await expect(
      inA((svc, db) =>
        saveSetupGoal(db, svc, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.b.brandId,
          goal: 'LEADS',
          actor: actorA(),
          staleness: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const theirs = await platform.brand.findUniqueOrThrow({
      where: { id: fixtures.b.brandId },
      select: { primaryGoalKey: true },
    });
    expect(theirs.primaryGoalKey).toBeNull();
    expect(
      await platform.brandKnowledgeItem.count({
        where: { brandId: fixtures.b.brandId, itemKey: GOAL_ITEM_KEY, origin: 'SETUP' },
      }),
    ).toBe(0);
  });

  it('a brand outside the member’s BrandScope is refused before anything is read', async () => {
    await expect(
      inA((svc, db) =>
        saveSetupGoal(db, svc, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          goal: 'LEADS',
          actor: actorA([crypto.randomUUID()]),
          staleness: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the database refuses a goal key that is free text', async () => {
    await expect(
      platform.brand.update({
        where: { id: fixtures.a.brandId },
        data: { primaryGoalKey: 'grow a lot; drop table' },
      }),
    ).rejects.toThrow(/brand_primary_goal_key_shape/);
  });
});

describe('G8 · a new workspace keeps a city for Egypt only', () => {
  let policy: CommercePolicy;
  const run = crypto.randomUUID().slice(0, 8);
  const plans = readPlanCatalogue({
    plans: [
      {
        key: `city-${run}`,
        name: { en: 'City', ar: 'مدينة' },
        tier: 1,
        status: 'active',
        visibility: 'public',
        prices: [{ currency: 'USD', monthlyMinor: 100, annualMinor: 1000 }],
        trialDays: 14,
        quotas: { workspaces: 5 },
      },
    ],
  });
  const trial = findPlan(plans, `city-${run}`);

  beforeAll(async () => {
    await ensureWorkspaceRbac(platform);
    policy = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);
  }, 120_000);

  async function owner(): Promise<string> {
    const user = await platform.user.create({
      data: {
        email: `p2b1-city-${crypto.randomUUID().slice(0, 8)}@example.local`,
        name: 'City owner',
        status: 'ACTIVE',
        locale: 'EN',
        timezone: 'UTC',
        emailVerifiedAt: new Date(),
      },
    });
    return user.id;
  }

  async function create(ownerUserId: string, country: string, city: string | null) {
    await new WorkspaceOnboardingService().create(
      platform as unknown as TenantScopedClient,
      {
        ownerUserId,
        name: 'City fixture',
        slug: `p2b1-city-${crypto.randomUUID().slice(0, 10)}`,
        country,
        defaultLocale: 'EN',
        timezone: country === 'EG' ? 'Africa/Cairo' : 'Asia/Riyadh',
        city,
        currency: 'USD',
        billingEmail: `billing-${crypto.randomUUID().slice(0, 8)}@example.local`,
      },
      policy,
      trial ?? null,
      null,
      plans,
    );
    return platform.workspace.findFirstOrThrow({
      where: { ownerUserId },
      orderBy: { createdAt: 'desc' },
      select: { city: true, country: true },
    });
  }

  it('Cairo is kept for Egypt; a city sent with Saudi Arabia is dropped', async () => {
    expect(await create(await owner(), 'EG', 'EG-C')).toEqual({ city: 'EG-C', country: 'EG' });
    expect(await create(await owner(), 'SA', 'EG-C')).toEqual({ city: null, country: 'SA' });
  });

  it('a code that is not a governorate is refused, and nothing is created', async () => {
    const id = await owner();
    await expect(create(id, 'EG', 'EG-ZZZ')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await platform.workspace.count({ where: { ownerUserId: id } })).toBe(0);
  });
});
