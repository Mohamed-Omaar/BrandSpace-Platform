import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  BrandKnowledgeService,
  calendarDate,
  groundingFor,
  knowledgeAsOf,
  type KnowledgeActor,
  type StalenessPolicy,
} from '@brandspace/brand-brain';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C, ITEM 2 — knowledge, review and completeness against real
 * PostgreSQL: "valid until" in the WORKSPACE'S time zone (D6), the one bulk
 * review path (D4, C1), the conflict rule (owner decision 2.a, Option A: D-65
 * stands) and key-question completeness (Q19) — none of it reachable across a
 * workspace or a brand.
 */

const POLICY: StalenessPolicy = { reviewIntervalDays: 90 };
const TIMEZONE = 'Asia/Riyadh';

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const actor = (over: Partial<KnowledgeActor> = {}): KnowledgeActor => ({
  userId: fixtures.a.userId,
  permissionKeys: ['brand_brain.edit', 'brand_brain.review'],
  brandScope: [],
  ...over,
});

const inA = <T>(fn: (svc: BrandKnowledgeService, db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    (db) => fn(new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }), db),
    { prisma: app },
  );

const key = (stem: string) => `${stem}.${randomUUID().slice(0, 8)}`;

async function candidate(input: {
  itemKey: string;
  confidenceMilli: number;
  area?: 'AUDIENCE' | 'OFFERS' | 'PROOF_POINTS' | 'LEARNINGS';
  conflictsWithItemId?: string;
  workspaceId?: string;
  brandId?: string;
  sourceDocumentId?: string;
}) {
  return platform.brandKnowledgeCandidate.create({
    data: {
      workspaceId: input.workspaceId ?? fixtures.a.workspaceId,
      brandId: input.brandId ?? fixtures.a.brandId,
      sourceDocumentId: input.sourceDocumentId ?? fixtures.a.sourceDocumentId,
      area: input.area ?? 'AUDIENCE',
      itemKey: input.itemKey,
      extractedTitle: { en: `Proposed ${input.itemKey}` },
      extractedBody: { en: `Proposed body ${input.itemKey}` },
      confidenceMilli: input.confidenceMilli,
      evidence: [{ locator: 'page 1', quote: 'q' }],
      status: 'PENDING',
      ...(input.conflictsWithItemId ? { conflictsWithItemId: input.conflictsWithItemId } : {}),
    },
  });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  await platform.workspace.update({
    where: { id: fixtures.a.workspaceId },
    data: { timezone: TIMEZONE },
  });
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('D6 — "valid until", in the workspace time zone', () => {
  it('is recorded on the fact and on its version; setting it later is a new version', async () => {
    const itemKey = key('offers.validity');
    const { created, updated, versions } = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey,
        title: { en: 'Summer offer' },
        body: { en: 'Two for one' },
        actor: actor(),
        policy: POLICY,
        validUntil: calendarDate('2026-10-30'),
      });
      const updated = await svc.updateItem({
        itemId: created.id,
        title: { en: 'Summer offer' },
        body: { en: 'Two for one' },
        actor: actor(),
        policy: POLICY,
        validUntil: null,
      });
      const versions = await db.brandKnowledgeVersion.findMany({
        where: { knowledgeItemId: created.id },
        orderBy: { version: 'asc' },
      });
      return { created, updated, versions };
    });
    expect(created.validUntil?.toISOString().slice(0, 10)).toBe('2026-10-30');
    expect(updated.validUntil).toBeNull();
    expect(updated.version).toBe(2);
    expect(versions.map((v) => v.validUntil?.toISOString().slice(0, 10) ?? null)).toEqual([
      '2026-10-30',
      null,
    ]);
  });

  it('grounds writing through its last LOCAL day and never after it — STALE stays usable', async () => {
    const itemKey = key('offers.until-30th');
    const marker = `UNTIL-30TH-${randomUUID().slice(0, 6)}`;
    await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey,
        title: { en: `granola ${marker}` },
        body: { en: `granola ${marker}` },
        actor: actor(),
        policy: POLICY,
        validUntil: calendarDate('2026-10-30'),
      }),
    );
    const ground = (instant: string) =>
      inA((_svc, db) =>
        groundingFor(
          db,
          {
            brandId: fixtures.a.brandId,
            question: 'granola',
            purpose: 'writing',
            maxItems: 20,
            maxChars: 20_000,
          },
          { now: () => new Date(instant) },
        ),
      );
    // 23:59 in Riyadh on the 30th (20:59Z): still the last day.
    expect((await ground('2026-10-30T20:59:00Z')).contextText).toContain(marker);
    // 00:00 in Riyadh on the 31st (21:00Z on the 30th): expired, although UTC is still the 30th.
    expect((await ground('2026-10-30T21:00:00Z')).contextText).not.toContain(marker);
  });

  it('an expired fact answers no key question and is counted as expired', async () => {
    const itemKey = key('offers.expired-answer');
    const questions = new Map([
      [
        'OFFERS' as const,
        [{ key: 'q', itemKey, prompt: { en: 'What do you sell?', ar: 'ماذا تبيع؟' } }],
      ],
    ]);
    const asOf = knowledgeAsOf(TIMEZONE, new Date('2026-11-05T12:00:00Z'));
    const { before, after } = await inA(async (svc) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey,
        title: { en: 'x' },
        body: { en: 'y' },
        actor: actor(),
        policy: POLICY,
      });
      const before = await svc.completion(fixtures.a.brandId, questions, asOf);
      await svc.updateItem({
        itemId: created.id,
        title: { en: 'x' },
        body: { en: 'y' },
        actor: actor(),
        policy: POLICY,
        validUntil: calendarDate('2026-11-01'),
      });
      const after = await svc.completion(fixtures.a.brandId, questions, asOf);
      return { before, after };
    });
    const offers = (c: typeof before) => c.areas.find((area) => area.area === 'OFFERS')!;
    expect(offers(before).questions[0]?.answered).toBe(true);
    expect(offers(after).questions[0]?.answered).toBe(false);
    expect(offers(after).expiredItems).toBe(offers(before).expiredItems + 1);
    expect(after.missing.some((entry) => entry.question.itemKey === itemKey)).toBe(true);
  });
});

