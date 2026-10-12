import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AnalyticsInsightService,
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attentionItems, ATTENTION_NAMED } from '../../apps/dashboard/src/server/command-center';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PR E (D-496) — HOME 1, 2 AND 4, AGAINST REAL POSTGRESQL AND RLS.
 *
 *   - "Needs you" names the failed posts, at most ATTENTION_NAMED of them, and
 *     only its own workspace's: the names are a read, so another workspace's
 *     failures are neither counted nor named;
 *   - each named failed post carries its failed jobs, for "Retry" in place;
 *   - "Not now" (`snooze`) hides a finding for the configured days without
 *     deciding it, writes `insight.snoozed`, and cannot reach another
 *     workspace's finding — that is the same "not found" as a missing one;
 *   - a snoozed finding is not counted by "insights-new" until its time passes.
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

const policy = parseAnalyticsPolicy(defaultPayload('analytics'));

function session(workspaceId: string, permissionKeys: readonly string[]): CustomerWorkspaceContext {
  return {
    workspaceId,
    workspaceName: 'Fixture',
    workspaceSlug: 'fixture',
    workspaceStatus: 'ACTIVE',
    roleKey: 'workspace_owner',
    roleNameEn: 'Owner',
    roleNameAr: 'مالك',
    permissionKeys: [...permissionKeys],
    brandScope: [],
  } as CustomerWorkspaceContext;
}

function insights(db: TenantScopedClient, workspaceId: string, now: Date) {
  return new AnalyticsInsightService({
    db,
    workspaceId,
    policy,
    queries: new AnalyticsQueryService({
      db,
      workspaceId,
      policy,
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    // `review` never calls a model.
    gateway: {} as never,
    clock: { now: () => now },
  });
}

/** A failed post in workspace A, with one failed job on its slot. */
async function failedPostInA(title: string, at: Date): Promise<string> {
  const a = fixtures.a;
  const item = await platform.contentItem.create({
    data: { workspaceId: a.workspaceId, brandId: a.brandId, title, status: 'DRAFT' },
  });
  const slot = await platform.calendarSlot.create({
    data: {
      workspaceId: a.workspaceId,
      brandId: a.brandId,
      contentItemId: item.id,
      scheduledAtUtc: at,
      scheduledLocalTime: at.toISOString().slice(0, 16),
      timezone: 'UTC',
      status: 'FAILED',
      platformKeys: ['instagram'],
    },
  });
  return slot.id;
}

describe('PR E — "Needs you" names the failed posts (Home 1)', () => {
  it('names at most three, newest first, counts the rest, and only its own', async () => {
    const base = Date.UTC(2031, 0, 1, 9);
    const run = randomUUID().slice(0, 6);
    const slots: string[] = [];
    for (let index = 0; index < ATTENTION_NAMED + 2; index += 1) {
      slots.push(
        await failedPostInA(`pr-e failed ${run} ${index}`, new Date(base + index * 3_600_000)),
      );
    }

    const own = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        attentionItems(db, session(fixtures.a.workspaceId, ['content.read', 'publishing.read'])),
      { prisma: app },
    );
    const failed = own.find((item) => item.kind === 'publishing-failed');
    expect(failed?.entries?.length).toBe(ATTENTION_NAMED);
    expect(failed!.count).toBeGreaterThanOrEqual(ATTENTION_NAMED + 2);
    // Newest first: the last three made are the ones named.
    expect(failed!.entries!.map((entry) => entry.id)).toEqual(
      slots.slice(-ATTENTION_NAMED).reverse(),
    );
    expect(failed!.entries![0]!.title).toBe(`pr-e failed ${run} ${ATTENTION_NAMED + 1}`);
    expect(failed!.entries![0]!.platformKeys).toEqual(['instagram']);

    const other = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        attentionItems(db, session(fixtures.b.workspaceId, ['content.read', 'publishing.read'])),
      { prisma: app },
    );
    const named = other.flatMap((item) => item.entries ?? []);
    for (const id of slots) expect(named.map((entry) => entry.id)).not.toContain(id);
    expect(JSON.stringify(other)).not.toContain(`pr-e failed ${run}`);
  });

  it("carries the slot's failed jobs, and only failed ones (Home 2)", async () => {
    const slotId = await failedPostInA(
      `pr-e retry ${randomUUID().slice(0, 6)}`,
      new Date(Date.UTC(2032, 0, 1)),
    );
    const slot = await platform.calendarSlot.findUniqueOrThrow({ where: { id: slotId } });
    const job = await platform.publishJob.findFirst({ where: { calendarSlotId: slotId } });
    // No job is created by the fixture; the entry says so rather than inventing one.
    expect(job).toBeNull();
    const items = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        attentionItems(db, session(fixtures.a.workspaceId, ['content.read', 'publishing.read'])),
      { prisma: app },
    );
    const entry = items
      .find((item) => item.kind === 'publishing-failed')
      ?.entries?.find((candidate) => candidate.id === slot.id);
    expect(entry?.failedJobs).toEqual([]);
  });
});

