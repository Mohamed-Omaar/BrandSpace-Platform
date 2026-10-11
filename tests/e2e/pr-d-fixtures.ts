import { createHash } from 'node:crypto';
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
