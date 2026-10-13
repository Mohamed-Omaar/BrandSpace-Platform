import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import type { ScheduleQuota } from './calendar';

/**
 * B-pre 2 (owner review of #80) — A POST WHOSE TIME COMES WHILE NONE OF ITS
 * CHANNELS CAN BE CONNECTED IS HELD, NOT FAILED.
 *
 * Q8 (D-510) refuses to put a post on its way while no channel can be
 * connected. A post scheduled BEFORE that rule existed — or before its last
 * platform was switched off — is still SCHEDULED, and at its time it used to
 * sit there: skipped by the publisher on every pass, never published, never
 * told. It must not fail either: nothing went wrong with the post.
 *
 * SO IT IS HELD, through the path a time-zone change already uses for a post
 * that cannot keep its time (D-334), with every one of its rules:
 *
 *   - the slot goes back to PLANNED on its own day, in ONE conditional update
 *     that also moves `rescheduleAttempt` on, so a post the publisher claimed a
 *     moment ago is not touched and a retried hold does nothing;
 *   - its scheduling quota is refunded under the key a cancel uses, once;
 *   - the post goes back to APPROVED when its latest review approved it, and to
 *     DRAFT otherwise — and its time is kept as its proposed time;
 *   - it is audited, as SYSTEM. No notice is sent: there is no failure to
 *     report, and the calendar and the post say "Can't publish yet — no
 *     connected channel" for as long as it is true.
 *
 * Nothing re-arms a PLANNED slot except a person moving it, which runs every
 * scheduling rule again (`ContentCalendarService.reschedule` → `#replan`),
 * Q8 included. So switching a platform on later never publishes a held post
 * late on its own.
 *
 * A post with at least one channel that can be connected is not held: it goes
 * out on that channel, exactly as before.
 */
export async function holdPostWithoutChannel(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly slotId: string;
    /** The platform keys, of those given, that cannot be connected at all. */
    readonly notConnectable: (platformKeys: readonly string[]) => Promise<readonly string[]>;
    readonly quota: Pick<ScheduleQuota, 'refund'>;
  },
): Promise<boolean> {
  const { workspaceId, slotId } = input;
  const slot = await db.calendarSlot.findFirst({
    where: { id: slotId, workspaceId, status: 'SCHEDULED' },
  });
  if (!slot) return false;

  // The item's variants as they are NOW — what the publisher matches against.
  const variants = await db.contentVariant.findMany({
    where: { contentItemId: slot.contentItemId, workspaceId },
    select: { platformKey: true },
  });
  const keys = [...new Set(variants.map((variant) => variant.platformKey))];
  if (keys.length === 0) return false;
  if ((await input.notConnectable(keys)).length !== keys.length) return false;

  const held = await db.calendarSlot.updateMany({
    where: {
      id: slot.id,
      workspaceId,
      status: 'SCHEDULED',
      rescheduleAttempt: slot.rescheduleAttempt,
      scheduledAtUtc: slot.scheduledAtUtc,
    },
    data: { status: 'PLANNED', rescheduleAttempt: { increment: 1 } },
  });
  if (held.count === 0) return false;

  // The same derived key a cancel and a time-zone change use: refunded once.
  if (slot.usageIdempotencyKey) await input.quota.refund(`${slot.usageIdempotencyKey}:refund`);

  const item = await db.contentItem.findFirst({
    where: { id: slot.contentItemId, workspaceId },
    select: { status: true },
  });
  let toStatus: string | null = null;
  if (item?.status === 'SCHEDULED') {
    const approval = await db.approval.findFirst({
      where: { contentItemId: slot.contentItemId, workspaceId },
      orderBy: { cycle: 'desc' },
      select: { status: true },
    });
    toStatus = approval?.status === 'APPROVED' ? 'APPROVED' : 'DRAFT';
    await db.contentItem.updateMany({
      where: { id: slot.contentItemId, workspaceId, status: 'SCHEDULED' },
      data: {
        status: toStatus === 'APPROVED' ? 'APPROVED' : 'DRAFT',
        // Its time is kept as its proposal (D-510: a proposed time is kept).
        proposedLocalTime: slot.scheduledLocalTime,
        publishChoice: 'PICK',
      },
    });
  }

  await writeAuditEvent(db, workspaceId, {
    action: 'content.rescheduled',
    actorType: 'SYSTEM',
    resourceType: 'CalendarSlot',
    resourceId: slot.id,
    brandId: slot.brandId,
    after: {
      reason: 'no_connectable_channel',
      toStatus: 'PLANNED',
      localTime: slot.scheduledLocalTime,
      timezone: slot.timezone,
      channels: keys,
      ...(toStatus ? { itemStatus: toStatus } : {}),
    },
  });
  return true;
}
