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

async function insert(
  proposedLocalTime: string | null,
  // Option B: a stored time is a PICK (the CHECK below), so the shape tests say so.
  publishChoice: 'NONE' | 'PICK' | 'AFTER_APPROVAL' = proposedLocalTime === null ? 'NONE' : 'PICK',
): Promise<string | null> {
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
        publishChoice,
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

describe('Option B — content_item_publish_choice_time', () => {
  it('admits nothing chosen, a picked time, and "right after approval" with no time', async () => {
    expect(await insert(null, 'NONE')).toBeNull();
    expect(await insert('2026-10-20T09:30', 'PICK')).toBeNull();
    expect(await insert(null, 'AFTER_APPROVAL')).toBeNull();
  });

  it('refuses a time without PICK, and PICK without a time', async () => {
    for (const [time, choice] of [
      ['2026-10-20T09:30', 'NONE'],
      ['2026-10-20T09:30', 'AFTER_APPROVAL'],
      [null, 'PICK'],
    ] as const) {
      expect(await insert(time, choice), `${time} ${choice}`).toContain(
        'content_item_publish_choice_time',
      );
    }
  });

  it('defaults an insert that does not name it to NONE', async () => {
    const row = await platform.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        title: `b7 default ${randomUUID().slice(0, 6)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'DRAFT',
        createdByUserId: fixtures.a.userId,
      } as never,
      select: { publishChoice: true, proposedLocalTime: true },
    });
    expect(row).toEqual({ publishChoice: 'NONE', proposedLocalTime: null });
  });
});
