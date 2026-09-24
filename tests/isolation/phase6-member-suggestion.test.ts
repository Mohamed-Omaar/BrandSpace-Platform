import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemberSuggestionService, parseContentPolicy } from '@brandspace/content';
import { defaultPayload } from '@brandspace/config';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 FINAL · D-277 §9, D-295 — NOTICED PREFERENCES AND THE DECISIONS ON THEM.
 *
 * Against real PostgreSQL:
 *   - a preference is noticed only from THIS person's own audited edits on
 *     THIS brand, past the configured thresholds, and only on generated words;
 *   - ACCEPT is refused unless it is noticed now — a crafted form cannot
 *     manufacture a default;
 *   - a decision hides the suggestion; "not now" hides it until it is due;
 *   - `member_suggestion` rows never cross a workspace.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let otherUser: string;

const policy = parseContentPolicy(defaultPayload('content'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const service =
  (clockAt?: Date) =>
  <T>(fn: (s: MemberSuggestionService) => Promise<T>) =>
    inA((db) =>
      fn(
        new MemberSuggestionService({
          db,
          workspaceId: fixtures.a.workspaceId,
          policy,
          ...(clockAt ? { clock: { now: () => clockAt } } : {}),
        }),
      ),
    );

/** Audited inline edits, as `applyTool` writes them. */
async function edits(input: {
  userId: string;
  action: 'content.variant.shorten' | 'content.variant.tone';
  platformKey: string;
  posts: number;
  perPost: number;
  afterGeneration?: boolean;
  tone?: string;
  brandId?: string;
}): Promise<void> {
  await inA(async (db) => {
    for (let post = 0; post < input.posts; post += 1) {
      const variantId = randomUUID();
      for (let n = 0; n < input.perPost; n += 1) {
        await db.auditEvent.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            actorType: 'USER',
            actorId: input.userId,
            action: input.action,
            resourceType: 'ContentVariant',
            resourceId: variantId,
            brandId: input.brandId ?? fixtures.a.brandId,
            after: {
              platformKey: input.platformKey,
              afterGeneration: input.afterGeneration ?? true,
              ...(input.tone ? { tone: input.tone } : {}),
            },
          },
        });
      }
    }
  });
}

const noticed = (userId = fixtures.a.userId, brandScope: readonly string[] = []) =>
  service()((s) => s.noticedPreferences({ userId, brandId: fixtures.a.brandId, brandScope }));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  // Another member's edits: an audit actor who is not the reader. Audit rows
  // carry an actor id, not a foreign key, so any other id stands for them.
  otherUser = randomUUID();
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

describe('D-295 · what counts as a preference', () => {
  it('one post edited many times is not a habit; several posts are', async () => {
    await edits({
      userId: fixtures.a.userId,
      action: 'content.variant.shorten',
      platformKey: 'linkedin',
      posts: 1,
      perPost: 6,
    });
    expect((await noticed()).map((row) => row.key)).not.toContain('shorter:linkedin');
    await edits({
      userId: fixtures.a.userId,
      action: 'content.variant.shorten',
      platformKey: 'linkedin',
      posts: 2,
      perPost: 1,
    });
    const found = (await noticed()).find((row) => row.key === 'shorter:linkedin');
    expect(found?.posts).toBe(3);
  });

  it('editing your OWN words is not evidence about the generator', async () => {
    await edits({
      userId: fixtures.a.userId,
      action: 'content.variant.shorten',
      platformKey: 'x',
      posts: 5,
      perPost: 1,
      afterGeneration: false,
    });
    expect((await noticed()).map((row) => row.key)).not.toContain('shorter:x');
  });

  it('a tone outside the closed set never becomes a key', async () => {
    await edits({
      userId: fixtures.a.userId,
      action: 'content.variant.tone',
      platformKey: 'instagram',
      posts: 5,
      perPost: 1,
      tone: 'sarcastic',
    });
    expect((await noticed()).some((row) => row.key.startsWith('tone:'))).toBe(false);
  });

  it('another member’s edits are theirs, not yours', async () => {
    await edits({
      userId: otherUser,
      action: 'content.variant.shorten',
      platformKey: 'facebook',
      posts: 5,
      perPost: 1,
    });
    expect((await noticed()).map((row) => row.key)).not.toContain('shorter:facebook');
  });

  it('a brand outside the member’s scope notices nothing', async () => {
    expect(await noticed(fixtures.a.userId, [randomUUID()])).toEqual([]);
  });
});

