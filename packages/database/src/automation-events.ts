import type { TenantScopedClient } from './tenant-client';

/**
 * THE AUTOMATION OUTBOX WRITER — CLAUDE.md §5's sibling for domain events.
 *
 * WHY IT LIVES HERE, BESIDE `writeAuditEvent`. The producers are spread across
 * four domain packages — content approvals, the calendar, publishing and
 * analytics ingestion — and every one of them may import `@brandspace/database`
 * while none may import `@brandspace/automation` or `@brandspace/jobs`. Putting
 * the writer in the one package they all already depend on is what lets a
 * content service record "this was approved" without content learning anything
 * about automations, and without a queue client appearing on an approval's
 * request path.
 *
 * IT WRITES A ROW AND NOTHING ELSE. No enqueue, no HTTP, no Redis. The caller is
 * inside its own domain transaction, so the event commits exactly when the thing
 * it describes commits. Dispatch belongs to the reconciliation sweep
 * (docs/ARCHITECTURE.md §9), which is what makes a lost queue a punctuality
 * problem rather than a correctness one.
 *
 * THE INPUT IS A DISCRIMINATED UNION SO THE WRONG PAIR CANNOT BE WRITTEN. A
 * producer that named `ContentItem` for a published post would aim three
 * content-shaped actions at a publish job's id — the same class the trigger/action
 * compatibility check already closed inside the engine. The type refuses it at
 * the call site, and `automation_event_ref_matches_trigger` refuses it in the
 * database, because a rule this important is not left to one of them.
 */

/** A domain event: it belongs to the BRAND, and every listening rule sees it. */
export type DomainAutomationEvent =
  /**
   * Phase 2B-3 PR 2 — ONE EVENT PER APPROVAL CYCLE. The reference stays the
   * content item (what the rule acts on); the IDENTITY is the approval that
   * decided the cycle, so a post withdrawn, edited, resubmitted and approved
   * again is a second event — which is what a person approving it again means.
   * Before PR 2 the key was the item's id and a re-approval was swallowed as a
   * duplicate of the first; those rows keep their keys and are never rewritten.
   */
  | {
      readonly triggerType: 'CONTENT_APPROVED';
      readonly refType: 'ContentItem';
      readonly approvalId: string;
    }
  | { readonly triggerType: 'CONTENT_SCHEDULED'; readonly refType: 'CalendarSlot' }
  | { readonly triggerType: 'POST_PUBLISHED'; readonly refType: 'PublishJob' }
  | { readonly triggerType: 'ANALYTICS_REFRESHED'; readonly refType: 'AnalyticsIngestionRun' }
  /**
   * Phase 2B-3 PR 2 — one publish job reached FAILED. The reference is the
   * ATTEMPT that concluded it (every FAILED transition names exactly one), so
   * each failure is its own event: a job retried by a person and failing again
   * is a second one.
   */
  | { readonly triggerType: 'POST_FAILED'; readonly refType: 'PublishAttempt' };

export interface DomainAutomationEventInput {
  readonly brandId: string;
  /** The row that IS the event. Its id is the event's identity. */
  readonly refId: string;
}

/**
 * Record a domain event for the automation engine.
 *
 * `ON CONFLICT DO NOTHING` (D-144) on the derived key: the approval of item X is
 * ONE event, and a caller that reaches this twice — a retried request, a
 * compensating path, a future second call site — must not produce a second.
 *
 * Returns whether a row was actually written, so a producer can say so in a log
 * without reading the row back.
 */
