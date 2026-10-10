import { randomUUID } from 'node:crypto';
import {
  recordAutomationEvent,
  writeAuditEvent,
  type CalendarSlot,
  type ContentItem,
  type ContentVariant,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter, isAppError, systemClock, type Clock } from '@brandspace/shared';
import { lockCalendarCapacity } from './calendar-capacity-lock';
import { defaultPublishingTime, suggestedPostingTimes } from './calendar-markers';
import {
  alreadyScheduled,
  approvalRequiredBeforeScheduling,
  calendarSlotNotFound,
  channelDisconnected,
  contentItemNotFound,
  DAY_IS_FULL_REASON,
  dayIsFull,
  invalidScheduleTime,
  nothingToSchedule,
  proposedTimeLocked,
  SCHEDULE_QUOTA_EXCEEDED_REASON,
  scheduleQuotaExceeded,
  scheduleTooFarAhead,
  scheduleTooSoon,
  slotMovedSince,
  slotNotReschedulable,
  transitionNotAllowed,
} from './errors';
import type { ContentPolicy } from './policy';
import {
  formatLocalTime,
  instantForIntent,
  monthRangeUtc,
  nextDayKey,
  resolveZonedTime,
} from './timezone';

/**
 * The Content Calendar — docs/PRODUCT.md §5 module 6, AC-14.1 to AC-14.9.
 *
 * WHAT THIS SERVICE IS FOR, and the invariants that make it safe:
 *
 *   - THE CONTENT ITEM REMAINS THE SOURCE OF TRUTH. A slot records WHEN; the
 *     item records what it is and what state it is in. Scheduling moves the
 *     item to `SCHEDULED` and cancelling moves it back, in the SAME transaction
 *     as the slot write, so the two can never disagree about whether something
 *     is on the calendar.
 *
 *   - THE INTENT IS STORED, NOT JUST THE INSTANT (AC-14.2, AC-14.3). A
 *     wall-clock plus a zone survives a daylight-saving boundary and an offset
 *     change; a timestamp alone does not. See `timezone.ts` for the arithmetic.
 *
 *   - THE QUOTA IS CONSUMED BEFORE THE ROW EXISTS (AC-14.5), and refunded when
 *     a slot is cancelled. A plan's monthly scheduled-post ceiling that was
 *     checked after the write would be a ceiling a concurrent request walks
 *     straight through.
 *
 *   - NOTHING PUBLISHES. `targetKind` is `MOCK` and there is no connector, no
 *     OAuth and no outbound call anywhere in this file (AC-14.7). Real
 *     publishing is Phase 6.
 *
 *   - EVERY STATE CHANGE IS AUDITED (AC-14.9): `content.scheduled`,
 *     `content.rescheduled`, `content.schedule_cancelled` — with the time and
 *     the zone, never the caption.
 */

/** What the caller needs from the entitlements engine, and nothing more. */
export interface ScheduleQuota {
  /** The plan's monthly ceiling. `null` is unlimited. */
  limit(): Promise<number | null>;
  /** Take one. Returns false when the ceiling is reached. */
  consume(idempotencyKey: string): Promise<boolean>;
  /** Give one back when a slot is cancelled. */
  refund(idempotencyKey: string): Promise<void>;
}

export interface CalendarOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: ContentPolicy;
  /** The workspace's IANA zone. Copied onto each slot it creates. */
  readonly timezone: string;
  readonly quota: ScheduleQuota;
  readonly clock?: Clock;
  /**
   * Phase 5B-3. Supplies the per-brand approval policy so AC-14.6's gate reads
   * what the customer configured rather than one workspace-wide default.
   *
   * REQUIRED (PR 0). It used to be optional, with the activated
   * `content.calendar.requireApprovalBeforeScheduling` as the fallback — a
   * DIFFERENT value from the approvals default `policyForBrand` resolves, and
   * one that ignores the brand's own choice. The automation worker's
   * `PLACE_ON_CALENDAR` and the Copilot's publish-now both built a calendar
   * without it, so a brand that requires approval could have an unapproved
   * post scheduled through either door. There is now one answer, the
   * approvals domain's `ContentApprovalService.policyForBrand`, and a calendar
   * cannot be built without it.
   */
  readonly approvalGate: ApprovalGate;
  /**
   * Q9 (D-332). Answers which of a post's channels can reach NO account at
   * all because every account for it was revoked or disabled. Scheduling and
   * rescheduling onto such a channel is refused. An EXPIRED account is not
   * one of them — its channel waits for the reconnection — and a channel with
   * no account connected keeps today's behaviour.
   *
   * REQUIRED (Batch 7 PR C, B3.8 — the F8 audit finding). It used to be
   * optional, and a calendar built without it refused nothing: a gate that
   * fails OPEN when it is forgotten. Like `approvalGate` (PR 0), a calendar
   * now cannot be built without it; a test that is not about reachability
   * passes one that names no channel unreachable.
   */
  readonly channelGate: ChannelGate;
}

/** The single question the calendar asks the social connections. */
export interface ChannelGate {
  /** Of these platform keys, the ones whose every account for the brand is revoked or disabled. */
  unreachableChannels(brandId: string, platformKeys: readonly string[]): Promise<readonly string[]>;
}

/** The single question the calendar asks the Approvals module. */
export interface ApprovalGate {
  policyForBrand(brandId: string): Promise<{ requireApprovalBeforeScheduling: boolean }>;
}

export interface ScheduleInput {
  readonly contentItemId: string;
  /** `YYYY-MM-DDTHH:mm`, in the workspace's zone. */
  readonly localTime: string;
  readonly actorUserId: string;
  readonly actorBrandScope: readonly string[];
}

/**
 * PHASE 2B-3 PR 2 — why "schedule in the next free slot" did not schedule.
 * Each is a stable code Run history translates; none of them changed anything.
 */
