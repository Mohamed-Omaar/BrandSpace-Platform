import { createHash, randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { hashPassword } from '@brandspace/auth';
import { DASHBOARD_BASE_URL } from './apps';
import type { OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/** PR D — fixtures the PR D specs share, written as the product writes them. */

const DAY = 86_400_000;

/**
 * One published Instagram post with its own readings — engagements, reach and
 * saves, never clicks (Instagram does not publish them) — in the test's own
 * workspace. Written as the product writes them: a channel, the post, its
 * variant and slot, the published job and the observations.
 */
export async function publishedPost(
  own: OwnWorkspace,
  title: string,
  options: { readonly pillar?: string; readonly engagements?: number } = {},
): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const run = Date.now().toString(36);
    const at = new Date(`${new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10)}T14:00:00Z`);
    const base = { workspaceId: own.workspaceId, brandId: own.brandId };
    const connection = await prisma.socialConnection.create({
      data: {
        ...base,
        provider: 'INSTAGRAM',
        externalAccountId: `pr-d-${run}`,
        displayName: 'pr-d',
        targetKind: 'MOCK',
        status: 'ACTIVE',
        connectedByUserId: own.ownerId,
        connectedAt: new Date(Date.now() - 30 * DAY),
      },
      select: { id: true, externalAccountId: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        ...base,
        title,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'PUBLISHED',
        pillar: options.pillar ?? null,
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        ...base,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: title,
        characterCount: title.length,
        validationState: 'VALID',
      },
      select: { id: true },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        ...base,
        contentItemId: item.id,
        scheduledAtUtc: at,
        scheduledLocalTime: `${at.toISOString().slice(0, 10)}T14:00`,
        timezone: 'UTC',
        status: 'PUBLISHED',
        platformKeys: ['instagram'],
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    await prisma.publishJob.create({
      data: {
        ...base,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: 'INSTAGRAM',
        status: 'PUBLISHED',
        idempotencyKey: `pr-d-${run}`,
        scheduledAtUtc: at,
        maxAttempts: 3,
        attemptCount: 1,
        completedAt: at,
        publishedAt: at,
        externalPostId: `pr-d-${run}`,
        createdByUserId: own.ownerId,
      },
    });
    const periodStart = new Date(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
    for (const [metricKey, value] of [
      ['engagements', options.engagements ?? 42],
      ['reach', 900],
      ['saves', 7],
    ] as const satisfies readonly (readonly [string, number])[]) {
      await prisma.metricObservation.create({
        data: {
          ...base,
          socialConnectionId: connection.id,
          provider: 'INSTAGRAM',
          subjectType: 'POST',
          subjectExternalId: `pr-d-post-${run}`,
          contentItemId: item.id,
          metricKey,
          granularity: 'DAY',
          periodStart,
          periodEnd: new Date(periodStart.getTime() + DAY),
          value: BigInt(value),
          unit: 'COUNT',
          observedAt: new Date(periodStart.getTime() + DAY),
          sourceKind: 'MOCK',
          sourceVersion: 'e2e-pr-d-1',
          observationKey: createHash('sha256')
            .update([own.workspaceId, run, metricKey].join('|'))
            .digest('hex'),
        },
      });
    }
    return item.id;
  });
}

/**
 * Daily account engagements for the test's own workspace, oldest first, the
 * last value for yesterday — enough for the anomaly rule (a 14-day baseline)
 * to find a recent shift when the last values jump.
 */
export async function dailyEngagements(
  own: OwnWorkspace,
  values: readonly number[],
): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const run = Date.now().toString(36);
    const connection = await prisma.socialConnection.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        provider: 'INSTAGRAM',
        externalAccountId: `pr-d-daily-${run}`,
        displayName: 'pr-d-daily',
        targetKind: 'MOCK',
        status: 'ACTIVE',
        connectedByUserId: own.ownerId,
        connectedAt: new Date(Date.now() - 60 * DAY),
      },
      select: { id: true, externalAccountId: true },
    });
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    for (const [index, value] of values.entries()) {
      const periodStart = new Date(today.getTime() - (values.length - index) * DAY);
      await prisma.metricObservation.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          socialConnectionId: connection.id,
          provider: 'INSTAGRAM',
          subjectType: 'ACCOUNT',
          subjectExternalId: connection.externalAccountId,
          metricKey: 'engagements',
          granularity: 'DAY',
          periodStart,
          periodEnd: new Date(periodStart.getTime() + DAY),
          value: BigInt(value),
          unit: 'COUNT',
          observedAt: new Date(periodStart.getTime() + DAY),
          sourceKind: 'MOCK',
          sourceVersion: 'e2e-pr-d-1',
          observationKey: createHash('sha256')
            .update([own.workspaceId, run, String(index)].join('|'))
            .digest('hex'),
        },
      });
    }
  });
}

/** PR D (review of #75): how many businesses the many-workspaces person owns. */
export const WORKSPACE_COUNT = 12;

/** A person owning `WORKSPACE_COUNT` workspaces; the first on an active plan with room for more. */
export async function manyWorkspaces(label: string): Promise<{ email: string; password: string }> {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-many-ws-${suffix}@brandspace.test`;
  const password = `e2e-${randomUUID()}`;
  await withPlatformPrisma(async (prisma) => {
    // Whichever plan catalogue is active, one of its plans that states no
    // workspace ceiling, or one above this person's count.
    const active = await prisma.configurationVersion.findFirstOrThrow({
      where: { domain: 'plans', status: 'ACTIVE' },
      orderBy: { activatedAt: 'desc' },
      select: { payload: true },
    });
    const plans = ((active.payload as { plans?: unknown[] }).plans ?? []) as Array<{
      key?: string;
      status?: string;
      quotas?: { workspaces?: number | null };
    }>;
    const plan = plans.find(
      (candidate) =>
        candidate.key &&
        candidate.status === 'active' &&
        (candidate.quotas?.workspaces === undefined ||
          candidate.quotas.workspaces === null ||
          candidate.quotas.workspaces > WORKSPACE_COUNT),
    );
    if (!plan?.key) throw new Error('No active plan leaves room for another workspace.');
    const user = await prisma.user.create({
      data: {
        email,
        name: `Many ${suffix}`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword(password),
        locale: 'EN',
        timezone: 'UTC',
      },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    for (let index = 1; index <= WORKSPACE_COUNT; index += 1) {
      const workspaceId = randomUUID();
      await prisma.workspace.create({
        data: {
          id: workspaceId,
          workspaceId,
          slug: `e2e-${label}-${suffix}-${index}`,
          name: `Business ${String(index).padStart(2, '0')} ${suffix}`,
          ownerUserId: user.id,
          status: 'ACTIVE',
          country: 'US',
          defaultLocale: 'EN',
          timezone: 'UTC',
          currency: 'USD',
          ...(index === 1 ? { planKey: plan.key } : {}),
        },
      });
      await prisma.membership.create({
        data: {
          workspaceId,
          userId: user.id,
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
    }
  });
  return { email, password };
}

export async function signInToList(page: Page, email: string, password: string, locale: string) {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/workspaces`));
}
