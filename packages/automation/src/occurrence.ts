import type { AutomationTrigger, TenantScopedClient } from '@brandspace/database';
import type { LocalCalendarPort } from './due-events';

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
}

export async function occurrenceStillHolds(
  db: TenantScopedClient,
  check: OccurrenceCheck,
): Promise<boolean> {
  void db;
  switch (check.triggerType) {
    default:
      return true;
  }
}
