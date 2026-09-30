import { recordRuleAutomationEvent, type TenantScopedClient } from '@brandspace/database';
import { DUE_EVENT_DEFINITIONS, TIMED_PRODUCER_LIMITS } from './registry';
import {
  producerCeiling,
  producerFloor,
  selectDue,
  type DueCandidate,
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
 * Cap the selection to what was read: when the read itself was full, anything
 * beyond it is still to come, so the cursor stops at the last thing emitted.
 */
function withinRead<T extends DueCandidate>(
  selection: ReturnType<typeof selectDue<T>>,
  readFull: boolean,
): { emit: readonly T[]; watermark: Date; more: boolean } {
  if (!readFull || selection.more || selection.emit.length === 0) return selection;
  const last = selection.emit[selection.emit.length - 1] as T;
  return { emit: selection.emit, watermark: last.due, more: true };
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

  const rows = await db.approval.findMany({
    where: {
      workspaceId,
      brandId: rule.brandId,
      status: 'PENDING',
      createdAt: {
        gt: new Date(floor.getTime() - REVIEW_WAIT_MS),
        lte: new Date(ceiling.getTime() - REVIEW_WAIT_MS),
      },
    },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_READ_LIMIT,
  });
  const candidates = rows.map((row) => ({
    id: row.id,
    due: new Date(row.createdAt.getTime() + REVIEW_WAIT_MS),
  }));
  const selection = withinRead(
    selectDue({ candidates, floor, ceiling }),
    rows.length === CANDIDATE_READ_LIMIT,
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
          workspaceId,
          brandId: rule.brandId,
          status: 'PENDING',
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
