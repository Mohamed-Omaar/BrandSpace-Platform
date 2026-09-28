import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  declaredPillarIdeas,
  declaredPillarKeys,
  writingFactsInAreas,
  writingGoal,
} from '@brandspace/brand-brain';
import type { Clock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2C, ITEM 1 — THE ONE GROUNDING LAYER'S FIXED-SELECTION LOOKUPS (D-354,
 * owner review of PR #52), against real PostgreSQL.
 *
 * The Creative Studio, Strategy's pillar-gap check, and the composer's goal and
 * pillar ideas no longer read `brand_knowledge_item` themselves. They ask the
 * Brand Brain grounding layer, which applies the three writing rules in ONE
 * place: usable facts only (never expired, archived or unapproved), today in the
 * WORKSPACE's time zone, and each brand's "Use Brand Brain" switch. These tests
 * pin each helper to those rules and to the selection its caller had before —
 * nothing broader.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let secondBrandId: string;

const TIMEZONE = 'Asia/Riyadh';
// 21:00Z on the 30th is 00:00 on the 31st in Riyadh: the 30th has just ended there.
const clock: Clock = { now: () => new Date('2026-10-30T21:00:00.000Z') };
const ENDED = new Date('2026-10-30T00:00:00.000Z');
const TODAY = new Date('2026-10-31T00:00:00.000Z');

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/** Every marker this file writes. */
const OURS = /^(ID|VOICE|OFFERS|PILLAR|GOAL)(-|$)/;

const bodyText = (value: unknown) => (value as { en?: string } | null)?.en ?? '';
const titleText = bodyText;

async function setSwitch(brandId: string, enabled: boolean): Promise<void> {
  await platform.brand.update({ where: { id: brandId }, data: { useBrandBrain: enabled } });
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);

  await platform.workspace.update({
    where: { id: fixtures.a.workspaceId },
    data: { timezone: TIMEZONE },
  });
  secondBrandId = (
    await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `p2c-layer-${Date.now()}`,
        name: 'Second Brand',
        defaultLocale: 'EN',
        status: 'ACTIVE',
      },
    })
  ).id;

  const fact = (
    workspaceId: string,
    brandId: string,
    area: 'IDENTITY' | 'TONE_OF_VOICE' | 'OFFERS' | 'STRATEGY',
    itemKey: string,
    marker: string,
    extra: { status?: 'ACTIVE' | 'STALE' | 'ARCHIVED'; validUntil?: Date } = {},
  ) =>
    platform.brandKnowledgeItem.create({
      data: {
        workspaceId,
        brandId,
        area,
        memory: area === 'STRATEGY' ? 'STRATEGY' : 'CANONICAL',
        origin: 'HUMAN',
        status: extra.status ?? 'ACTIVE',
        itemKey,
        title: { en: marker },
        body: { en: marker },
        version: 1,
        ...(extra.validUntil ? { validUntil: extra.validUntil } : {}),
        ...(extra.status === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
      },
    });

  const a = fixtures.a;
  await fact(a.workspaceId, a.brandId, 'IDENTITY', 'identity.what', 'ID-ACTIVE');
  await fact(a.workspaceId, a.brandId, 'IDENTITY', 'identity.lastday', 'ID-LAST-DAY', {
    validUntil: TODAY,
  });
  await fact(a.workspaceId, a.brandId, 'IDENTITY', 'identity.ended', 'ID-EXPIRED', {
    validUntil: ENDED,
  });
  await fact(a.workspaceId, a.brandId, 'IDENTITY', 'identity.old', 'ID-ARCHIVED', {
    status: 'ARCHIVED',
  });
  await fact(a.workspaceId, a.brandId, 'TONE_OF_VOICE', 'voice.words', 'VOICE-STALE', {
    status: 'STALE',
  });
  await fact(a.workspaceId, a.brandId, 'OFFERS', 'offers.what', 'OFFERS-OTHER-AREA');
  await fact(a.workspaceId, a.brandId, 'STRATEGY', 'pillar.recipes', 'PILLAR-ACTIVE');
  await fact(a.workspaceId, a.brandId, 'STRATEGY', 'pillar.summer', 'PILLAR-EXPIRED', {
    validUntil: ENDED,
  });
  await fact(a.workspaceId, a.brandId, 'STRATEGY', 'goal.primary', 'GOAL');
  await fact(a.workspaceId, secondBrandId, 'STRATEGY', 'pillar.second', 'PILLAR-SECOND-BRAND');
  await fact(a.workspaceId, secondBrandId, 'IDENTITY', 'identity.what', 'ID-SECOND-BRAND');
  const b = fixtures.b;
  await fact(b.workspaceId, b.brandId, 'STRATEGY', 'pillar.foreign', 'PILLAR-FOREIGN');
  await fact(b.workspaceId, b.brandId, 'IDENTITY', 'identity.what', 'ID-FOREIGN');
});

