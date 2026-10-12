import { randomUUID } from 'node:crypto';
import type { OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/** PR E — fixtures the PR E specs share, written as the product writes them. */

/**
 * A post that failed on Instagram half an hour ago — inside the lateness
 * tolerance, with a failure a retry can fix — in the test's own workspace: a
 * channel, the post, its variant, the FAILED slot and its FAILED job.
 */
export async function failedPost(
  own: OwnWorkspace,
  title: string,
  minutesAgo = 30,
): Promise<{ slotId: string; jobId: string }> {
  return withPlatformPrisma(async (prisma) => {
    const run = randomUUID().slice(0, 8);
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const base = { workspaceId: own.workspaceId, brandId: own.brandId };
    const connection = await prisma.socialConnection.create({
      data: {
        ...base,
        provider: 'INSTAGRAM',
        externalAccountId: `pr-e-${run}`,
        displayName: 'pr-e',
        targetKind: 'MOCK',
        status: 'ACTIVE',
        connectedByUserId: own.ownerId,
        connectedAt: new Date(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: {
        ...base,
        title,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'FAILED',
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
        scheduledLocalTime: at.toISOString().slice(0, 16),
        timezone: 'UTC',
        status: 'FAILED',
        platformKeys: ['instagram'],
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    const job = await prisma.publishJob.create({
      data: {
        ...base,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: 'INSTAGRAM',
        status: 'FAILED',
        idempotencyKey: `pr-e-${run}`,
        scheduledAtUtc: at,
        maxAttempts: 3,
        attemptCount: 1,
        completedAt: at,
        failureClass: 'CONTENT_REJECTED',
        failureCode: 'pr-e-fixture',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    return { slotId: slot.id, jobId: job.id };
  });
}

/** A noticed suggestion on the test's own brand, naming a format or not. */
export async function noticedSuggestion(
  own: OwnWorkspace,
  title: string,
  suggestedFormat?: string,
): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const now = Date.now();
    const row = await prisma.insight.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        type: 'RECOMMENDATION',
        status: 'NEW',
        basis: 'OWN_PERFORMANCE',
        title: { en: title, ar: title },
        body: suggestedFormat ? { suggestedFormat } : {},
        periodStart: new Date(now - 28 * 86_400_000),
        periodEnd: new Date(now),
        confidenceMilli: 900,
      },
      select: { id: true },
    });
    return row.id;
  });
}
