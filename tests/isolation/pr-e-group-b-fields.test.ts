import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolationFixtures,
  platformRoleClient,
  appRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR E (D-496) — THE GROUP B FIELDS, AGAINST REAL POSTGRESQL.
 *
 *   - `campaign_planned_post_count_positive`: a planned count is nothing or
 *     above zero, whatever the application layer does;
 *   - `brand.aiDraftsToReview` defaults to false for a row that does not name
 *     it (existing brands stay off), and can be written only inside the
 *     brand's own workspace;
 *   - `insight.snoozedUntil` can be written and read only inside the insight's
 *     own workspace.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function campaignWith(plannedPostCount: number | null): Promise<string | null> {
  try {
    await platform.campaign.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `pr-e planned ${randomUUID().slice(0, 6)}`,
        objective: 'ENGAGEMENT',
        status: 'DRAFT',
        plannedPostCount,
      } as never,
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('PR E — campaign_planned_post_count_positive', () => {
  it('admits no count, and any count above zero', async () => {
    expect(await campaignWith(null)).toBeNull();
    expect(await campaignWith(1)).toBeNull();
    expect(await campaignWith(24)).toBeNull();
  });

  it('refuses zero and below', async () => {
    for (const bad of [0, -1]) {
      expect(await campaignWith(bad), String(bad)).toContain(
        'campaign_planned_post_count_positive',
      );
    }
  });
});

describe('PR E — brand.aiDraftsToReview', () => {
  it('defaults a brand that does not name it to off', async () => {
    const row = await platform.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `pr-e-default-${randomUUID().slice(0, 6)}`,
        name: 'PR E default',
        status: 'ACTIVE',
      } as never,
      select: { aiDraftsToReview: true },
    });
    expect(row.aiDraftsToReview).toBe(false);
  });

  it('cannot be written from another workspace', async () => {
    const changed = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.brand.updateMany({
          where: { id: fixtures.a.brandId },
          data: { aiDraftsToReview: true } as never,
        }),
      { prisma: app },
    );
    expect(changed.count).toBe(0);
    const after = await platform.brand.findUniqueOrThrow({
      where: { id: fixtures.a.brandId },
      select: { aiDraftsToReview: true } as never,
    });
    expect((after as { aiDraftsToReview: boolean }).aiDraftsToReview).toBe(false);
  });

  it('is written inside its own workspace', async () => {
    const changed = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.brand.updateMany({
          where: { id: fixtures.a.brandId },
          data: { aiDraftsToReview: true } as never,
        }),
      { prisma: app },
    );
    expect(changed.count).toBe(1);
    await platform.brand.update({
      where: { id: fixtures.a.brandId },
      data: { aiDraftsToReview: false } as never,
    });
  });
});

describe('PR E — insight.snoozedUntil', () => {
  it('cannot be written, or read, from another workspace', async () => {
    const insight = await platform.insight.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId },
      select: { id: true },
    });
    const until = new Date(Date.now() + 7 * 86_400_000);
    const changed = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.insight.updateMany({
          where: { id: insight.id },
          data: { snoozedUntil: until } as never,
        }),
      { prisma: app },
    );
    expect(changed.count).toBe(0);
    const seen = await withWorkspace(
      fixtures.b.workspaceId,
      (db) => db.insight.findMany({ where: { id: insight.id }, select: { id: true } }),
      { prisma: app },
    );
    expect(seen).toEqual([]);
    const own = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        db.insight.updateMany({
          where: { id: insight.id },
          data: { snoozedUntil: until } as never,
        }),
      { prisma: app },
    );
    expect(own.count).toBe(1);
    await platform.insight.update({
      where: { id: insight.id },
      data: { snoozedUntil: null } as never,
    });
  });
});
