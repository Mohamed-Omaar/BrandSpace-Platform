import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolationFixtures,
  platformRoleClient,
  appRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * BATCH 7 PR C (B1.0) — THE PROPOSED TIME'S SHAPE CHECK, AGAINST REAL
 * POSTGRESQL. A post's proposed publish time is either nothing or the
 * calendar's own wall-clock form, `YYYY-MM-DDTHH:mm`; anything else is refused
 * by the database, whatever the application layer does.
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

async function insert(proposedLocalTime: string | null): Promise<string | null> {
  try {
    await platform.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: `b7 proposed ${randomUUID().slice(0, 6)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'DRAFT',
        createdByUserId: fixtures.a.userId,
        proposedLocalTime,
      } as never,
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('B1.0 — content_item_proposed_local_time_shape', () => {
  it('admits no time, and the calendar wall-clock form', async () => {
    expect(await insert(null)).toBeNull();
    expect(await insert('2026-10-20T09:30')).toBeNull();
  });

  it('refuses any other shape', async () => {
    for (const bad of ['2026-10-20', '2026-10-20 09:30', '2026-10-20T09:30:00', '09:30', '']) {
      expect(await insert(bad), bad).toContain('content_item_proposed_local_time_shape');
    }
  });
});
