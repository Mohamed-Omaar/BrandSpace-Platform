import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { IsolationFixtures } from './fixtures';

/**
 * PHASE 2B-3 PR 4 — SHARED SET-UP FOR THE ANALYTICS EVENT SUITES.
 *
 * Real rows only: published posts with real publish jobs, and DAY readings in
 * `metric_observation` exactly as ingestion stores them (one row per subject,
 * metric and UTC day). The events' thresholds are configuration, so a suite
 * sets them the way an operator's activation does — an ACTIVE `automations`
 * version for the environment the scheduler runs in — and puts back whatever
 * was active before. Isolation files run one at a time (`fileParallelism:
 * false`), so no other suite sees the version in between.
 */

export const DAY = 86_400_000;
const ENVIRONMENT = 'DEVELOPMENT';

export interface Tenant {
  readonly workspaceId: string;
  readonly userId: string;
  readonly socialConnectionId: string;
}

export function tenantOf(fixtures: IsolationFixtures, side: 'a' | 'b'): Tenant {
  const t = fixtures[side];
  return { workspaceId: t.workspaceId, userId: t.userId, socialConnectionId: t.socialConnectionId };
}

/** Midnight UTC `days` days from `from`'s UTC day. */
export function utcDay(from: Date, days: number): Date {
  return new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) + days * DAY,
  );
}

/** One DAY reading of one POST subject. */
export async function reading(
  platform: PrismaClient,
  tenant: Tenant,
  input: {
    readonly brandId: string;
    readonly subject: string;
    readonly contentItemId?: string | null;
    readonly metricKey: string;
    readonly day: Date;
    readonly value: number | bigint;
    readonly granularity?: 'DAY' | 'HOUR' | 'WEEK' | 'LIFETIME';
    readonly subjectType?: 'POST' | 'ACCOUNT';
  },
): Promise<void> {
  const granularity = input.granularity ?? 'DAY';
  const periodEnd = new Date(input.day.getTime() + DAY);
  await platform.metricObservation.create({
    data: {
      workspaceId: tenant.workspaceId,
      brandId: input.brandId,
      socialConnectionId: tenant.socialConnectionId,
      provider: 'LINKEDIN',
      subjectType: input.subjectType ?? 'POST',
      subjectExternalId: input.subject,
      contentItemId: input.contentItemId ?? null,
      metricKey: input.metricKey,
      granularity,
      periodStart: input.day,
      periodEnd,
      value: BigInt(input.value),
      unit: 'COUNT',
      observedAt: periodEnd,
      sourceKind: 'PROVIDER',
      sourceVersion: 'pr4-test',
      observationKey: createHash('sha256')
        .update(
          `${input.subject}|${input.metricKey}|${granularity}|${input.day.toISOString()}|${randomUUID()}`,
        )
        .digest('hex'),
    },
  });
}

/** `total` engagements of the brand, spread one reading per day over [start, start + days). */
export async function engagementsOver(
  platform: PrismaClient,
  tenant: Tenant,
  input: {
    readonly brandId: string;
    readonly start: Date;
    readonly days: number;
    readonly total: number;
  },
): Promise<void> {
  const subject = `acct-${randomUUID().slice(0, 8)}`;
  const each = Math.floor(input.total / input.days);
  for (let i = 0; i < input.days; i += 1) {
    const value = i === input.days - 1 ? input.total - each * (input.days - 1) : each;
    await reading(platform, tenant, {
      brandId: input.brandId,
      subject,
      metricKey: 'engagements',
      day: new Date(input.start.getTime() + i * DAY),
      value,
    });
  }
}

/**
 * A post of the brand, published at `publishedAt` through a real publish job,
 * with DAY engagements and impressions on its publication day.
 */
export async function publishedPost(
  platform: PrismaClient,
  tenant: Tenant,
  input: {
    readonly brandId: string;
    readonly publishedAt: Date;
    readonly engagements: number;
    readonly impressions: number;
    readonly status?: 'PUBLISHED' | 'ARCHIVED';
    readonly deleted?: boolean;
  },
): Promise<string> {
  const item = await platform.contentItem.create({
    data: {
      workspaceId: tenant.workspaceId,
      brandId: input.brandId,
      title: `Post ${randomUUID().slice(0, 6)}`,
      contentType: 'POST',
      primaryLocale: 'EN',
      status: input.status ?? 'PUBLISHED',
      createdByUserId: tenant.userId,
      ...(input.deleted ? { deletedAt: new Date() } : {}),
    } as never,
    select: { id: true },
  });
  await publishJob(platform, tenant, {
    brandId: input.brandId,
    contentItemId: item.id,
    publishedAt: input.publishedAt,
  });
  const subject = `post-${randomUUID().slice(0, 8)}`;
  const day = utcDay(input.publishedAt, 0);
  for (const [metricKey, value] of [
    ['engagements', input.engagements],
    ['impressions', input.impressions],
  ] as const) {
    await reading(platform, tenant, {
      brandId: input.brandId,
      subject,
      contentItemId: item.id,
      metricKey,
      day,
      value,
    });
  }
  return item.id;
}