describe('PR E — "Not now" on a noticed finding (Home 4)', () => {
  async function findingIn(workspaceId: string, brandId: string, status: 'NEW' | 'SEEN' = 'NEW') {
    return platform.insight.create({
      data: {
        workspaceId,
        brandId,
        type: 'RECOMMENDATION',
        status,
        basis: 'OWN_PERFORMANCE',
        title: { en: `pr-e finding ${randomUUID().slice(0, 6)}` },
        body: {},
        periodStart: new Date('2031-05-01T00:00:00.000Z'),
        periodEnd: new Date('2031-06-01T00:00:00.000Z'),
      } as never,
      select: { id: true, status: true },
    });
  }

  it('hides it for the configured days, keeps its status, and audits it', async () => {
    const now = new Date('2031-06-01T10:00:00.000Z');
    const finding = await findingIn(fixtures.a.workspaceId, fixtures.a.brandId);
    const result = await withWorkspace(
      fixtures.a.workspaceId,
      (db) =>
        insights(db, fixtures.a.workspaceId, now).review({
          insightId: finding.id,
          decision: 'snooze',
          actorUserId: fixtures.a.userId,
          brandScope: [],
        }),
      { prisma: app },
    );
    expect(result.status).toBe('NEW');
    expect(policy.insightSnoozeDays).toBe(7);
    expect((result as { snoozedUntil: Date | null }).snoozedUntil?.toISOString()).toBe(
      new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    );
    const audit = await platform.auditEvent.findFirst({
      where: {
        workspaceId: fixtures.a.workspaceId,
        action: 'insight.snoozed',
        resourceId: finding.id,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("cannot reach another workspace's finding: the same not-found as a missing one", async () => {
    const finding = await findingIn(fixtures.a.workspaceId, fixtures.a.brandId);
    const attempt = (insightId: string) =>
      withWorkspace(
        fixtures.b.workspaceId,
        (db) =>
          insights(db, fixtures.b.workspaceId, new Date()).review({
            insightId,
            decision: 'snooze',
            actorUserId: fixtures.b.userId,
            brandScope: [],
          }),
        { prisma: app },
      ).then(
        () => 'snoozed',
        (error: unknown) => String((error as { code?: string }).code ?? (error as Error).message),
      );
    const crossed = await attempt(finding.id);
    const missing = await attempt(randomUUID());
    expect(crossed).not.toBe('snoozed');
    expect(crossed).toBe(missing);
    const row = await platform.insight.findUniqueOrThrow({ where: { id: finding.id } });
    expect((row as { snoozedUntil: Date | null }).snoozedUntil).toBeNull();
  });

  it('is not counted by "insights-new" until its time passes', async () => {
    const own = fixtures.a.workspaceId;
    const count = async () =>
      (
        await withWorkspace(own, (db) => attentionItems(db, session(own, ['strategy.read'])), {
          prisma: app,
        })
      ).find((item) => item.kind === 'insights-new')?.count ?? 0;
    const finding = await findingIn(own, fixtures.a.brandId);
    const before = await count();
    await platform.insight.update({
      where: { id: finding.id },
      data: { snoozedUntil: new Date(Date.now() + 86_400_000) } as never,
    });
    expect(await count()).toBe(before - 1);
    await platform.insight.update({
      where: { id: finding.id },
      data: { snoozedUntil: new Date(Date.now() - 1_000) } as never,
    });
    expect(await count()).toBe(before);
  });
});
