import type { AutomationTrigger, TenantScopedClient } from '@brandspace/database';
import {
  dayKeyInEventKey,
  dayKeyOf,
  type KnowledgeValidityPort,
  type LocalCalendarPort,
} from './due-events';
import {
  BOUNDARY_CAMPAIGN_STATUSES,
  expiringFactsWhere,
  scheduleGapIsOpen,
  scheduleGapWindow,
} from './due-producers';
import { DUE_EVENT_DEFINITIONS } from './registry';

/**
 * PHASE 2B-3 PR 3 — DOES THE OCCURRENCE STILL HOLD WHEN IT IS DELIVERED?
 *
 * A timed event is produced by one sweep and run by a worker some time later —
 * normally seconds, after an outage much more. In between, the thing it is
 * about can stop being true: the review is decided, the campaign is archived or
 * its date moved, the empty days fill up, the fact is archived or its expiry
 * date changes. An action taken on an occurrence that no longer holds is an
 * action on something that did not happen.
 *
 * So the run re-reads the source row, and when it no longer matches the
 * occurrence the run ends SKIPPED `occurrence_stale` and no action runs
 * (revised report §11). Everything here is read through the tenant's own RLS
 * client and bound to the RULE'S brand, so an event can never be made to hold
 * by a row of another brand or workspace.
 *
 * A trigger without a case here is a domain event whose row is re-read by the
 * action itself; for those the occurrence always holds.
 */
export const OCCURRENCE_STALE = 'occurrence_stale';

export interface OccurrenceCheck {
  readonly workspaceId: string;
  /** The RULE's brand — the only brand an occurrence may belong to. */
  readonly brandId: string;
  readonly triggerType: AutomationTrigger;
  readonly refId: string | null;
  /** The outbox `dedupeKey`, which carries the date a dated occurrence was for. */
  readonly eventKey: string | null;
  readonly now: Date;
  /** The workspace's zone, asked only when the trigger needs it. */
  readonly timezone: () => Promise<string>;
  readonly calendar?: LocalCalendarPort | undefined;
  readonly knowledge?: KnowledgeValidityPort | undefined;
}

export async function occurrenceStillHolds(
  db: TenantScopedClient,
  check: OccurrenceCheck,
): Promise<boolean> {
  switch (check.triggerType) {
    /*
     * A REVIEW STILL WAITING: the cycle, in the rule's brand, still PENDING
     * and still past its wait. Decided, cancelled or gone, it is not waiting.
     */
    case 'REVIEW_WAITING_24H': {
      if (!check.refId) return false;
      const approval = await db.approval.findFirst({
        where: { id: check.refId, workspaceId: check.workspaceId, brandId: check.brandId },
        select: { status: true, createdAt: true },
      });
      return (
        approval?.status === 'PENDING' &&
        approval.createdAt.getTime() + DUE_EVENT_DEFINITIONS.reviewWaitHours * 3_600_000 <=
          check.now.getTime()
      );
    }
    /*
     * A CAMPAIGN BOUNDARY STILL ON THAT DAY: the campaign, in the rule's brand,
     * still planned, running, paused or completed, not archived or deleted, and
     * its start (or end) date still the day the event was produced for. A date
     * moved since is a different occurrence, produced on its own.
     */
    case 'CAMPAIGN_STARTED':
    case 'CAMPAIGN_ENDED': {
      const dayKey = dayKeyInEventKey(check.eventKey);
      if (!check.refId || !dayKey) return false;
      const campaign = await db.campaign.findFirst({
        where: {
          id: check.refId,
          workspaceId: check.workspaceId,
          brandId: check.brandId,
          deletedAt: null,
          status: { in: [...BOUNDARY_CAMPAIGN_STATUSES] },
        },
        select: { startDate: true, endDate: true },
      });
      const date =
        check.triggerType === 'CAMPAIGN_STARTED' ? campaign?.startDate : campaign?.endDate;
      return !!date && dayKeyOf(date) === dayKey;
    }
    /*
     * A GAP STILL OPEN: nothing of the rule's brand planned or scheduled in the
     * next days as they are NOW. Without the calendar the window cannot be
     * computed, and the run fails closed.
     */
    case 'SCHEDULE_GAP': {
      if (!check.calendar) return false;
      const window = scheduleGapWindow({
        now: check.now,
        timezone: await check.timezone(),
        calendar: check.calendar,
      });
      if (!window) return false;
      return scheduleGapIsOpen(db, {
        workspaceId: check.workspaceId,
        brandId: check.brandId,
        window,
      });
    }
    /*
     * A FACT STILL EXPIRING ON THAT DAY: still usable today by Brand Brain's
     * rule, in the rule's brand, still in its last seven days, and its last day
     * still the one the event was produced for. Archived, expired, withdrawn
     * from review or given another date, it no longer holds. Without the
     * knowledge port the rule cannot be asked, and the run fails closed.
     */
    case 'FACT_EXPIRING': {
      const dayKey = dayKeyInEventKey(check.eventKey);
      if (!check.refId || !dayKey || !check.knowledge) return false;
      const asOf = check.knowledge.asOf(await check.timezone(), check.now);
      const fact = await db.brandKnowledgeItem.findFirst({
        where: {
          id: check.refId,
          ...expiringFactsWhere({
            workspaceId: check.workspaceId,
            brandId: check.brandId,
            asOf,
            knowledge: check.knowledge,
          }),
        },
        select: { validUntil: true },
      });
      return !!fact?.validUntil && dayKeyOf(fact.validUntil) === dayKey;
    }
    default:
      return true;
  }
}