/** One more PUBLISHED job for an existing post: a real slot, variant and job. */
export async function publishJob(
  platform: PrismaClient,
  tenant: Tenant,
  input: { readonly brandId: string; readonly contentItemId: string; readonly publishedAt: Date },
): Promise<void> {
  const variant =
    (await platform.contentVariant.findFirst({
      where: { contentItemId: input.contentItemId },
      select: { id: true },
    })) ??
    (await platform.contentVariant.create({
      data: {
        workspaceId: tenant.workspaceId,
        brandId: input.brandId,
        contentItemId: input.contentItemId,
        platformKey: 'linkedin',
        locale: 'EN',
      } as never,
      select: { id: true },
    }));
  // One live slot per post (`calendar_slot_one_live_per_item`): a second
  // publication of the same post is a second job on that slot.
  const existingSlot = await platform.calendarSlot.findFirst({
    where: { contentItemId: input.contentItemId, status: { not: 'CANCELLED' } },
    select: { id: true },
  });
  const slot =
    existingSlot ??
    (await platform.calendarSlot.create({
      data: {
        workspaceId: tenant.workspaceId,
        brandId: input.brandId,
        contentItemId: input.contentItemId,
        scheduledAtUtc: input.publishedAt,
        scheduledLocalTime: input.publishedAt.toISOString().slice(0, 16),
        timezone: 'UTC',
        status: 'PUBLISHED',
      },
      select: { id: true },
    }));
  await platform.publishJob.create({
    data: {
      workspaceId: tenant.workspaceId,
      brandId: input.brandId,
      calendarSlotId: slot.id,
      contentItemId: input.contentItemId,
      contentVariantId: variant.id,
      socialConnectionId: tenant.socialConnectionId,
      provider: 'LINKEDIN',
      status: 'PUBLISHED',
      idempotencyKey: `pr4-${randomUUID()}`,
      scheduledAtUtc: input.publishedAt,
      publishedAt: input.publishedAt,
      externalPostId: `ext-${randomUUID()}`,
      attemptCount: 1,
      maxAttempts: 5,
      createdByUserId: tenant.userId,
    },
  });
}

// ---------------------------------------------------------------------------
// The events' thresholds, set as an operator's activation sets them
// ---------------------------------------------------------------------------

let previousActive: string[] = [];
let ours: string[] = [];

export async function setEventThresholds(platform: PrismaClient, events: unknown): Promise<void> {
  const author = await platform.platformUser.findFirstOrThrow({ select: { id: true } });
  const active = await platform.configurationVersion.findMany({
    where: { domain: 'automations', environment: ENVIRONMENT, status: 'ACTIVE' },
    select: { id: true },
  });
  const theirs = active.map((row) => row.id).filter((id) => !ours.includes(id));
  previousActive = [...new Set([...previousActive, ...theirs])];
  await platform.configurationVersion.updateMany({
    where: { id: { in: active.map((row) => row.id) } },
    data: { status: 'SUPERSEDED' },
  });
  const payload = { events };
  const created = await platform.configurationVersion.create({
    data: {
      domain: 'automations',
      environment: ENVIRONMENT,
      status: 'ACTIVE',
      versionNumber: Math.floor(Date.now() / 1000) + ours.length + 1,
      payload: payload as never,
      payloadChecksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      createdByPlatformUserId: author.id,
      changeReason: 'phase 2b-3 pr 4 isolation test',
    },
    select: { id: true },
  });
  ours.push(created.id);
}

/** Remove every version this process activated and restore what was active before. */
export async function restoreEventThresholds(platform: PrismaClient): Promise<void> {
  if (ours.length > 0) {
    await platform.configurationVersion.deleteMany({ where: { id: { in: ours } } });
  }
  if (previousActive.length > 0) {
    await platform.configurationVersion.updateMany({
      where: { id: { in: previousActive } },
      data: { status: 'ACTIVE' },
    });
  }
  ours = [];
  previousActive = [];
}
