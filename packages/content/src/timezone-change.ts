import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { NotificationService } from '@brandspace/notifications';
import { AppError, systemClock, type Clock } from '@brandspace/shared';
import type { ScheduleQuota } from './calendar';
import { instantForIntent, isKnownTimeZone } from './timezone';

/**
 * G5 / Q22 (prototype v94 Phase 2B-1, D-334) — CHANGING THE WORKSPACE'S TIME
 * ZONE KEEPS EVERY PLANNED POST AT ITS LOCAL CLOCK TIME.
 *
 * A post planned for "Tuesday 09:00" is still planned for Tuesday 09:00 — in
 * the new zone. Its instant is recomputed from the local time it was planned
 * at (`scheduledLocalTime`), the zone it belongs to is updated, and the move is
 * audited slot by slot, all in the caller's ONE transaction with the zone
 * itself. Only PLANNED and SCHEDULED posts that have not reached their time
 * move; anything publishing, published or failed is history and is untouched.
 *
 * A POST THAT WOULD THEN BE IN THE PAST — or inside the minimum lead time —
 * cannot keep its time. It goes back to PLANNED, its scheduling quota is
 * refunded, it is listed in Settings before the change is saved, and its author
 * is told in the app, so it is never silently published late or dropped.
 */

/** What changing to a zone would do to one post. */
export interface TimezoneChangeEffect {
  readonly slotId: string;
  readonly contentItemId: string;
  readonly brandId: string;
  readonly title: string;
  /** The wall-clock the post was planned at, kept. */
  readonly localTime: string;
  readonly authorUserId: string | null;
  readonly fromUtc: Date;
  readonly toUtc: Date;
  /** `kept`: same clock time in the new zone. `unplanned`: too late for it — back to PLANNED. */
  readonly outcome: 'kept' | 'unplanned';
}

const MOVABLE = ['PLANNED', 'SCHEDULED'] as const;

/**
 * What changing to `toZone` would do, read-only — the list Settings shows
 * before anything is saved. Inside the workspace's RLS context.
 */
export async function timezoneChangeEffects(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly toZone: string;
    readonly now: Date;
    readonly minLeadMinutes: number;
  },
): Promise<TimezoneChangeEffect[]> {
  if (!isKnownTimeZone(input.toZone)) {
    throw new AppError('VALIDATION_FAILED', 'That is not a time zone.');
  }
  const slots = await db.calendarSlot.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: { in: [...MOVABLE] },
      scheduledAtUtc: { gt: input.now },
    },
    orderBy: { scheduledAtUtc: 'asc' },
    select: {
      id: true,
      contentItemId: true,
      brandId: true,
      scheduledAtUtc: true,
      scheduledLocalTime: true,
      createdByUserId: true,
    },
  });
  if (slots.length === 0) return [];
  const items = await db.contentItem.findMany({
    where: { workspaceId: input.workspaceId, id: { in: slots.map((slot) => slot.contentItemId) } },
    select: { id: true, title: true },
  });
  const titles = new Map(items.map((item) => [item.id, item.title] as const));
  const earliest = input.now.getTime() + input.minLeadMinutes * 60_000;

  return slots.map((slot) => {
    const toUtc = instantForIntent(slot.scheduledLocalTime, input.toZone) ?? slot.scheduledAtUtc;
    return {
      slotId: slot.id,
      contentItemId: slot.contentItemId,
      brandId: slot.brandId,
      title: titles.get(slot.contentItemId) ?? '',
      localTime: slot.scheduledLocalTime,
      authorUserId: slot.createdByUserId,
      fromUtc: slot.scheduledAtUtc,
      toUtc,
      outcome: toUtc.getTime() < earliest ? 'unplanned' : 'kept',
    };
  });
}

export interface TimezoneChangeActor {
  readonly type: 'USER' | 'PLATFORM_USER';
  readonly id: string;
}