export type NextFreeSlotRefusal =
  | 'already_has_time'
  | 'no_free_day'
  | 'approval_required'
  | 'schedule_quota_reached'
  | 'channel_disconnected'
  | 'not_schedulable'
  | 'content_unavailable';

export type NextFreeSlotOutcome =
  | { readonly kind: 'scheduled'; readonly view: CalendarSlotView; readonly localTime: string }
  | { readonly kind: 'refused'; readonly reason: NextFreeSlotRefusal };

export interface CalendarSlotView {
  readonly slot: CalendarSlot;
  readonly item: ContentItem;
  readonly variants: readonly ContentVariant[];
}

/**
 * States a content item may be scheduled FROM.
 *
 * `IN_REVIEW` IS NOT ON THIS LIST, and removing it closes a real divergence
 * between the two modules rather than tightening a rule.
 *
 * WHAT WENT WRONG WHILE IT WAS: with the approval gate OFF, an item submitted
 * for review could also be scheduled — `schedule()` moved it to `SCHEDULED`
 * while its PENDING approval was still open. The reviewer's verdict then moved
 * it again, out from under a live calendar slot: an approval sent it to
 * `APPROVED` and a rejection to `DRAFT`, in both cases leaving a slot pointing
 * at content the item no longer claims to be scheduled. `transition()` refuses
 * to move a scheduled item precisely so that cannot happen, and this path went
 * around it.
 *
 * THE INVARIANT IS THE SIMPLE ONE: an item in review is not schedulable. With
 * the gate OFF a DRAFT may still be planned directly, which is the whole point
 * of the gate being optional; with the gate ON only `APPROVED` may.
 *
 * `CHANGES_REQUESTED` is likewise absent: a reviewer has actively said the
 * content is not ready, and planning it anyway would make the verdict advisory.
 */
/**
 * Batch 7 PR C — where a proposed publish time may be set or cleared: a draft,
 * a post sent back for changes, and an approved post waiting to be scheduled.
 */
const PROPOSABLE_FROM: readonly ContentItem['status'][] = [
  'DRAFT',
  'CHANGES_REQUESTED',
  'APPROVED',
];

const SCHEDULABLE_FROM: readonly ContentItem['status'][] = ['DRAFT', 'APPROVED', 'SCHEDULED'];

/**
 * ITEM 9 (Phase 2B-2, the D-332 follow-up, owner's Option 1) — A FAILED POST
 * WITH NOTHING PUBLISHED MAY BE SCHEDULED AGAIN, as a NEW slot. The old FAILED
 * slot and its jobs stay as history; retrying them is refused once the new
 * slot exists (`superseded_by_new_slot` in the publishing pipeline). The
 * approval gate is unchanged: FAILED is not APPROVED, so a brand that requires
 * approval sends the post for review again first (`submit()` accepts FAILED
 * for the same reason), and its earlier approvals are never touched.
 *
 * A partly published post is PARTIALLY_PUBLISHED, not FAILED, and is not
 * rescheduled here: some channels already went out.
 */
export const RESCHEDULABLE_ITEM_STATUS: ContentItem['status'] = 'FAILED';

/**
 * The job states that mean a FAILED slot is still busy — a retry in flight —
 * or produced something. Such a slot still counts as the post's live slot.
 */
export const SLOT_BUSY_JOB_STATUSES = [
  'PENDING',
  'QUEUED',
  'PUBLISHING',
  'VERIFICATION_PENDING',
  'PUBLISHED',
] as const;

/**
 * THE POST'S LIVE SLOT — the one rule the scheduler, the approvals module and
 * the screens share, and the partial unique index `calendar_slot_one_live_per_item`
 * backs (`status NOT IN ('CANCELLED', 'FAILED')`). A cancelled slot is gone; a
 * FAILED slot whose jobs are all finished and none published is history.
 */
export function liveSlotWhere(contentItemId: string): Prisma.CalendarSlotWhereInput {
  return {
    contentItemId,
    OR: [
      { status: { notIn: ['CANCELLED', 'FAILED'] } },
      {
        status: 'FAILED',
        publishJobs: { some: { status: { in: [...SLOT_BUSY_JOB_STATUSES] } } },
      },
    ],
  };
}

/**
 * B-4 — the slot states a plan can still be moved from. Once publishing has
 * started (PUBLISHING) or finished (PUBLISHED, PARTIALLY_PUBLISHED, FAILED),
 * the slot records what happened and a reschedule is refused.
 */
export const RESCHEDULABLE_SLOT_STATUSES: readonly CalendarSlot['status'][] = [
  'PLANNED',
  'SCHEDULED',
];

/**
 * The scheduling quota's idempotency key for one slot and one charged attempt
 * (review item 13). Attempt 0 is the key a slot has always had, so rows written
 * before `rescheduleAttempt` existed keep theirs.
 */
export function scheduleUsageKey(workspaceId: string, slotId: string, attempt: number): string {
  return attempt === 0
    ? `calendar:${workspaceId}:${slotId}`
    : `calendar:${workspaceId}:${slotId}:attempt:${attempt}`;
}

