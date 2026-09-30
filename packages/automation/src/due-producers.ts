import { recordRuleAutomationEvent, type TenantScopedClient } from '@brandspace/database';
import { DUE_EVENT_DEFINITIONS, TIMED_PRODUCER_LIMITS } from './registry';
import type { SharedReads } from './analytics-events';
import type { AutomationPolicy } from './policy';
import { moveState } from './threshold-producer';
import {
  dayKeyOf,
  edgeTransitionSinceArming,
  localDayKey,
  producerCeiling,
  producerFloor,
  selectDue,
  shiftDayKey,
  type DueCandidate,
  type KnowledgeValidityPort,
  type LocalCalendarPort,
} from './due-events';

/**
 * PHASE 2B-3 PR 3 — ONE VISIT OF ONE TIMED G13 RULE.
 *
 * The API's `MaintenanceScheduler` enumerates the due rules across tenants and
 * calls one of these per rule, inside that tenant's own transaction
 * (`withWorkspace`), exactly as it does for the threshold producer. Everything
 * a function here reads is read under RLS and bound to the RULE'S brand; it
 * writes the rule's events and moves the rule's own cursor, and nothing else.
 *
 * THE EVENTS AND THE CURSOR COMMIT TOGETHER (D-186). A crash between them
 * leaves both as they were, so the next sweep simply does it again.
 *
 * NOTHING HERE IS HELD IN MEMORY BETWEEN SWEEPS, AND NOTHING ASSUMES ONE
 * SCHEDULER. Two replicas visiting the same rule at once compute the same
 * occurrences; `automation_event_workspaceId_dedupeKey_key` keeps one row per
 * occurrence between them, and the cursor only ever moves forward.
 */

/** The rule row a producer reads — re-read inside the tenant's transaction. */
export interface DueRuleRow {
  readonly id: string;
  readonly brandId: string;
  readonly armedAt: Date | null;
  readonly dueWatermark: Date | null;
  readonly thresholdBreached: boolean | null;
  readonly thresholdCycle: number;
  readonly thresholdEvaluatedAt: Date | null;
}

export interface DueProducerContext {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly rule: DueRuleRow;
  readonly now: Date;
  readonly timezone: string;
  readonly calendar: LocalCalendarPort;
  /** Brand Brain's usable-fact rule; without it FACT_EXPIRING produces nothing. */
  readonly knowledge?: KnowledgeValidityPort | undefined;
  /**
   * Phase 2B-3 PR 4 — what the analytics events read, resolved once per sweep:
   * the operator thresholds, analytics' settling window, and the reads shared
   * by every rule of a brand. Without it the analytics producers produce nothing.
   */
  readonly analytics?: AnalyticsEventInputs | undefined;
}

export interface AnalyticsEventInputs {
  readonly events: AutomationPolicy['events'];
  /** `analytics.ingestion.refreshWindowDays`: how many recent days are not settled yet. */
  readonly refreshWindowDays: number;
  readonly shared: SharedReads;
}

export interface DueVisit {
  /** Events actually written (a duplicate another replica wrote counts as none). */
  readonly produced: number;
  /** The visit stopped at the per-visit cap: look at the rule again at once. */
  readonly more: boolean;
  /** The next instant something could fall due, when the producer knows it. */
  readonly next: Date | null;
  /** Occurrences deliberately not announced (campaign lateness), for the log. */
  readonly skippedLate: number;
}

const NOTHING: DueVisit = { produced: 0, more: false, next: null, skippedLate: 0 };

/**
 * MOVE THE CURSOR FORWARD, NEVER BACK.
 *
 * Not a compare-and-swap on the value read: a timestamp read back through a
 * millisecond `Date` cannot be compared for equality with a microsecond column
 * with any confidence. A forward-only update is enough — a replica that computed
 * less than another has already written cannot pull the cursor back past it.
 */
export async function advanceDueWatermark(
  db: TenantScopedClient,
  workspaceId: string,
  ruleId: string,
  watermark: Date,
): Promise<void> {
  await db.automationRule.updateMany({
    where: {
      id: ruleId,
      workspaceId,
      OR: [{ dueWatermark: null }, { dueWatermark: { lt: watermark } }],
    },
    data: { dueWatermark: watermark },
  });
}

/** How many candidate rows one visit reads before it stops and continues next time. */
const CANDIDATE_READ_LIMIT = TIMED_PRODUCER_LIMITS.maxOccurrencesPerVisit * 4;