describe('D-295 · decisions', () => {
  it('ACCEPT is refused for a preference that is not noticed', async () => {
    await expect(
      service()((s) =>
        s.decidePreference({
          userId: fixtures.a.userId,
          brandId: fixtures.a.brandId,
          brandScope: [],
          key: 'shorter:tiktok',
          decision: 'accept',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('accept → it is a default, audited, and no longer suggested', async () => {
    await service()((s) =>
      s.decidePreference({
        userId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        brandScope: [],
        key: 'shorter:linkedin',
        decision: 'accept',
      }),
    );
    expect(
      await service()((s) =>
        s.acceptedPreferences({ userId: fixtures.a.userId, brandId: fixtures.a.brandId }),
      ),
    ).toContain('shorter:linkedin');
    expect((await noticed()).map((row) => row.key)).not.toContain('shorter:linkedin');
    const audit = await inA((db) =>
      db.auditEvent.count({ where: { action: 'suggestion.preference.accepted' } }),
    );
    expect(audit).toBeGreaterThan(0);
  });

  it('"Not now" hides it until the snooze is due, then it comes back', async () => {
    await edits({
      userId: fixtures.a.userId,
      action: 'content.variant.tone',
      platformKey: 'instagram',
      posts: 4,
      perPost: 1,
      tone: 'friendly',
    });
    const key = 'tone:friendly:instagram';
    expect((await noticed()).map((row) => row.key)).toContain(key);
    await service()((s) =>
      s.decidePreference({
        userId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        brandScope: [],
        key,
        decision: 'snooze',
      }),
    );
    expect((await noticed()).map((row) => row.key)).not.toContain(key);
    const later = new Date(Date.now() + (policy.learning.snoozeDays + 1) * 86_400_000);
    const back = await service(later)((s) =>
      s.noticedPreferences({
        userId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        brandScope: [],
      }),
    );
    // The edits are older than the window by then only if the window is shorter
    // than the snooze; with the defaults (90 > 31) the suggestion returns.
    expect(back.map((row) => row.key)).toContain(key);
  });

  it('"Stop using" ends an accepted default and does not suggest it again', async () => {
    await service()((s) =>
      s.forgetPreference({
        userId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        key: 'shorter:linkedin',
      }),
    );
    expect(
      await service()((s) =>
        s.acceptedPreferences({ userId: fixtures.a.userId, brandId: fixtures.a.brandId }),
      ),
    ).not.toContain('shorter:linkedin');
    expect((await noticed()).map((row) => row.key)).not.toContain('shorter:linkedin');
  });
});

describe('D-295 · member_suggestion never crosses a workspace', () => {
  it('workspace B cannot read, count or change A’s decisions', async () => {
    const aRows = await inA((db) => db.memberSuggestion.count());
    expect(aRows).toBeGreaterThan(0);
    expect(await inB((db) => db.memberSuggestion.count())).toBe(0);
    const updated = await inB((db) =>
      db.memberSuggestion.updateMany({ data: { status: 'DISMISSED', snoozedUntil: null } }),
    );
    expect(updated.count).toBe(0);
  });

  it('B cannot write a row claiming A’s workspace', async () => {
    await expect(
      inB((db) =>
        db.memberSuggestion.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            userId: fixtures.a.userId,
            kind: 'PREFERENCE',
            key: 'shorter:linkedin',
            status: 'DISMISSED',
            evidenceCount: 0,
            source: 'forged',
            decidedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('only a preference can be accepted, and a snooze always has its date', async () => {
    const base = {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      userId: fixtures.a.userId,
      evidenceCount: 1,
      source: 'test',
      decidedAt: new Date(),
    };
    await expect(
      inA((db) =>
        db.memberSuggestion.create({
          data: { ...base, kind: 'WORKFLOW', key: `w.${RUN()}`, status: 'ACCEPTED' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      inA((db) =>
        db.memberSuggestion.create({
          data: { ...base, kind: 'PREFERENCE', key: `p.${RUN()}`, status: 'SNOOZED' },
        }),
      ),
    ).rejects.toThrow();
  });
});

function RUN(): string {
  return randomUUID().slice(0, 8);
}

describe('D-296 · a recurring workflow is read from real rows', () => {
  /** A post this person made on `made`, on the calendar for `planned`. */
  async function madeAndPlanned(made: Date, planned: Date, userId = fixtures.a.userId) {
    await inA(async (db) => {
      const item = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: `Weekly ${randomUUID().slice(0, 6)}`,
          status: 'SCHEDULED',
          primaryLocale: 'AR',
        },
        select: { id: true },
      });
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'AR',
          body: 'x',
        },
      });
      await db.calendarSlot.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: item.id,
          scheduledAtUtc: planned,
          scheduledLocalTime: planned.toISOString().slice(0, 16),
          timezone: 'UTC',
          status: 'PLANNED',
          platformKeys: ['instagram'],
        },
      });
      await db.auditEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          actorType: 'USER',
          actorId: userId,
          action: 'content.item.authored',
          resourceType: 'ContentItem',
          resourceId: item.id,
          brandId: fixtures.a.brandId,
          occurredAt: made,
        },
      });
    });
  }

  const weeksAgo = (weeks: number, weekday: number) => {
    const now = new Date();
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
    const today = new Date(base).getUTCDay();
    return new Date(base - ((today - weekday + 7) % 7) * 86_400_000 - weeks * 7 * 86_400_000);
  };
  const workflows = (userId = fixtures.a.userId) =>
    service()((s) => s.noticedWorkflows({ userId, brandId: fixtures.a.brandId, brandScope: [] }));

  it('three weeks is not yet a habit; four distinct weeks is', async () => {
    for (const weeks of [1, 2, 3]) {
      await madeAndPlanned(
        weeksAgo(weeks, 4),
        new Date(weeksAgo(weeks, 4).getTime() + 3 * 86_400_000),
      );
    }
    expect(await workflows()).toEqual([]);
    await madeAndPlanned(weeksAgo(4, 4), new Date(weeksAgo(4, 4).getTime() + 3 * 86_400_000));
    const found = await workflows();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: 'weekly:4:instagram:ar:0',
      createdWeekday: 4,
      slotWeekday: 0,
      repeats: 4,
    });
  });

  it('another member’s posts are not your workflow', async () => {
    expect(await workflows(randomUUID())).toEqual([]);
  });

  it('a workflow can be snoozed or dismissed, never accepted', async () => {
    await service()((s) =>
      s.decideWorkflow({
        userId: fixtures.a.userId,
        brandId: fixtures.a.brandId,
        brandScope: [],
        key: 'weekly:4:instagram:ar:0',
        decision: 'snooze',
      }),
    );
    expect(await workflows()).toEqual([]);
    await expect(
      service()((s) =>
        s.decideWorkflow({
          userId: fixtures.a.userId,
          brandId: fixtures.a.brandId,
          brandScope: [],
          key: 'weekly:1:x:en:2',
          decision: 'dismiss',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