export async function recordAutomationEvent(
  db: TenantScopedClient,
  workspaceId: string,
  event: DomainAutomationEvent,
  input: DomainAutomationEventInput,
): Promise<boolean> {
  const created = await db.automationEvent.createMany({
    data: [
      {
        workspaceId,
        brandId: input.brandId,
        triggerType: event.triggerType,
        refType: event.refType,
        refId: input.refId,
        // THE IDENTITY OF THE EVENT, not of the attempt. The trigger and the row
        // it happened to: "item X was approved" is the same event however many
        // times anything notices it. An approval is identified by its CYCLE.
        dedupeKey: `${event.triggerType}:${
          event.triggerType === 'CONTENT_APPROVED' ? event.approvalId : input.refId
        }`,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * An event DERIVED FROM ONE RULE — its schedule, its threshold, or (Phase 2B-3
 * PR 3) a due date or a state read off that rule's brand — addressed to that
 * rule alone. `automation_event_rule_addressed_when_derived` says the same in
 * SQL.
 */
export type RuleAutomationEvent =
  | {
      readonly triggerType: 'SCHEDULED_TIME';
      readonly brandId: string;
      readonly ruleId: string;
      readonly occurrence: string;
    }
  | {
      readonly triggerType: 'METRIC_THRESHOLD_CROSSED';
      readonly brandId: string;
      readonly ruleId: string;
      /**
       * The reading the crossing was seen in. PROVENANCE, not identity —
       * see `occurrenceKey`.
       */
      readonly refId: string;
      /**
       * THE ARMING THIS EVENT BELONGS TO (R3-2), supplied by the caller
       * because only the sweep knows which cycle it just claimed.
       *
       * It is NOT the observation id, and that distinction is the whole
       * finding: an observation id changes every time a new reading lands, so
       * a key built from one de-duplicates a repeat until the metric is
       * measured again and then fires the same crossing a second time. A cycle
       * changes exactly when the rule re-arms, which is exactly when a second
       * event is legitimate.
       */
      readonly occurrenceKey: string;
    }
  /** Phase 2B-3 PR 3 — one open review cycle passed its waiting time. */
  | {
      readonly triggerType: 'REVIEW_WAITING_24H';
      readonly brandId: string;
      readonly ruleId: string;
      readonly approvalId: string;
    }
  /** Phase 2B-3 PR 3 — a campaign's start or end boundary, for the DATE it was on. */
  | {
      readonly triggerType: 'CAMPAIGN_STARTED' | 'CAMPAIGN_ENDED';
      readonly brandId: string;
      readonly ruleId: string;
      readonly campaignId: string;
      /** The campaign's `startDate` / `endDate`, `YYYY-MM-DD`. */
      readonly dayKey: string;
    }
  /** Phase 2B-3 PR 3 — the brand's next days became empty; one per empty stretch. */
  | {
      readonly triggerType: 'SCHEDULE_GAP';
      readonly brandId: string;
      readonly ruleId: string;
      readonly cycle: number;
    }
  /**
   * Phase 2B-3 PR 4 — the brand's weekly engagement went into "dropped", once
   * per episode of the rule's edge memory (the cycle).
   */
  | {
      readonly triggerType: 'WEEKLY_ENGAGEMENT_DROPPED';
      readonly brandId: string;
      readonly ruleId: string;
      readonly cycle: number;
    }
  /** Phase 2B-3 PR 4 — a post ranked in the brand's top 10%, once per rule and post. */
  | {
      readonly triggerType: 'POST_TOP_10_PERCENT';
      readonly brandId: string;
      readonly ruleId: string;
      readonly contentItemId: string;
    }
  /** Phase 2B-3 PR 3 — a fact entered its expiry window, for the `validUntil` it had. */
  | {
      readonly triggerType: 'FACT_EXPIRING';
      readonly brandId: string;
      readonly ruleId: string;
      readonly knowledgeItemId: string;
      /** `YYYY-MM-DD`. */
      readonly validUntil: string;
    };

/**
 * Record an event DERIVED FROM A RULE'S OWN CONFIGURATION, addressed to that
 * rule.
 *
 * Rule-derived triggers are not domain events and must not be delivered
 * like them. A schedule and a threshold are read off one rule; handing the
 * result to every rule on the brand would fire a rule whose own configuration
 * says a different hour or a different number.
 *
 * `occurrence` is REQUIRED for `SCHEDULED_TIME` and forbidden for the other,
 * which is what `automation_event_occurrence_is_timed` says in SQL.
 */
export async function recordRuleAutomationEvent(
  db: TenantScopedClient,
  workspaceId: string,
  input: RuleAutomationEvent,
): Promise<boolean> {
  const row = ruleEventRow(input);
  const created = await db.automationEvent.createMany({
    data: [
      {
        workspaceId,
        brandId: input.brandId,
        triggerType: input.triggerType,
        ruleId: input.ruleId,
        refType: row.refType,
        refId: row.refId,
        occurrence: row.occurrence,
        dedupeKey: row.dedupeKey,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * THE ROW EACH RULE-DERIVED EVENT IS, and — the part that matters — its
 * `dedupeKey`, the identity `@@unique([workspaceId, dedupeKey])` enforces.
 *
 * A timed rule's occasion is the local hour it fired for, so a sweep that runs
 * sixty times inside that hour writes ONE row; a threshold rule's occasion is
 * its ARMING CYCLE, so every sweep while the metric stays past the line writes
 * one row between them, and the cycle only advances when the metric goes back
 * and crosses again.
 *
 * PHASE 2B-3 PR 3 — the timed G13 events carry their identity the same way,
 * and it is the RULE plus the SUBJECT plus whatever makes a second occurrence
 * legitimate (revised report §11): a review cycle once; a campaign boundary per
 * DATE (a moved date is a new occurrence); a schedule gap per empty STRETCH; a
 * fact per `validUntil` (a changed expiry is a new occurrence). Two scheduler
 * replicas computing the same occurrence write one row between them.
 */
function ruleEventRow(input: RuleAutomationEvent): {
  refType: string | null;
  refId: string | null;
  occurrence: string | null;
  dedupeKey: string;
} {
  switch (input.triggerType) {
    case 'SCHEDULED_TIME':
      return {
        refType: null,
        refId: null,
        occurrence: input.occurrence,
        dedupeKey: `SCHEDULED_TIME:${input.ruleId}:${input.occurrence}`,
      };
    case 'METRIC_THRESHOLD_CROSSED':
      return {
        refType: 'MetricObservation',
        refId: input.refId,
        occurrence: null,
        dedupeKey: `METRIC_THRESHOLD_CROSSED:${input.occurrenceKey}`,
      };
    case 'REVIEW_WAITING_24H':
      return {
        refType: 'Approval',
        refId: input.approvalId,
        occurrence: null,
        dedupeKey: `REVIEW_WAITING_24H:${input.ruleId}:${input.approvalId}`,
      };
    case 'CAMPAIGN_STARTED':
    case 'CAMPAIGN_ENDED':
      return {
        refType: 'Campaign',
        refId: input.campaignId,
        occurrence: null,
        dedupeKey: `${input.triggerType}:${input.ruleId}:${input.campaignId}:${input.dayKey}`,
      };
    case 'SCHEDULE_GAP':
      return {
        refType: null,
        refId: null,
        occurrence: null,
        dedupeKey: `SCHEDULE_GAP:${input.ruleId}:${input.cycle}`,
      };
    case 'WEEKLY_ENGAGEMENT_DROPPED':
      return {
        refType: null,
        refId: null,
        occurrence: null,
        dedupeKey: `WEEKLY_ENGAGEMENT_DROPPED:${input.ruleId}:${input.cycle}`,
      };
    case 'POST_TOP_10_PERCENT':
      return {
        refType: 'ContentItem',
        refId: input.contentItemId,
        occurrence: null,
        dedupeKey: `POST_TOP_10_PERCENT:${input.ruleId}:${input.contentItemId}`,
      };
    case 'FACT_EXPIRING':
      return {
        refType: 'BrandKnowledgeItem',
        refId: input.knowledgeItemId,
        occurrence: null,
        dedupeKey: `FACT_EXPIRING:${input.ruleId}:${input.knowledgeItemId}:${input.validUntil}`,
      };
  }
}