/**
 * Cap the selection to what was read. When the read itself was full, anything
 * beyond it is still to come: the visit reports `more`, and when it emitted
 * everything it read the cursor stops at the LAST THING READ — never at the
 * ceiling, which would step over the unread rest.
 *
 * The caller completes the tie group at the edge of the read first (every row
 * sharing the last row's due), so an exclusive floor at that instant cannot
 * drop the part of the group the limit cut off.
 */
function withinRead<T extends DueCandidate>(
  selection: ReturnType<typeof selectDue<T>>,
  readFull: boolean,
  lastRead: Date | null,
): { emit: readonly T[]; watermark: Date; more: boolean } {
  if (!readFull || selection.more || !lastRead) return selection;
  return { emit: selection.emit, watermark: lastRead, more: true };
}

/** The latest due among candidates, or null. */
function latestDue(candidates: readonly DueCandidate[]): Date | null {
  let latest: Date | null = null;
  for (const candidate of candidates) {
    if (!latest || candidate.due.getTime() > latest.getTime()) latest = candidate.due;
  }
  return latest;
}

/** Rows by id, first occurrence kept — merges a completed tie group into a read. */
function uniqueById<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

// ---------------------------------------------------------------------------
// REVIEW_WAITING_24H
// ---------------------------------------------------------------------------

const REVIEW_WAIT_MS = DUE_EVENT_DEFINITIONS.reviewWaitHours * 3_600_000;

/**
 * A review cycle still open `reviewWaitHours` after it was asked for.
 *
 * THE CLOCK STARTS AT `approval.createdAt` — the moment that cycle was
 * submitted. Each cycle is its own row and the row's `createdAt` is write-once
 * (`approval_write_once`), so it is exactly "when this review was asked for";
 * never the post's `updatedAt`. Absolute time: the 24 hours are 24 hours in
 * every zone and across every daylight-saving change.
 *
 * Only PENDING cycles; decided and cancelled ones are not waiting. It is
 * checked again when the event is delivered, so a review decided in between
 * does nothing.
 */