afterAll(async () => {
  await setSwitch(fixtures.a.brandId, true).catch(() => undefined);
  await setSwitch(secondBrandId, true).catch(() => undefined);
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('Creative — writingFactsInAreas', () => {
  it('returns the usable identity and voice facts only, in area-then-key order, as before', async () => {
    const lines = await inA((db) =>
      writingFactsInAreas(
        db,
        { brandId: fixtures.a.brandId, areas: ['IDENTITY', 'TONE_OF_VOICE'], maxItems: 6 },
        clock,
      ),
    );
    // IDENTITY before TONE_OF_VOICE; within IDENTITY, by key. The last day
    // is still usable; STALE is approved; expired, archived, another area,
    // another brand and another workspace are not.
    // The shared fixtures seed facts of their own; only this file's markers are compared.
    expect(lines.map((line) => bodyText(line.body)).filter((text) => OURS.test(text))).toEqual([
      'ID-LAST-DAY',
      'ID-ACTIVE',
      'VOICE-STALE',
    ]);
  });

  it('keeps the caller’s limit', async () => {
    const lines = await inA((db) =>
      writingFactsInAreas(
        db,
        { brandId: fixtures.a.brandId, areas: ['IDENTITY', 'TONE_OF_VOICE'], maxItems: 2 },
        clock,
      ),
    );
    expect(lines).toHaveLength(2);
  });

  it('gives nothing while the brand has "Use Brand Brain" off', async () => {
    await setSwitch(fixtures.a.brandId, false);
    try {
      const lines = await inA((db) =>
        writingFactsInAreas(
          db,
          { brandId: fixtures.a.brandId, areas: ['IDENTITY', 'TONE_OF_VOICE'], maxItems: 6 },
          clock,
        ),
      );
      expect(lines).toEqual([]);
    } finally {
      await setSwitch(fixtures.a.brandId, true);
    }
  });

  it('never reads another workspace’s brand, even by its id', async () => {
    const lines = await inA((db) =>
      writingFactsInAreas(
        db,
        { brandId: fixtures.b.brandId, areas: ['IDENTITY', 'TONE_OF_VOICE'], maxItems: 6 },
        clock,
      ),
    );
    expect(lines).toEqual([]);
  });
});

describe('Strategy — declaredPillarKeys', () => {
  it('returns the keys of usable, non-goal STRATEGY facts of that brand only', async () => {
    const keys = await inA((db) =>
      declaredPillarKeys(db, { brandId: fixtures.a.brandId, maxItems: 20 }, clock),
    );
    expect([...keys].sort()).toEqual(['pillar.recipes']);
  });

  it('gives nothing while the brand has "Use Brand Brain" off', async () => {
    await setSwitch(fixtures.a.brandId, false);
    try {
      const keys = await inA((db) =>
        declaredPillarKeys(db, { brandId: fixtures.a.brandId, maxItems: 20 }, clock),
      );
      expect(keys).toEqual([]);
    } finally {
      await setSwitch(fixtures.a.brandId, true);
    }
  });
});

describe('the composer — declaredPillarIdeas and writingGoal', () => {
  it('pillar ideas: usable, non-goal, in the member’s scope, each brand’s own switch', async () => {
    const titles = async (brandScope: readonly string[] | null, brandId?: string) =>
      (await inA((db) => declaredPillarIdeas(db, { brandId, brandScope, maxItems: 3 }, clock)))
        .map((row) => titleText(row.title))
        .sort();

    expect(await titles(null)).toEqual(['PILLAR-ACTIVE', 'PILLAR-SECOND-BRAND']);
    expect(await titles(null, fixtures.a.brandId)).toEqual(['PILLAR-ACTIVE']);
    expect(await titles([secondBrandId])).toEqual(['PILLAR-SECOND-BRAND']);

    await setSwitch(secondBrandId, false);
    try {
      expect(await titles(null)).toEqual(['PILLAR-ACTIVE']);
    } finally {
      await setSwitch(secondBrandId, true);
    }
  });

  it('the goal is read for writing while it is usable', async () => {
    const goal = await inA((db) =>
      writingGoal(db, { brandId: fixtures.a.brandId, itemKey: 'goal.primary' }, clock),
    );
    expect(titleText(goal?.title)).toBe('GOAL');
  });

  it('an EXPIRED goal is not a writing input', async () => {
    await platform.brandKnowledgeItem.updateMany({
      where: { brandId: fixtures.a.brandId, itemKey: 'goal.primary' },
      data: { validUntil: ENDED },
    });
    try {
      const goal = await inA((db) =>
        writingGoal(db, { brandId: fixtures.a.brandId, itemKey: 'goal.primary' }, clock),
      );
      expect(goal).toBeNull();
    } finally {
      await platform.brandKnowledgeItem.updateMany({
        where: { brandId: fixtures.a.brandId, itemKey: 'goal.primary' },
        data: { validUntil: null },
      });
    }
  });

  it('with "Use Brand Brain" off, the goal is not a writing input either', async () => {
    await setSwitch(fixtures.a.brandId, false);
    try {
      const goal = await inA((db) =>
        writingGoal(db, { brandId: fixtures.a.brandId, itemKey: 'goal.primary' }, clock),
      );
      expect(goal).toBeNull();
    } finally {
      await setSwitch(fixtures.a.brandId, true);
    }
  });
});