export class WorkspaceTimezoneService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #quota: Pick<ScheduleQuota, 'refund'>;
  readonly #clock: Clock;

  constructor(options: {
    readonly db: TenantScopedClient;
    readonly workspaceId: string;
    /** Refunds the quota of a post sent back to PLANNED. */
    readonly quota: Pick<ScheduleQuota, 'refund'>;
    readonly clock?: Clock;
  }) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#quota = options.quota;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Change the zone, inside the caller's transaction. The workspace row is
   * locked first, so two changes at once cannot both recompute from the same
   * starting zone. A change to the zone it already has does nothing.
   */
  async change(input: {
    readonly toZone: string;
    readonly actor: TimezoneChangeActor;
    readonly minLeadMinutes: number;
  }): Promise<{ readonly from: string; readonly effects: readonly TimezoneChangeEffect[] }> {
    const workspaceId = this.#workspaceId;
    await this.#db
      .$queryRaw`SELECT "id" FROM "workspace" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
    const workspace = await this.#db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    const from = workspace.timezone;
    if (from === input.toZone) return { from, effects: [] };

    const now = this.#clock.now();
    const effects = await timezoneChangeEffects(this.#db, {
      workspaceId,
      toZone: input.toZone,
      now,
      minLeadMinutes: input.minLeadMinutes,
    });
    const notifications = new NotificationService({ db: this.#db, workspaceId });

    for (const effect of effects) {
      const unplanned = effect.outcome === 'unplanned';
      /*
       * CONDITIONAL, so a post the publisher claimed a moment ago is not
       * moved underneath it. One that no longer matches is simply left out.
       */
      const moved = await this.#db.calendarSlot.updateMany({
        where: { id: effect.slotId, status: { in: [...MOVABLE] } },
        data: {
          scheduledAtUtc: effect.toUtc,
          timezone: input.toZone,
          ...(unplanned ? { status: 'PLANNED' as const } : {}),
        },
      });
      if (moved.count === 0) continue;

      if (unplanned) {
        const slot = await this.#db.calendarSlot.findUniqueOrThrow({
          where: { id: effect.slotId },
          select: { usageIdempotencyKey: true },
        });
        // The same derived key a cancel uses, so the quota comes back once.
        if (slot.usageIdempotencyKey) {
          await this.#quota.refund(`${slot.usageIdempotencyKey}:refund`);
        }
        await this.#unscheduleItem(effect.contentItemId);
        if (effect.authorUserId) {
          await notifications.create({
            userIds: [effect.authorUserId],
            templateKey: 'calendar.unplanned_by_timezone_change',
            payload: { itemTitle: effect.title },
            linkPath: '/calendar',
            brandId: effect.brandId,
            resourceType: 'CalendarSlot',
            resourceId: effect.slotId,
            idempotencyKey: `calendar.unplanned_by_timezone_change:${effect.slotId}:${input.toZone}`,
          });
        }
      }

      await writeAuditEvent(this.#db, workspaceId, {
        action: 'content.rescheduled',
        actorType: input.actor.type,
        actorId: input.actor.id,
        resourceType: 'CalendarSlot',
        resourceId: effect.slotId,
        brandId: effect.brandId,
        after: {
          reason: 'workspace_timezone_changed',
          fromTimezone: from,
          toTimezone: input.toZone,
          localTime: effect.localTime,
          toUtc: effect.toUtc.toISOString(),
          ...(unplanned ? { toStatus: 'PLANNED' } : {}),
        },
      });
    }

    await this.#db.workspace.update({
      where: { id: workspaceId },
      data: { timezone: input.toZone },
    });
    await writeAuditEvent(this.#db, workspaceId, {
      action: 'workspace.timezone.changed',
      actorType: input.actor.type,
      actorId: input.actor.id,
      resourceType: 'workspace',
      resourceId: workspaceId,
      severity: 'NOTICE',
      before: { timezone: from },
      after: {
        timezone: input.toZone,
        postsKept: effects.filter((effect) => effect.outcome === 'kept').length,
        postsUnplanned: effects.filter((effect) => effect.outcome === 'unplanned').length,
      },
    });
    return { from, effects };
  }

  /**
   * The post is no longer cleared to go at a time. A SCHEDULED item goes back
   * to APPROVED when its latest review approved it — a change of zone is not a
   * reason to ask for the review again — and to DRAFT otherwise.
   */
  async #unscheduleItem(contentItemId: string): Promise<void> {
    const item = await this.#db.contentItem.findUnique({
      where: { id: contentItemId },
      select: { status: true },
    });
    if (item?.status !== 'SCHEDULED') return;
    const approval = await this.#db.approval.findFirst({
      where: { contentItemId },
      orderBy: { cycle: 'desc' },
      select: { status: true },
    });
    await this.#db.contentItem.update({
      where: { id: contentItemId },
      data: { status: approval?.status === 'APPROVED' ? 'APPROVED' : 'DRAFT' },
    });
  }
}
