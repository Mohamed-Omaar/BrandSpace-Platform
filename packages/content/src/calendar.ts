import { randomUUID } from 'node:crypto';
import {
  writeAuditEvent,
  type CalendarSlot,
  type ContentItem,
  type ContentVariant,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  assertBrandInScope,
  brandIdScopeFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import {
  alreadyScheduled,
  approvalRequiredBeforeScheduling,
  calendarSlotNotFound,
  contentItemNotFound,
  dayIsFull,
  invalidScheduleTime,
  nothingToSchedule,
  scheduleQuotaExceeded,
  scheduleTooFarAhead,
  scheduleTooSoon,
  transitionNotAllowed,
} from './errors';
import type { ContentPolicy } from './policy';
import { formatLocalTime, instantForIntent, monthRangeUtc, resolveZonedTime } from './timezone';

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
   * OPTIONAL, and the fallback is the activated `content.calendar` value, so a
   * caller that has not wired Approvals behaves exactly as 5B-2 did rather than
   * failing or — far worse — silently letting unapproved content through.
   */
  readonly approvalGate?: ApprovalGate;
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
const SCHEDULABLE_FROM: readonly ContentItem['status'][] = ['DRAFT', 'APPROVED', 'SCHEDULED'];

export class ContentCalendarService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: ContentPolicy;
  readonly #timezone: string;
  readonly #quota: ScheduleQuota;
  readonly #clock: Clock;
  readonly #approvalGate: ApprovalGate | undefined;

  constructor(options: CalendarOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#timezone = options.timezone;
    this.#quota = options.quota;
    this.#clock = options.clock ?? systemClock;
    this.#approvalGate = options.approvalGate;
  }

  /**
   * AC-14.6 — is approval required before THIS brand's content may be planned?
   *
   * PER BRAND FIRST, the activated default second (Phase 5B-3). D-120 shipped
   * this as one workspace-wide switch that was off because nothing could grant
   * approval; now that the workflow exists, ROADMAP scope item 6's "policy per
   * brand" is what a customer actually configures. The old configuration value
   * remains the default for a brand that has not chosen.
   */
  async #approvalRequired(brandId: string): Promise<boolean> {
    if (this.#approvalGate) {
      return (await this.#approvalGate.policyForBrand(brandId)).requireApprovalBeforeScheduling;
    }
    return this.#policy.calendar.requireApprovalBeforeScheduling;
  }

  /** The zone every wall-clock on this calendar is expressed in. */
  get timezone(): string {
    return this.#timezone;
  }

  /** AC-14.1 — place a draft on the calendar at a chosen date and time. */
  async schedule(input: ScheduleInput): Promise<CalendarSlotView> {
    const item = await this.#requireItem(input.contentItemId, input.actorBrandScope);

    // AC-14.6. The gate, read from the brand's own policy (5B-3). With the
    // workflow behind it, `APPROVED` now means a named reviewer said so.
    if ((await this.#approvalRequired(item.brandId)) && item.status !== 'APPROVED') {
      throw approvalRequiredBeforeScheduling();
    }
    if (!SCHEDULABLE_FROM.includes(item.status)) throw transitionNotAllowed();

    const variants = await this.#db.contentVariant.findMany({
      where: { contentItemId: item.id },
      orderBy: { platformKey: 'asc' },
    });
    // A plan for content with no caption is a plan to publish nothing.
    if (variants.length === 0) throw nothingToSchedule();

    const live = await this.#liveSlotFor(item.id);
    if (live) throw alreadyScheduled();

    const instant = this.#resolveInstant(input.localTime);
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
    const usageIdempotencyKey = `calendar:${this.#workspaceId}:${slotId}`;
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
    });

    return { slot, item: updated, variants };
  }

  /** AC-14.8 — move a slot, and say so in the audit log. */
  async reschedule(input: {
    slotId: string;
    localTime: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<CalendarSlotView> {
    const slot = await this.#requireSlot(input.slotId, input.actorBrandScope);
    if (slot.status === 'CANCELLED') throw calendarSlotNotFound();

    const instant = this.#resolveInstant(input.localTime);
    await this.#assertDayHasRoom(instant, slot.id);

    const moved = await this.#db.calendarSlot.update({
      where: { id: slot.id },
      data: {
        scheduledAtUtc: instant,
        scheduledLocalTime: input.localTime,
        // The zone is re-copied, so a workspace that has since relocated moves
        // the posts it deliberately touches and leaves the rest where they are.
        timezone: this.#timezone,
      },
    });

    await this.#audit('content.rescheduled', moved, input.actorUserId, {
      fromLocalTime: slot.scheduledLocalTime,
      fromTimezone: slot.timezone,
      toLocalTime: moved.scheduledLocalTime,
      toTimezone: moved.timezone,
      toUtc: moved.scheduledAtUtc.toISOString(),
    });

    return this.#viewOf(moved);
  }

  /** AC-14.8 — take a slot off the calendar, refund its quota, audit it. */
  async cancel(input: {
    slotId: string;
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<CalendarSlot> {
    const slot = await this.#requireSlot(input.slotId, input.actorBrandScope);
    if (slot.status === 'CANCELLED') return slot;

    const cancelled = await this.#db.calendarSlot.update({
      where: { id: slot.id },
      data: { status: 'CANCELLED', cancelledAt: this.#clock.now() },
    });

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
        ...(input.brandId ? { brandId: input.brandId } : {}),
        ...brandIdScopeFilter(input.brandScope),
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

  /** The live slot for an item, if it has one. */
  async slotForItem(contentItemId: string): Promise<CalendarSlot | null> {
    return this.#liveSlotFor(contentItemId);
  }

  // -------------------------------------------------------------------------

  async #requireItem(
    contentItemId: string,
    actorBrandScope: readonly string[],
  ): Promise<ContentItem> {
    const item = await this.#db.contentItem.findUnique({ where: { id: contentItemId } });
    if (!item || item.deletedAt) throw contentItemNotFound();
    // AFTER the row is known to exist but BEFORE anything is done with it, and
    // it throws the SAME shape a scope miss would (F-74, docs/SECURITY.md §4.2).
    assertBrandInScope(actorBrandScope, item.brandId);
    return item;
  }

  async #requireSlot(slotId: string, actorBrandScope: readonly string[]): Promise<CalendarSlot> {
    const slot = await this.#db.calendarSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw calendarSlotNotFound();
    assertBrandInScope(actorBrandScope, slot.brandId);
    return slot;
  }

  async #liveSlotFor(contentItemId: string): Promise<CalendarSlot | null> {
    return this.#db.calendarSlot.findFirst({
      where: { contentItemId, status: { not: 'CANCELLED' } },
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
    const day = formatLocalTime(instant, this.#timezone).slice(0, 10);
    const start = instantForIntent(`${day}T00:00`, this.#timezone);
    // A day whose midnight does not exist is a DST gap at 00:00 — real, in a
    // handful of zones. Counting from one minute later is correct and is not
    // worth refusing the whole request over.
    const dayStart = start ?? instant;
    const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

    const used = await this.#db.calendarSlot.count({
      where: {
        scheduledAtUtc: { gte: dayStart, lt: dayEnd },
        status: { not: 'CANCELLED' },
        ...(excludingSlotId ? { id: { not: excludingSlotId } } : {}),
      },
    });
    if (used >= this.#policy.calendar.maxSlotsPerDay) throw dayIsFull();
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