describe('D4 + C1 — "Accept the confident ones": one path, one transaction', () => {
  it('accepts only confident, non-conflicting, still-pending candidates, and says what it skipped', async () => {
    const confident = await candidate({ itemKey: key('audience.confident'), confidenceMilli: 900 });
    const low = await candidate({ itemKey: key('audience.low'), confidenceMilli: 600 });
    const takenKey = key('audience.taken');
    await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'AUDIENCE',
        itemKey: takenKey,
        title: { en: 'Approved' },
        body: { en: 'Already approved' },
        actor: actor(),
        policy: POLICY,
      }),
    );
    const replacing = await candidate({ itemKey: takenKey, confidenceMilli: 950 });
    const foreign = await candidate({
      itemKey: key('audience.foreign'),
      confidenceMilli: 950,
      workspaceId: fixtures.b.workspaceId,
      brandId: fixtures.b.brandId,
      sourceDocumentId: fixtures.b.sourceDocumentId,
    });

    const preview = await inA((svc) =>
      svc.confidentCandidates({
        brandId: fixtures.a.brandId,
        minimumConfidenceMilli: 850,
        brandScope: [],
      }),
    );
    const previewIds = preview.map((entry) => entry.id);
    expect(previewIds).toContain(confident.id);
    expect(previewIds).not.toContain(low.id);
    expect(previewIds).not.toContain(replacing.id);
    expect(previewIds).not.toContain(foreign.id);

    const outcome = await inA((svc) =>
      svc.reviewCandidates({
        brandId: fixtures.a.brandId,
        candidateIds: [confident.id, low.id, replacing.id, foreign.id],
        minimumConfidenceMilli: 850,
        actor: actor(),
        policy: POLICY,
      }),
    );
    expect(outcome.accepted).toEqual([confident.id]);
    expect(outcome.skipped.map((entry) => entry.id).sort()).toEqual(
      [low.id, replacing.id, foreign.id].sort(),
    );

    const statuses = await platform.brandKnowledgeCandidate.findMany({
      where: { id: { in: [confident.id, low.id, replacing.id, foreign.id] } },
      select: { id: true, status: true },
    });
    const byId = new Map(statuses.map((row) => [row.id, row.status]));
    expect(byId.get(confident.id)).toBe('ACCEPTED');
    expect(byId.get(low.id)).toBe('PENDING');
    expect(byId.get(replacing.id)).toBe('PENDING');
    expect(byId.get(foreign.id)).toBe('PENDING');
    expect(
      await platform.auditEvent.count({
        where: { action: 'brand_brain.candidate.bulk_accepted', resourceId: fixtures.a.brandId },
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("runs inside the caller's ONE transaction: a failure after it leaves nothing accepted", async () => {
    const first = await candidate({ itemKey: key('audience.atomic-a'), confidenceMilli: 900 });
    const second = await candidate({ itemKey: key('audience.atomic-b'), confidenceMilli: 900 });
    await expect(
      inA(async (svc) => {
        await svc.reviewCandidates({
          brandId: fixtures.a.brandId,
          candidateIds: [first.id, second.id],
          minimumConfidenceMilli: 850,
          actor: actor(),
          policy: POLICY,
        });
        throw new Error('the request failed after the bulk accept');
      }),
    ).rejects.toThrow('the request failed');
    const rows = await platform.brandKnowledgeCandidate.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { status: true },
    });
    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'PENDING']);
  });

  it('a brand outside the member’s scope is refused like one that does not exist', async () => {
    const pending = await candidate({ itemKey: key('audience.scoped'), confidenceMilli: 900 });
    await expect(
      inA((svc) =>
        svc.reviewCandidates({
          brandId: fixtures.a.brandId,
          candidateIds: [pending.id],
          minimumConfidenceMilli: 850,
          actor: actor({ brandScope: [randomUUID()] }),
          policy: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('owner decision 2.a (Option A) — a conflict is decided by precedence, never in bulk', () => {
  it('an analytics learning cannot be ACCEPTED over a human fact; the human fact is untouched', async () => {
    const humanKey = key('proof_points.award');
    const human = await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'PROOF_POINTS',
        itemKey: humanKey,
        title: { en: 'Award' },
        body: { en: 'We won the award' },
        actor: actor(),
        policy: POLICY,
      }),
    );
    const learning = await platform.brandKnowledgeCandidate.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        sourceKind: 'ANALYTICS',
        sourceDocumentId: null,
        insightId: fixtures.a.insightId,
        conflictsWithItemId: human.id,
        area: 'LEARNINGS',
        itemKey: humanKey,
        extractedTitle: { en: 'Inferred' },
        extractedBody: { en: 'An inference that disagrees' },
        confidenceMilli: 900,
        evidence: [],
        status: 'PENDING',
      },
    });

    await expect(
      inA((svc) =>
        svc.reviewCandidate({
          candidateId: learning.id,
          decision: 'accept',
          actor: actor(),
          policy: POLICY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const unchanged = await platform.brandKnowledgeItem.findUniqueOrThrow({
      where: { id: human.id },
    });
    expect(unchanged.status).toBe('ACTIVE');
    expect(unchanged.version).toBe(human.version);

    // Reject stays available.
    await inA((svc) =>
      svc.reviewCandidate({
        candidateId: learning.id,
        decision: 'reject',
        actor: actor(),
        policy: POLICY,
      }),
    );
    expect(
      (await platform.brandKnowledgeCandidate.findUniqueOrThrow({ where: { id: learning.id } }))
        .status,
    ).toBe('REJECTED');
  });

  it('where precedence allows it, accepting ARCHIVES the old fact as superseded and keeps its history', async () => {
    // An inferred learning (the lowest authority) that a document now contradicts.
    const learningKey = key('learnings.old');
    const old = await platform.brandKnowledgeItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        area: 'LEARNINGS',
        memory: 'LEARNING',
        origin: 'AI_INFERRED',
        status: 'ACTIVE',
        itemKey: learningKey,
        title: { en: 'Old learning' },
        body: { en: 'Old learning body' },
        version: 1,
      },
    });
    await platform.brandKnowledgeVersion.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        knowledgeItemId: old.id,
        version: 1,
        area: 'LEARNINGS',
        memory: 'LEARNING',
        origin: 'AI_INFERRED',
        status: 'ACTIVE',
        title: { en: 'Old learning' },
        body: { en: 'Old learning body' },
        changeKind: 'created',
      },
    });
    const incoming = await candidate({
      itemKey: key('audience.newer'),
      confidenceMilli: 900,
      conflictsWithItemId: old.id,
    });

    const result = await inA((svc) =>
      svc.reviewCandidate({
        candidateId: incoming.id,
        decision: 'accept',
        actor: actor(),
        policy: POLICY,
      }),
    );
    const archived = await platform.brandKnowledgeItem.findUniqueOrThrow({ where: { id: old.id } });
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.supersededByItemId).toBe(result.itemId);
    const history = await platform.brandKnowledgeVersion.findMany({
      where: { knowledgeItemId: old.id },
      orderBy: { version: 'asc' },
    });
    expect(history.map((v) => [v.version, v.changeKind])).toEqual([
      [1, 'created'],
      [2, 'superseded'],
    ]);
  });

  it('never proposes a conflicting candidate for bulk accept', async () => {
    const humanKey = key('proof_points.bulk-conflict');
    const human = await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'PROOF_POINTS',
        itemKey: humanKey,
        title: { en: 'Human' },
        body: { en: 'Human' },
        actor: actor(),
        policy: POLICY,
      }),
    );
    const conflicting = await candidate({
      itemKey: key('proof_points.other'),
      area: 'PROOF_POINTS',
      confidenceMilli: 990,
      conflictsWithItemId: human.id,
    });
    const preview = await inA((svc) =>
      svc.confidentCandidates({
        brandId: fixtures.a.brandId,
        minimumConfidenceMilli: 850,
        brandScope: [],
      }),
    );
    expect(preview.map((entry) => entry.id)).not.toContain(conflicting.id);
  });
});