export class ContentCalendarService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: ContentPolicy;
  readonly #timezone: string;
  readonly #quota: ScheduleQuota;
  readonly #clock: Clock;
  readonly #channelGate: ChannelGate;
  readonly #approvalGate: ApprovalGate;

  constructor(options: CalendarOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#timezone = options.timezone;
    this.#quota = options.quota;
    this.#clock = options.clock ?? systemClock;
    this.#channelGate = options.channelGate;
    this.#approvalGate = options.approvalGate;
  }

  /**
   * AC-14.6 — is approval required before THIS brand's content may be planned?
   *
   * PER BRAND FIRST, the activated approvals default second (Phase 5B-3) —
   * both decided by the approvals domain, never here. D-120 shipped this as one
   * workspace-wide switch that was off because nothing could grant approval;
   * now that the workflow exists, ROADMAP scope item 6's "policy per brand" is
   * what a customer actually configures. There is no local fallback (PR 0).
   */
  async #approvalRequired(brandId: string): Promise<boolean> {
    return (await this.#approvalGate.policyForBrand(brandId)).requireApprovalBeforeScheduling;
  }

  /** The zone every wall-clock on this calendar is expressed in. */
  get timezone(): string {
    return this.#timezone;
  }

  /** AC-14.1 — place a draft on the calendar at a chosen date and time. */
  async schedule(input: ScheduleInput): Promise<CalendarSlotView> {
    return this.#place(input, null);
  }

  /**
   * Batch 7 PR C (B3.1) — PUBLISH NOW: place the post on the calendar at THIS
   * instant, for the publisher to pick up at once.
   *
   * "Publish now" used to build the current minute and call `schedule()`,
   * which refuses anything sooner than now plus the minimum lead — and even
   * with a lead of 0 the truncated minute is already past — so it never
   * succeeded. This path is `schedule()` with every rule kept (the approval
   * gate, the status rules, the channels, the day's room, the quota, the audit
   * and the automation event) except the lead and the horizon, which are
   * rules about choosing a FUTURE time and have no meaning for "now".
   *
   * A POST ALREADY SCHEDULED is not refused by that alone: its live slot is
   * moved to now (the same conditional write `reschedule` uses, so it cannot
   * race the publisher), keeping the quota it already used.
   */
  async publishNow(input: Omit<ScheduleInput, 'localTime'>): Promise<CalendarSlotView> {
    const now = this.#clock.now();
    const localTime = formatLocalTime(now, this.#timezone);
    const item = await this.#requireItem(input.contentItemId, input.actorBrandScope);
    const live = await this.#liveSlotFor(item.id);
    if (live && live.status === 'SCHEDULED') {
      const variants = await this.#db.contentVariant.findMany({
        where: { contentItemId: item.id },
        orderBy: { platformKey: 'asc' },
      });
      await this.#assertChannelsReachable(
        item.brandId,
        variants.map((variant) => variant.platformKey),
      );
      const claimed = await this.#db.calendarSlot.updateMany({
        where: { id: live.id, status: 'SCHEDULED' },
        data: { scheduledAtUtc: now, scheduledLocalTime: localTime },
      });
      if (claimed.count === 0) throw slotNotReschedulable();
      const moved = await this.#db.calendarSlot.findUniqueOrThrow({ where: { id: live.id } });
      await this.#audit('content.rescheduled', moved, input.actorUserId, {
        reason: 'publish_now',
        fromLocalTime: live.scheduledLocalTime,
        toLocalTime: moved.scheduledLocalTime,
        timezone: moved.timezone,
        toUtc: moved.scheduledAtUtc.toISOString(),
      });
      return { slot: moved, item, variants };
    }
    return this.#place({ ...input, localTime }, now);
  }

  /**
   * `schedule()` and `publishNow()`: `at` is null to resolve `localTime` with
   * the lead and the horizon, or the instant "now" means.
   */
  async #place(input: ScheduleInput, at: Date | null): Promise<CalendarSlotView> {
    const item = await this.#requireItem(input.contentItemId, input.actorBrandScope);

    // AC-14.6. The gate, read from the brand's own policy (5B-3). With the
    // workflow behind it, `APPROVED` now means a named reviewer said so.
    if ((await this.#approvalRequired(item.brandId)) && item.status !== 'APPROVED') {
      throw approvalRequiredBeforeScheduling();
    }
    // Item 9 — a FAILED post with nothing published is scheduled again.
    const rescheduling = item.status === RESCHEDULABLE_ITEM_STATUS;
    if (!SCHEDULABLE_FROM.includes(item.status) && !rescheduling) throw transitionNotAllowed();
    if (rescheduling) {
      const published = await this.#db.publishJob.count({
        where: { workspaceId: this.#workspaceId, contentItemId: item.id, status: 'PUBLISHED' },
      });
      if (published > 0) throw transitionNotAllowed();
    }

    const variants = await this.#db.contentVariant.findMany({
      where: { contentItemId: item.id },
      orderBy: { platformKey: 'asc' },
    });
    // A plan for content with no caption is a plan to publish nothing.
    if (variants.length === 0) throw nothingToSchedule();
    await this.#assertChannelsReachable(
      item.brandId,
      variants.map((variant) => variant.platformKey),
    );

    const live = await this.#liveSlotFor(item.id);
    if (live) throw alreadyScheduled();
    // The attempt it replaces, for the history (item 9). Never changed here.
    const replaces = rescheduling
      ? await this.#db.calendarSlot.findFirst({
          where: { workspaceId: this.#workspaceId, contentItemId: item.id, status: 'FAILED' },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;

    const instant = at ?? this.#resolveInstant(input.localTime);
    await this.#assertDayHasRoom(instant, null);

    /*
     * AC-14.5 — THE QUOTA IS TAKEN BEFORE THE ROW EXISTS.
     *
     * THE KEY IS PER SLOT, NOT PER ITEM, and the slot's id is therefore minted
     * here rather than by the database. Keying on the item looked simpler and
     * was wrong in both directions: a draft scheduled, cancelled and scheduled
     * again would consume ONCE for two slots (a quota leak), and the refund —
     * which the usage service records as a negative event under its own key —
     * would collide with the consumption it was reversing.
     *
     * Minting the id up front costs nothing: it is a v4 uuid either way.
     */
    const slotId = randomUUID();
    // A new slot is attempt 0 (review item 13): the same key as ever.
    const usageIdempotencyKey = scheduleUsageKey(this.#workspaceId, slotId, 0);
    if (!(await this.#quota.consume(usageIdempotencyKey))) throw scheduleQuotaExceeded();

    const slot = await this.#db.calendarSlot.create({
      data: {
        id: slotId,
        workspaceId: this.#workspaceId,
        brandId: item.brandId,
        contentItemId: item.id,
        scheduledAtUtc: instant,
        scheduledLocalTime: input.localTime,
        timezone: this.#timezone,
        status: 'SCHEDULED',
        platformKeys: [...new Set(variants.map((variant) => variant.platformKey))],
        createdByUserId: input.actorUserId,
        usageIdempotencyKey,
      },
    });

    // The item and the slot move together, so nothing can be on the calendar
    // while claiming to be a draft.
    const updated = await this.#db.contentItem.update({
      where: { id: item.id },
      data: { status: 'SCHEDULED' },
    });

    await this.#audit('content.scheduled', slot, input.actorUserId, {
      scheduledLocalTime: slot.scheduledLocalTime,
      timezone: slot.timezone,
      scheduledAtUtc: slot.scheduledAtUtc.toISOString(),
      platformCount: slot.platformKeys.length,
      ...(replaces ? { replacesFailedSlotId: replaces.id } : {}),
    });

    /*
     * THE AUTOMATION EVENT (A1). `CONTENT_SCHEDULED` had no producer either.
     *
     * THE REFERENCE IS THE SLOT, NOT THE ITEM, exactly as the trigger registry
     * declares: `contentItemVia: 'calendarSlot'`. An action that needs a content
     * item resolves it through the slot with a scoped query rather than assuming
     * the two ids interchange — which is the assumption P7-R5's neighbour
     * closed, and which a producer writing the item's id here would quietly
     * reopen.
     *
     * ONLY THE FIRST PLACEMENT IS AN EVENT. `reschedule` moves an existing slot
     * and is not "content was scheduled" happening again; the derived key would
     * collide anyway, so a future caller that got this wrong writes nothing
     * rather than firing every rule a second time.
     */
    await recordAutomationEvent(
      this.#db,
      this.#workspaceId,
      { triggerType: 'CONTENT_SCHEDULED', refType: 'CalendarSlot' },
      { brandId: slot.brandId, refId: slot.id },
    );

    return { slot, item: updated, variants };
  }

  /**
   * PHASE 2B-3 PR 2 (OD-8, D7) — SCHEDULE IN THE NEXT FREE SLOT.
   *
   * THE DAY: the first local day, starting TOMORROW, on which the post's brand
   * has no live slot and the workspace is under its per-day cap — within the
   * configured scheduling horizon. THE TIME: `defaultPublishingTime` — the
   * brand's default, else the country's first suggested time, else 09:00 —
   * the same answer the schedule dialog proposes. Then `schedule()`, so every
   * rule a person's scheduling obeys applies unchanged: the approval gate,
   * the schedulable states, captions, channels, lead time, horizon, the
   * per-day cap and the plan's quota.
   *
   * A post that already has a time (a live slot) is not moved. Every other
   * reason not to schedule is returned as a code rather than thrown, and
   * nothing is written for it.
   *
   * UNDER THE WORKSPACE'S CALENDAR-CAPACITY LOCK (D7), taken before anything
   * is read, so two automation runs cannot both pick the same "free" day or
   * push a day past the cap. See `calendar-capacity-lock.ts`.
   */
  async scheduleNextFreeSlot(input: {
    readonly contentItemId: string;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
  }): Promise<NextFreeSlotOutcome> {
    await lockCalendarCapacity(this.#db, this.#workspaceId);
    const refused = (reason: NextFreeSlotRefusal): NextFreeSlotOutcome => ({
      kind: 'refused',
      reason,
    });

    const item = await this.#db.contentItem.findFirst({
      where: {
        id: input.contentItemId,
        ...brandIdQueryFilter({ brandScope: input.actorBrandScope }),
      },
    });
    if (!item || item.deletedAt) return refused('content_unavailable');
    if (await this.#liveSlotFor(item.id)) return refused('already_has_time');

    // The same gates `schedule()` applies, asked first so each has its reason.
    if ((await this.#approvalRequired(item.brandId)) && item.status !== 'APPROVED') {
      return refused('approval_required');
    }
    const rescheduling = item.status === RESCHEDULABLE_ITEM_STATUS;
    if (!SCHEDULABLE_FROM.includes(item.status) && !rescheduling) return refused('not_schedulable');
    if (rescheduling) {
      const published = await this.#db.publishJob.count({
        where: { workspaceId: this.#workspaceId, contentItemId: item.id, status: 'PUBLISHED' },
      });
      if (published > 0) return refused('not_schedulable');
    }
    const variants = await this.#db.contentVariant.findMany({
      where: { contentItemId: item.id },
      select: { platformKey: true },
    });
    if (variants.length === 0) return refused('not_schedulable');
    const unreachable = await this.#channelGate.unreachableChannels(item.brandId, [
      ...new Set(variants.map((variant) => variant.platformKey)),
    ]);
    if (unreachable.length > 0) return refused('channel_disconnected');

    const time = await this.#defaultPublishingTimeFor(item.brandId);
    const now = this.#clock.now();
    const horizon = new Date(now.getTime() + this.#policy.calendar.maxDaysAhead * 24 * 3_600_000);
    let dayKey = nextDayKey(formatLocalTime(now, this.#timezone).slice(0, 10));
    for (
      let step = 0;
      step <= this.#policy.calendar.maxDaysAhead;
      step += 1, dayKey = nextDayKey(dayKey)
    ) {
      const localTime = `${dayKey}T${time}`;
      const instant = instantForIntent(localTime, this.#timezone);
      // A wall-clock time that does not exist on this day (a DST gap).
      if (!instant) continue;
      if (instant.getTime() > horizon.getTime()) break;
      if (!(await this.#dayIsFreeFor(item.brandId, instant))) continue;
      try {
        const view = await this.schedule({
          contentItemId: item.id,
          localTime,
          actorUserId: input.actorUserId,
          actorBrandScope: input.actorBrandScope,
        });
        return { kind: 'scheduled', view, localTime };
      } catch (error: unknown) {
        const reason = isAppError(error) ? error.publicDetails['reason'] : undefined;
        // A person filled the day between the read and the write: try the next.
        if (reason === DAY_IS_FULL_REASON) continue;
        if (reason === SCHEDULE_QUOTA_EXCEEDED_REASON) return refused('schedule_quota_reached');
        throw error;
      }
    }
    return refused('no_free_day');
  }

  /**
   * Is this local day free for the brand: no live slot of the brand on it,
   * and the workspace under its per-day cap? The day's range is the one the
   * cap itself is counted over (`#dayRange`).
   */
  async #dayIsFreeFor(brandId: string, instant: Date): Promise<boolean> {
    const { dayStart, dayEnd } = this.#dayRange(instant);
    const brandSlots = await this.#db.calendarSlot.count({
      where: {
        brandId,
        scheduledAtUtc: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['CANCELLED', 'FAILED'] },
      },
    });
    if (brandSlots > 0) return false;
    const used = await this.#db.calendarSlot.count({
      where: { scheduledAtUtc: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } },
    });
    return used < this.#policy.calendar.maxSlotsPerDay;
  }

  /** `defaultPublishingTime` for this brand, read from its row and the workspace's country. */
  async #defaultPublishingTimeFor(brandId: string): Promise<string> {
    const brand = await this.#db.brand.findFirst({
      where: { id: brandId },
      select: { defaultPostTime: true },
    });
    const workspace = await this.#db.workspace.findFirst({
      where: { id: this.#workspaceId },
      select: { country: true },
    });
    return defaultPublishingTime({
      brandDefaultTime: brand?.defaultPostTime ?? null,
      suggestedTimes: suggestedPostingTimes(this.#policy.calendar, {
        measured: [],
        country: workspace?.country ?? null,
      }).times,
    });
  }

  /** AC-14.8 — move a slot, and say so in the audit log. */
  async reschedule(input: {
    slotId: string;
    localTime: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
    /**
     * §8.2 UNDO (Phase 2B-2b, owner-approved precondition): move only if the
     * slot is still at this local time — where the move being undone put it.
     * Checked up front AND in the conditional write, so an Undo that runs
     * twice, or races another move, changes nothing the second time. Every
     * other rule (F2, quota, approval, B-4, scope) applies exactly as to any
     * move, as the rules stand now.
     */
    expectedLocalTime?: string | undefined;
  }): Promise<CalendarSlotView> {
    const slot = await this.#requireSlot(input.slotId, input.actorBrandScope);
    if (slot.status === 'CANCELLED') throw calendarSlotNotFound();
    // B-4 — only a plan that has not started going out can move.
    if (!RESCHEDULABLE_SLOT_STATUSES.includes(slot.status)) throw slotNotReschedulable();
    const expected = input.expectedLocalTime;
    if (expected !== undefined && slot.scheduledLocalTime !== expected) throw slotMovedSince();

    const instant = this.#resolveInstant(input.localTime);
    await this.#assertDayHasRoom(instant, slot.id);
    // G5 / Q22 (D-334): a post a time-zone change sent back to PLANNED goes out
    // again only through every rule scheduling applies.
    if (slot.status === 'PLANNED') return this.#replan(slot, input, instant);
    const variantsNow = await this.#db.contentVariant.findMany({
      where: { contentItemId: slot.contentItemId },
      select: { platformKey: true },
    });
    await this.#assertChannelsReachable(
      slot.brandId,
      variantsNow.map((variant) => variant.platformKey),
    );

    /*
     * B-4 — CONDITIONAL, NOT READ-THEN-WRITE. The status check above answers
     * the common case with a clear error; this WHERE is what holds when the
     * publisher claims the slot between that read and this write. A slot that
     * started publishing in the meantime matches nothing and is not moved.
     */
    const claimed = await this.#db.calendarSlot.updateMany({
      where: {
        id: slot.id,
        status: { in: [...RESCHEDULABLE_SLOT_STATUSES] },
        ...(expected !== undefined ? { scheduledLocalTime: expected } : {}),
      },
      data: {
        scheduledAtUtc: instant,
        scheduledLocalTime: input.localTime,
        // The zone is re-copied, so a workspace that has since relocated moves
        // the posts it deliberately touches and leaves the rest where they are.
        timezone: this.#timezone,
      },
    });
    if (claimed.count === 0) {
      throw expected !== undefined ? slotMovedSince() : slotNotReschedulable();
    }
    const moved = await this.#db.calendarSlot.findUniqueOrThrow({ where: { id: slot.id } });

    await this.#audit('content.rescheduled', moved, input.actorUserId, {
      fromLocalTime: slot.scheduledLocalTime,
      fromTimezone: slot.timezone,
      toLocalTime: moved.scheduledLocalTime,
      toTimezone: moved.timezone,
      toUtc: moved.scheduledAtUtc.toISOString(),
    });

    return this.#viewOf(moved);
  }

  /**
   * G5 / Q22 (D-334) — A PLANNED POST GIVEN A NEW TIME IS SCHEDULED AGAIN.
   *
   * A time-zone change sends a post that would have been too late back to
   * PLANNED and refunds its quota. Moving it to a new time puts it back on the
   * way out through the SAME rules `schedule()` applies — the approval gate,
   * the states it may be scheduled from, its channels — and takes the quota
   * again, under a key derived from the slot and the new time, so a retried
   * move takes it once.
   */
  async #replan(
    slot: CalendarSlot,
    input: {
      slotId: string;
      localTime: string;
      actorUserId: string;
      expectedLocalTime?: string | undefined;
    },
    instant: Date,
  ): Promise<CalendarSlotView> {
    const item = await this.#db.contentItem.findUnique({ where: { id: slot.contentItemId } });
    if (!item || item.deletedAt) throw calendarSlotNotFound();
    if ((await this.#approvalRequired(item.brandId)) && item.status !== 'APPROVED') {
      throw approvalRequiredBeforeScheduling();
    }
    if (!SCHEDULABLE_FROM.includes(item.status)) throw transitionNotAllowed();
    const variants = await this.#db.contentVariant.findMany({
      where: { contentItemId: item.id },
      select: { platformKey: true },
    });
    if (variants.length === 0) throw nothingToSchedule();
    await this.#assertChannelsReachable(
      slot.brandId,
      variants.map((variant) => variant.platformKey),
    );

    /*
     * THE KEY IS THE SLOT'S PERSISTED ATTEMPT (review item 13), read — never
     * incremented — here. A retry of this same request derives the same key
     * and cannot charge twice; the key moves on only when a charged scheduling
     * is refunded back to PLANNED, which increments the attempt in that
     * refund's own transaction. Deriving it from the local time instead let a
     * post refunded and put back at the SAME time reuse the spent key and go
     * out uncharged.
     */
    const usageIdempotencyKey = scheduleUsageKey(
      this.#workspaceId,
      slot.id,
      slot.rescheduleAttempt,
    );
    if (!(await this.#quota.consume(usageIdempotencyKey))) throw scheduleQuotaExceeded();

    const claimed = await this.#db.calendarSlot.updateMany({
      // The attempt this key was derived from must still be the slot's — and,
      // for an Undo, the time the move being undone put it at.
      where: {
        id: slot.id,
        status: 'PLANNED',
        rescheduleAttempt: slot.rescheduleAttempt,
        ...(input.expectedLocalTime !== undefined
          ? { scheduledLocalTime: input.expectedLocalTime }
          : {}),
      },
      data: {
        status: 'SCHEDULED',
        scheduledAtUtc: instant,
        scheduledLocalTime: input.localTime,
        timezone: this.#timezone,
        usageIdempotencyKey,
      },
    });
    if (claimed.count === 0) {
      throw input.expectedLocalTime !== undefined ? slotMovedSince() : slotNotReschedulable();
    }
    await this.#db.contentItem.update({ where: { id: item.id }, data: { status: 'SCHEDULED' } });
    const moved = await this.#db.calendarSlot.findUniqueOrThrow({ where: { id: slot.id } });
    await this.#audit('content.rescheduled', moved, input.actorUserId, {
      fromStatus: 'PLANNED',
      fromLocalTime: slot.scheduledLocalTime,
      toLocalTime: moved.scheduledLocalTime,
      toTimezone: moved.timezone,
      toUtc: moved.scheduledAtUtc.toISOString(),
    });
    return this.#viewOf(moved);
  }

  /** Q9 (D-332): refuse a channel that can reach no account at all. */
  async #assertChannelsReachable(brandId: string, platformKeys: readonly string[]): Promise<void> {
    const unreachable = await this.#channelGate.unreachableChannels(brandId, [
      ...new Set(platformKeys),
    ]);
    if (unreachable.length > 0) throw channelDisconnected(unreachable);
  }

  /**
   * Batch 7 PR C (B1.1, B1.4) — keep a proposed publish time on a post, or
   * clear it.
   *
   * A PROPOSAL, NOT A PLAN. Nothing publishes it and nothing on the calendar
   * counts it: no slot is created, no quota is used, no day's room is taken.
   * It becomes a slot only through `schedule()` — an explicit Schedule press,
   * or "Approve & schedule" — which applies the lead, horizon, quota, channel
   * and approval rules exactly as before.
   *
   * WHAT IS CHECKED HERE: the wall-clock exists in the workspace's zone, it is
   * not already past, and it is inside the planning horizon. The minimum lead
   * is not: it is a rule about scheduling, applied when the slot is made.
   */
  async propose(input: {
    readonly contentItemId: string;
    /** `YYYY-MM-DDTHH:mm` in the workspace's zone, or null to clear it. */
    readonly localTime: string | null;
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
  }): Promise<ContentItem> {
    const item = await this.#requireItem(input.contentItemId, input.actorBrandScope);
    if (!PROPOSABLE_FROM.includes(item.status)) throw proposedTimeLocked();

    if (input.localTime !== null) {
      const resolved = resolveZonedTime(input.localTime, this.#timezone);
      if (!resolved) throw invalidScheduleTime();
      const now = this.#clock.now();
      if (resolved.instant.getTime() < now.getTime()) throw scheduleTooSoon();
      const horizonMs = this.#policy.calendar.maxDaysAhead * 24 * 3_600_000;
      if (resolved.instant.getTime() > now.getTime() + horizonMs) throw scheduleTooFarAhead();
    }
    if (item.proposedLocalTime === input.localTime) return item;

    const updated = await this.#db.contentItem.update({
      where: { id: item.id },
      data: { proposedLocalTime: input.localTime },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.proposed_time_set',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ContentItem',
      resourceId: item.id,
      brandId: item.brandId,
      before: { proposedLocalTime: item.proposedLocalTime, timezone: this.#timezone },
      after: { proposedLocalTime: input.localTime, timezone: this.#timezone },
    });
    return updated;
  }

  /** AC-14.8 — take a slot off the calendar, refund its quota, audit it. */
  async cancel(input: {
    slotId: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<CalendarSlot> {
    const slot = await this.#requireSlot(input.slotId, input.actorBrandScope);
    if (slot.status === 'CANCELLED') return slot;

    /*
     * B7 — ONLY A PLAN THAT HAS NOT STARTED CAN BE TAKEN OFF. Cancelling a
     * slot that is publishing, published or failed refunded its quota and hid
     * a post that had gone (or was going) out. The same conditional update
     * `reschedule` uses, so it cannot race the publisher either.
     */
    if (!RESCHEDULABLE_SLOT_STATUSES.includes(slot.status)) throw slotNotReschedulable();
    const claimed = await this.#db.calendarSlot.updateMany({
      where: { id: slot.id, status: { in: [...RESCHEDULABLE_SLOT_STATUSES] } },
      data: { status: 'CANCELLED', cancelledAt: this.#clock.now() },
    });
    if (claimed.count === 0) throw slotNotReschedulable();
    const cancelled = await this.#db.calendarSlot.findUniqueOrThrow({ where: { id: slot.id } });

    /*
     * THE ITEM GOES BACK TO BEING A DRAFT.
     *
     * Only when it is still `SCHEDULED`. An item that has moved on since —
     * archived, or a later phase's published — is not this cancellation's to
     * rewind, and forcing it back would undo a state somebody else set.
     */
    const item = await this.#db.contentItem.findUnique({ where: { id: slot.contentItemId } });
    if (item?.status === 'SCHEDULED') {
      await this.#db.contentItem.update({ where: { id: item.id }, data: { status: 'DRAFT' } });
    }

    /*
     * The quota comes back, under a key of its OWN.
     *
     * The usage service records a refund as a negative event, and its
     * idempotency keys are globally unique — so reusing the consumption's key
     * is a conflict, not a reversal. Deriving the refund key from it keeps both
     * properties: the refund happens once however many times a cancel is
     * retried, and it is a distinct row from the consumption it reverses.
     *
     * A slot that was never counted has no key, so nothing is refunded and
     * nothing throws.
     */
    if (cancelled.usageIdempotencyKey) {
      await this.#quota.refund(`${cancelled.usageIdempotencyKey}:refund`);
    }

    await this.#audit('content.schedule_cancelled', cancelled, input.actorUserId, {
      scheduledLocalTime: cancelled.scheduledLocalTime,
      timezone: cancelled.timezone,
    });

    return cancelled;
  }

  /**
   * Every live slot whose instant falls inside a local month.
   *
   * THE RANGE IS COMPUTED IN THE WORKSPACE'S ZONE and then queried in UTC,
   * which is the only way "March" means the same thing to the database and to
   * the person reading the screen. A UTC-month query would put the first and
   * last few hours of the month in the wrong page for every zone but one.
   */
  async monthView(input: {
    year: number;
    month: number;
    brandId?: string | undefined;
    /** The caller's membership scope. Empty/absent is UNRESTRICTED. */
    brandScope?: readonly string[] | null | undefined;
  }): Promise<CalendarSlotView[]> {
    const range = monthRangeUtc(input.year, input.month, this.#timezone);
    if (!range) throw invalidScheduleTime();
    return this.listSlots({
      ...range,
      ...(input.brandId ? { brandId: input.brandId } : {}),
      ...(input.brandScope === undefined ? {} : { brandScope: input.brandScope }),
    });
  }

  async listSlots(input: {
    start: Date;
    end: Date;
    brandId?: string | undefined;
    /**
     * The caller's membership BrandScope. Empty or absent is UNRESTRICTED,
     * which is the platform rule `brandInScope()` has carried since Phase 2B.
     *
     * APPLIED IN THE QUERY, NOT AFTER IT. The calendar page used to fetch the
     * whole workspace's month and drop out-of-scope brands in JavaScript. RLS
     * kept another TENANT's slots out, so nothing leaked across workspaces —
     * but a member scoped to one brand still had the other brands' rows
     * fetched on their behalf, and any count or page boundary computed over
     * that list would have been computed over rows they may not see.
     */
    brandScope?: readonly string[] | null | undefined;
    includeCancelled?: boolean;
  }): Promise<CalendarSlotView[]> {
    const slots = await this.#db.calendarSlot.findMany({
      where: {
        scheduledAtUtc: { gte: input.start, lt: input.end },
        // INTERSECTS rather than overwrites — see `brandIdQueryFilter`.
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
        ...(input.includeCancelled ? {} : { status: { not: 'CANCELLED' } }),
      },
      orderBy: { scheduledAtUtc: 'asc' },
      include: { item: { include: { variants: { orderBy: { platformKey: 'asc' } } } } },
    });

    return (
      slots
        // A slot whose item was soft-deleted is not shown. The row survives for
        // the audit trail; the plan it described no longer exists.
        .filter((slot) => slot.item.deletedAt === null)
        .map(({ item, ...slot }) => ({ slot: slot as CalendarSlot, item, variants: item.variants }))
    );
  }

  /** One slot, or a 404 shaped like any other miss. */
  async getSlot(slotId: string, actorBrandScope: readonly string[]): Promise<CalendarSlotView> {
    return this.#viewOf(await this.#requireSlot(slotId, actorBrandScope));
  }

  /**
   * Q8 — AN EDIT BY SOMEONE WITHOUT `content.schedule` TAKES THE POST OFF THE
   * CALENDAR (D-324).
   *
   * The slot is cancelled and its quota refunded, and the post goes back to
   * DRAFT, so it has to be approved (where the brand requires it) and
   * scheduled again by someone who may. The same writes `cancel()` makes, with
   * the same derived refund key — so a later manual cancel of the same slot
   * cannot refund twice — but reached from the library's edit path rather
   * than a calendar action, which is why it takes no brand scope: the edit has
   * already found the item inside the actor's scope.
   *
   * ONLY A SLOT THAT HAS NOT STARTED PUBLISHING. The cancel is a conditional
   * update on `RESCHEDULABLE_SLOT_STATUSES`, so it cannot race the publisher;
   * a slot that moved on refuses the edit (`SLOT_NOT_RESCHEDULABLE`), and the
   * edit's transaction rolls back with it.
   */
  async unscheduleForEdit(input: { contentItemId: string; actorUserId: string }): Promise<void> {
    const now = this.#clock.now();
    const slot = await this.#liveSlotFor(input.contentItemId);
    if (slot) {
      const { count } = await this.#db.calendarSlot.updateMany({
        where: { id: slot.id, status: { in: [...RESCHEDULABLE_SLOT_STATUSES] } },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      if (count === 0) throw slotNotReschedulable();
      if (slot.usageIdempotencyKey) {
        await this.#quota.refund(`${slot.usageIdempotencyKey}:refund`);
      }
      await this.#audit('content.schedule_cancelled', slot, input.actorUserId, {
        scheduledLocalTime: slot.scheduledLocalTime,
        timezone: slot.timezone,
        reason: 'edited_without_schedule_permission',
      });
    }
    const item = await this.#db.contentItem.findUnique({ where: { id: input.contentItemId } });
    if (item?.status === 'SCHEDULED') {
      await this.#db.contentItem.update({ where: { id: item.id }, data: { status: 'DRAFT' } });
    }
  }

  /** The live slot for an item, if it has one. */
  async slotForItem(contentItemId: string): Promise<CalendarSlot | null> {
    return this.#liveSlotFor(contentItemId);
  }

  // -------------------------------------------------------------------------

  /*
   * THE SCOPE IS IN THE QUERY, NOT AFTER IT (D-132).
   *
   * These read a row the caller is about to MUTATE, and they used to fetch it
   * by id and then compare `brandId` against the scope in JavaScript. The
   * outcome was the same — a not-found either way — but the row was read
   * first, which is the shape D-132 exists to remove: the authorization
   * predicate belongs in the `where`, so an out-of-scope row is never
   * retrieved and no later edit can forget the check.
   *
   * `brandIdQueryFilter` reads an empty scope as UNRESTRICTED, so an internal
   * caller with no restriction is unaffected, and the refusal is the same
   * not-found a genuine miss gives (F-74, docs/SECURITY.md §4.2).
   */
  async #requireItem(
    contentItemId: string,
    actorBrandScope: readonly string[],
  ): Promise<ContentItem> {
    const item = await this.#db.contentItem.findFirst({
      where: { id: contentItemId, ...brandIdQueryFilter({ brandScope: actorBrandScope }) },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();
    return item;
  }

  async #requireSlot(slotId: string, actorBrandScope: readonly string[]): Promise<CalendarSlot> {
    const slot = await this.#db.calendarSlot.findFirst({
      where: { id: slotId, ...brandIdQueryFilter({ brandScope: actorBrandScope }) },
    });
    if (!slot) throw calendarSlotNotFound();
    return slot;
  }

  async #liveSlotFor(contentItemId: string): Promise<CalendarSlot | null> {
    return this.#db.calendarSlot.findFirst({
      where: { workspaceId: this.#workspaceId, ...liveSlotWhere(contentItemId) },
    });
  }

  async #viewOf(slot: CalendarSlot): Promise<CalendarSlotView> {
    const item = await this.#db.contentItem.findUnique({
      where: { id: slot.contentItemId },
      include: { variants: { orderBy: { platformKey: 'asc' } } },
    });
    if (!item || item.deletedAt) throw calendarSlotNotFound();
    return { slot, item, variants: item.variants };
  }

  /**
   * Turn a wall-clock into the instant it means, or refuse.
   *
   * A SKIPPED TIME IS ACCEPTED, NOT REFUSED, and moved to the instant the clock
   * jumps to. Refusing would mean a customer in a DST zone gets an unexplainable
   * error for one hour a year on a form that offers them the choice; the
   * resolution is the same one every calendar application makes, and it is
   * recorded on the row as the intent so it stays inspectable.
   */
  #resolveInstant(localTime: string): Date {
    const resolved = resolveZonedTime(localTime, this.#timezone);
    if (!resolved) throw invalidScheduleTime();

    const now = this.#clock.now();
    const leadMs = this.#policy.calendar.minLeadMinutes * 60_000;
    if (resolved.instant.getTime() < now.getTime() + leadMs) throw scheduleTooSoon();

    const horizonMs = this.#policy.calendar.maxDaysAhead * 24 * 3_600_000;
    if (resolved.instant.getTime() > now.getTime() + horizonMs) throw scheduleTooFarAhead();

    return resolved.instant;
  }

  /** The configured ceiling on one local day's plan. */
  async #assertDayHasRoom(instant: Date, excludingSlotId: string | null): Promise<void> {
    const { dayStart, dayEnd } = this.#dayRange(instant);

    const used = await this.#db.calendarSlot.count({
      where: {
        scheduledAtUtc: { gte: dayStart, lt: dayEnd },
        status: { not: 'CANCELLED' },
        ...(excludingSlotId ? { id: { not: excludingSlotId } } : {}),
      },
    });
    if (used >= this.#policy.calendar.maxSlotsPerDay) throw dayIsFull();
  }

  /**
   * The range one local day's cap is counted over: from the day's local
   * midnight, for 24 hours. (A fixed 24 hours rather than the day's real
   * length across a DST change — a recorded follow-up, unchanged here.)
   */
  #dayRange(instant: Date): { dayStart: Date; dayEnd: Date } {
    const day = formatLocalTime(instant, this.#timezone).slice(0, 10);
    const start = instantForIntent(`${day}T00:00`, this.#timezone);
    // A day whose midnight does not exist is a DST gap at 00:00 — real, in a
    // handful of zones. Counting from one minute later is correct and is not
    // worth refusing the whole request over.
    const dayStart = start ?? instant;
    return { dayStart, dayEnd: new Date(dayStart.getTime() + 24 * 3_600_000) };
  }

  #audit(
    action: string,
    slot: CalendarSlot,
    actorUserId: string,
    after: Record<string, unknown>,
  ): Promise<unknown> {
    // Times, zones and counts — never a caption. A scheduled launch caption is
    // the most commercially sensitive string the product holds.
    return writeAuditEvent(this.#db, this.#workspaceId, {
      action,
      actorType: 'USER',
      actorId: actorUserId,
      resourceType: 'CalendarSlot',
      resourceId: slot.id,
      brandId: slot.brandId,
      after: after as never,
    });
  }
}