export async function produceReviewWaiting(context: DueProducerContext): Promise<DueVisit> {
  const { db, workspaceId, rule, now } = context;
  const floor = producerFloor(rule);
  if (!floor) return NOTHING;
  const ceiling = producerCeiling(now);
  if (ceiling.getTime() <= floor.getTime()) {
    return { ...NOTHING, next: new Date(floor.getTime() + 1) };
  }

  const pendingInBrand = { workspaceId, brandId: rule.brandId, status: 'PENDING' } as const;
  const read = await db.approval.findMany({
    where: {
      ...pendingInBrand,
      createdAt: {
        gt: new Date(floor.getTime() - REVIEW_WAIT_MS),
        lte: new Date(ceiling.getTime() - REVIEW_WAIT_MS),
      },
    },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_READ_LIMIT,
  });
  const readFull = read.length === CANDIDATE_READ_LIMIT;
  const edge = read.at(-1);
  // The column keeps microseconds and a `Date` only milliseconds, so the tie
  // group is the edge row's whole millisecond.
  const rows =
    readFull && edge
      ? uniqueById([
          ...read,
          ...(await db.approval.findMany({
            where: {
              ...pendingInBrand,
              createdAt: {
                gte: edge.createdAt,
                lt: new Date(edge.createdAt.getTime() + 1),
              },
            },
            select: { id: true, createdAt: true },
          })),
        ])
      : read;
  const candidates = rows.map((row) => ({
    id: row.id,
    due: new Date(row.createdAt.getTime() + REVIEW_WAIT_MS),
  }));
  const selection = withinRead(
    selectDue({ candidates, floor, ceiling }),
    readFull,
    latestDue(candidates),
  );

  let produced = 0;
  for (const candidate of selection.emit) {
    const wrote = await recordRuleAutomationEvent(db, workspaceId, {
      triggerType: 'REVIEW_WAITING_24H',
      brandId: rule.brandId,
      ruleId: rule.id,
      approvalId: candidate.id,
    });
    if (wrote) produced += 1;
  }
  await advanceDueWatermark(db, workspaceId, rule.id, selection.watermark);

  // The next review to cross its wait, so the rule is looked at then.
  const upcoming = selection.more
    ? null
    : await db.approval.findFirst({
        where: {
          ...pendingInBrand,
          createdAt: { gt: new Date(ceiling.getTime() - REVIEW_WAIT_MS) },
        },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

  return {
    produced,
    more: selection.more,
    next: upcoming
      ? new Date(
          upcoming.createdAt.getTime() +
            REVIEW_WAIT_MS +
            TIMED_PRODUCER_LIMITS.watermarkLagSeconds * 1_000,
        )
      : null,
    skippedLate: 0,
  };
}

// ---------------------------------------------------------------------------
// CAMPAIGN_STARTED / CAMPAIGN_ENDED
// ---------------------------------------------------------------------------

/**
 * THE CAMPAIGNS WHOSE DATES ARE EVENTS (revised report §12, owner decision E):
 * planned, running, paused or completed — not a draft, not archived (archiving
 * also sets `deletedAt`), not deleted — and only with the date set.
 */
export const BOUNDARY_CAMPAIGN_STATUSES = ['PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED'] as const;

/**
 * The instant a campaign's start or end is, in the workspace's zone.
 *
 * STARTED: local 00:00 on `startDate`. ENDED: local 00:00 on the day AFTER
 * `endDate` — the end date is the campaign's last day, inclusive, the same rule
 * `campaignResultsPeriod` uses. Both through the platform's zoned-time resolver:
 * a midnight that does not exist (a daylight-saving gap at 00:00) is the first
 * instant after it; one that happens twice is the earlier.
 */
export function campaignBoundary(input: {
  readonly kind: 'CAMPAIGN_STARTED' | 'CAMPAIGN_ENDED';
  readonly dayKey: string;
  readonly timezone: string;
  readonly calendar: LocalCalendarPort;
}): Date | null {
  const day = input.kind === 'CAMPAIGN_STARTED' ? input.dayKey : shiftDayKey(input.dayKey, 1);
  return input.calendar.localMidnight(day, input.timezone);
}

/**
 * A campaign's start (or end) boundary passed after the rule was armed.
 *
 * AFTER AN OUTAGE (owner decision A): a boundary more than
 * `campaignBoundaryMaxLatenessHours` older than now when the sweep reaches it is
 * NOT announced — "your campaign started" three days late is not news. It is
 * skipped, counted for the log, and the cursor moves past it all the same, so it
 * is never reconsidered. A boundary that is only a little late still fires.
 *
 * A date moved to a later day is a new occurrence (the date is in the key); a
 * date moved to a boundary the cursor has already passed does not fire.
 */
export async function produceCampaignBoundaries(
  kind: 'CAMPAIGN_STARTED' | 'CAMPAIGN_ENDED',
  context: DueProducerContext,
): Promise<DueVisit> {
  const { db, workspaceId, rule, now, timezone, calendar } = context;
  const floor = producerFloor(rule);
  if (!floor) return NOTHING;
  const ceiling = producerCeiling(now);
  const horizon = ceiling.getTime() > floor.getTime() ? ceiling : floor;
  // Boundaries are local midnights, so the next one after the horizon is the
  // start of the horizon's next local day.
  const nextMidnight = calendar.localMidnight(
    shiftDayKey(localDayKey(horizon, timezone), 1),
    timezone,
  );
  const next = nextMidnight
    ? new Date(nextMidnight.getTime() + TIMED_PRODUCER_LIMITS.watermarkLagSeconds * 1_000)
    : null;
  if (ceiling.getTime() <= floor.getTime()) return { ...NOTHING, next };

  /*
   * THE DATES WHOSE BOUNDARY FALLS IN (floor, ceiling], EXACTLY. A day's local
   * midnight is its first instant, so it is at or before any instant of that
   * day: a boundary is after the floor only from the floor's NEXT local day,
   * and at or before the ceiling up to the ceiling's own day. ENDED's boundary
   * is the day after `endDate`, so its column range is one day earlier.
   */
  const shift = kind === 'CAMPAIGN_STARTED' ? 0 : -1;
  const from = dayKeyDate(shiftDayKey(localDayKey(floor, timezone), 1 + shift));
  const to = dayKeyDate(shiftDayKey(localDayKey(ceiling, timezone), shift));
  const eligible = {
    workspaceId,
    brandId: rule.brandId,
    deletedAt: null,
    status: { in: [...BOUNDARY_CAMPAIGN_STATUSES] },
  };
  const select = { id: true, startDate: true, endDate: true } as const;
  const read =
    kind === 'CAMPAIGN_STARTED'
      ? await db.campaign.findMany({
          where: { ...eligible, startDate: { gte: from, lte: to } },
          select,
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
          take: CANDIDATE_READ_LIMIT,
        })
      : await db.campaign.findMany({
          where: { ...eligible, endDate: { gte: from, lte: to } },
          select,
          orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
          take: CANDIDATE_READ_LIMIT,
        });
  const dateOf = (row: (typeof read)[number]) =>
    kind === 'CAMPAIGN_STARTED' ? row.startDate : row.endDate;
  const readFull = read.length === CANDIDATE_READ_LIMIT;
  const edgeDate = read.length > 0 ? dateOf(read[read.length - 1]!) : null;
  // Every campaign on the edge date shares its boundary: take the whole day.
  const rows =
    readFull && edgeDate
      ? uniqueById([
          ...read,
          ...(kind === 'CAMPAIGN_STARTED'
            ? await db.campaign.findMany({ where: { ...eligible, startDate: edgeDate }, select })
            : await db.campaign.findMany({ where: { ...eligible, endDate: edgeDate }, select })),
        ])
      : read;

  const candidates: (DueCandidate & { dayKey: string })[] = [];
  for (const row of rows) {
    const date = dateOf(row);
    if (!date) continue;
    const dayKey = dayKeyOf(date);
    const due = campaignBoundary({ kind, dayKey, timezone, calendar });
    if (due && due.getTime() > floor.getTime() && due.getTime() <= ceiling.getTime()) {
      candidates.push({ id: row.id, due, dayKey });
    }
  }
  const lateBefore =
    now.getTime() - TIMED_PRODUCER_LIMITS.campaignBoundaryMaxLatenessHours * 3_600_000;
  const late = candidates.filter((candidate) => candidate.due.getTime() <= lateBefore);
  const fresh = candidates.filter((candidate) => candidate.due.getTime() > lateBefore);

  // Late boundaries are all older than any fresh one, so the cursor passes
  // them whichever way the visit ends — they are skipped, never reconsidered.
  const selection = withinRead(
    selectDue({ candidates: fresh, floor, ceiling }),
    readFull,
    latestDue(candidates),
  );

  let produced = 0;
  for (const candidate of selection.emit) {
    const wrote = await recordRuleAutomationEvent(db, workspaceId, {
      triggerType: kind,
      brandId: rule.brandId,
      ruleId: rule.id,
      campaignId: candidate.id,
      dayKey: candidate.dayKey,
    });
    if (wrote) produced += 1;
  }
  await advanceDueWatermark(db, workspaceId, rule.id, selection.watermark);
  // A late boundary counts once: only those this visit's cursor moves past.
  const passed = late.filter(
    (candidate) => candidate.due.getTime() <= selection.watermark.getTime(),
  ).length;
  return { produced, more: selection.more, next, skippedLate: passed };
}

/** A `YYYY-MM-DD` as the value a `DATE` column is compared with. */
function dayKeyDate(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

export const produceCampaignStarted = (context: DueProducerContext): Promise<DueVisit> =>
  produceCampaignBoundaries('CAMPAIGN_STARTED', context);
export const produceCampaignEnded = (context: DueProducerContext): Promise<DueVisit> =>
  produceCampaignBoundaries('CAMPAIGN_ENDED', context);

// ---------------------------------------------------------------------------
// SCHEDULE_GAP
// ---------------------------------------------------------------------------

/** What counts as "something scheduled": on the calendar, not yet publishing. */
export const SCHEDULE_GAP_SLOT_STATUSES = ['PLANNED', 'SCHEDULED'] as const;

/**
 * THE NEXT `scheduleGapDays` LOCAL DAYS, STARTING TOMORROW: from local 00:00
 * tomorrow up to (not including) local 00:00 on the day after the last one.
 * Real local days in the workspace's zone — not 72 hours, and not UTC days — so
 * a day that is 23 or 25 hours long is that long here too.
 */
export function scheduleGapWindow(input: {
  readonly now: Date;
  readonly timezone: string;
  readonly calendar: LocalCalendarPort;
}): { readonly from: Date; readonly to: Date } | null {
  const tomorrow = shiftDayKey(localDayKey(input.now, input.timezone), 1);
  const from = input.calendar.localMidnight(tomorrow, input.timezone);
  const to = input.calendar.localMidnight(
    shiftDayKey(tomorrow, DUE_EVENT_DEFINITIONS.scheduleGapDays),
    input.timezone,
  );
  return from && to ? { from, to } : null;
}

/** Is nothing of the brand planned or scheduled in the window? One indexed probe. */
export async function scheduleGapIsOpen(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly window: { readonly from: Date; readonly to: Date };
  },
): Promise<boolean> {
  const slot = await db.calendarSlot.findFirst({
    where: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      status: { in: [...SCHEDULE_GAP_SLOT_STATUSES] },
      scheduledAtUtc: { gte: input.window.from, lt: input.window.to },
    },
    select: { id: true },
  });
  return slot === null;
}

/**
 * The brand's calendar going empty for the next few days — a STATE, not a
 * moment (owner decision A: nothing is replayed after an outage; only the state
 * now matters).
 *
 * EDGE-TRIGGERED on the D-177 memory, moved by the same compare-and-set as the
 * threshold producer: filled → empty fires once; empty → still empty is steady;
 * empty → filled re-arms by advancing the cycle, so the next gap is a new
 * event. The event is `SCHEDULE_GAP:<ruleId>:<cycle>`.
 *
 * NO BACKFILL: memory recorded before the current arming counts as none, so the
 * first look after arming only ESTABLISHES the state. Establishing also advances
 * the cycle, so a cycle whose key was used before a switch-off can never be
 * handed out again and swallowed as a duplicate.
 */
export async function produceScheduleGap(context: DueProducerContext): Promise<DueVisit> {
  const { db, workspaceId, rule, now, timezone, calendar } = context;
  if (!rule.armedAt) return NOTHING;
  const window = scheduleGapWindow({ now, timezone, calendar });
  if (!window) return NOTHING;
  // The window moves at the next local midnight — the start of tomorrow.
  const next = window.from;

  const empty = await scheduleGapIsOpen(db, { workspaceId, brandId: rule.brandId, window });
  const transition = edgeTransitionSinceArming({
    armedAt: rule.armedAt,
    evaluatedAt: rule.thresholdEvaluatedAt,
    previous: rule.thresholdBreached,
    current: empty,
  });

  switch (transition.kind) {
    case 'unmeasured':
    case 'steady':
      return { ...NOTHING, next };
    case 'establish':
      await moveState(db, workspaceId, rule, {
        breached: transition.breached,
        cycle: rule.thresholdCycle + 1,
        now,
      });
      return { ...NOTHING, next };
    case 'rearm':
      await moveState(db, workspaceId, rule, {
        breached: false,
        cycle: rule.thresholdCycle + 1,
        now,
      });
      return { ...NOTHING, next };
    case 'fire': {
      // The claim, then the event, with nothing between them that can decline:
      // both commit or neither does (D-186). A lost claim writes nothing.
      const claimed = await moveState(db, workspaceId, rule, {
        breached: true,
        cycle: rule.thresholdCycle,
        now,
      });
      if (!claimed) return { ...NOTHING, next };
      const wrote = await recordRuleAutomationEvent(db, workspaceId, {
        triggerType: 'SCHEDULE_GAP',
        brandId: rule.brandId,
        ruleId: rule.id,
        cycle: rule.thresholdCycle,
      });
      return { ...NOTHING, produced: wrote ? 1 : 0, next };
    }
  }
}

// ---------------------------------------------------------------------------
// FACT_EXPIRING
// ---------------------------------------------------------------------------

const FACT_WINDOW_DAYS = DUE_EVENT_DEFINITIONS.factExpiryWindowDays;

/**
 * THE FACTS THAT ARE "EXPIRING": usable today by Brand Brain's own rule
 * (ACTIVE or STALE, not expired — owner decision F), in the rule's brand, with
 * a last valid day within `factExpiryWindowDays` local days of today: from
 * today to today + 6, calendar days in the workspace's zone.
 */
export function expiringFactsWhere(input: {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly asOf: Date;
  readonly knowledge: KnowledgeValidityPort;
}) {
  const last = dayKeyDate(shiftDayKey(dayKeyOf(input.asOf), FACT_WINDOW_DAYS - 1));
  return {
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    AND: [input.knowledge.usableWhere(input.asOf), { validUntil: { gte: input.asOf, lte: last } }],
  };
}

/** Local 00:00 on the first day a fact whose last day is `validUntil` is in the window. */
export function factWindowOpens(input: {
  readonly validUntil: string;
  readonly timezone: string;
  readonly calendar: LocalCalendarPort;
}): Date | null {
  return input.calendar.localMidnight(
    shiftDayKey(input.validUntil, -(FACT_WINDOW_DAYS - 1)),
    input.timezone,
  );
}

/**
 * WHEN THE FACT'S CURRENT `validUntil` WAS SET: the `recordedAt` of the first
 * version after the last one that carried a different value. Versions are
 * append-only snapshots of the fact after each change, so that is the change
 * that gave the fact the date it has now. Two probes on
 * `brand_knowledge_version_knowledgeItemId_version_key`.
 */
async function validUntilSetAt(
  db: TenantScopedClient,
  workspaceId: string,
  knowledgeItemId: string,
  validUntil: Date,
): Promise<Date | null> {
  const differing = await db.brandKnowledgeVersion.findFirst({
    where: {
      workspaceId,
      knowledgeItemId,
      OR: [{ validUntil: null }, { validUntil: { not: validUntil } }],
    },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const setter = await db.brandKnowledgeVersion.findFirst({
    where: {
      workspaceId,
      knowledgeItemId,
      validUntil,
      version: { gt: differing?.version ?? 0 },
    },
    orderBy: { version: 'asc' },
    select: { recordedAt: true },
  });
  return setter?.recordedAt ?? null;
}

/**
 * A usable fact ENTERING its last seven days after the rule was armed (revised
 * report §12). It enters at the later of local 00:00 on `validUntil − 6` — the
 * window reaching it — and the moment its current date was set — the date
 * moving it into the window. A fact already in the window when the rule was
 * armed never fires; a later change of its date is a new occurrence, keyed
 * `FACT_EXPIRING:<ruleId>:<itemId>:<validUntil>`.
 *
 * AFTER AN OUTAGE it may fire late (owner decision A): the delivery re-checks
 * that the fact is still usable and still expiring on that day. Nothing about
 * the fact but its id travels in the event, and no action here reads its text.
 */
export async function produceFactExpiring(context: DueProducerContext): Promise<DueVisit> {
  const { db, workspaceId, rule, now, timezone, calendar, knowledge } = context;
  const floor = producerFloor(rule);
  if (!floor || !knowledge) return NOTHING;
  const ceiling = producerCeiling(now);
  const asOf = knowledge.asOf(timezone, now);
  const lag = TIMED_PRODUCER_LIMITS.watermarkLagSeconds * 1_000;
  const tomorrow = calendar.localMidnight(shiftDayKey(dayKeyOf(asOf), 1), timezone);
  const atMidnight = tomorrow ? new Date(tomorrow.getTime() + lag) : null;
  if (ceiling.getTime() <= floor.getTime()) return { ...NOTHING, next: atMidnight };

  const facts = await db.brandKnowledgeItem.findMany({
    where: expiringFactsWhere({ workspaceId, brandId: rule.brandId, asOf, knowledge }),
    select: { id: true, validUntil: true },
    orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
  });

  const candidates: (DueCandidate & { dayKey: string })[] = [];
  for (const fact of facts) {
    if (!fact.validUntil) continue;
    const dayKey = dayKeyOf(fact.validUntil);
    const opens = factWindowOpens({ validUntil: dayKey, timezone, calendar });
    const setAt = await validUntilSetAt(db, workspaceId, fact.id, fact.validUntil);
    // A fact whose date nobody can account for fails closed.
    if (!opens || !setAt) continue;
    const due = opens.getTime() >= setAt.getTime() ? opens : setAt;
    candidates.push({ id: fact.id, due, dayKey });
  }
  const selection = selectDue({ candidates, floor, ceiling });

  let produced = 0;
  for (const candidate of selection.emit) {
    const wrote = await recordRuleAutomationEvent(db, workspaceId, {
      triggerType: 'FACT_EXPIRING',
      brandId: rule.brandId,
      ruleId: rule.id,
      knowledgeItemId: candidate.id,
      validUntil: candidate.dayKey,
    });
    if (wrote) produced += 1;
  }
  await advanceDueWatermark(db, workspaceId, rule.id, selection.watermark);

  // Something set in the last moments falls due once it is behind the lag.
  const soonest = candidates
    .filter((candidate) => candidate.due.getTime() > ceiling.getTime())
    .reduce<Date | null>(
      (earliest, candidate) =>
        !earliest || candidate.due.getTime() < earliest.getTime() ? candidate.due : earliest,
      null,
    );
  const soon = soonest ? new Date(soonest.getTime() + lag) : null;
  const next = soon && (!atMidnight || soon.getTime() < atMidnight.getTime()) ? soon : atMidnight;
  return { produced, more: selection.more, next, skippedLate: 0 };
}
