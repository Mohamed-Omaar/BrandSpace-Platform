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
  | { readonly triggerType: 'CONTENT_APPROVED'; readonly refType: 'ContentItem' }
  | { readonly triggerType: 'CONTENT_SCHEDULED'; readonly refType: 'CalendarSlot' }
  | { readonly triggerType: 'POST_PUBLISHED'; readonly refType: 'PublishJob' }
  | { readonly triggerType: 'ANALYTICS_REFRESHED'; readonly refType: 'AnalyticsIngestionRun' };

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
        // times anything notices it.
        dedupeKey: `${event.triggerType}:${input.refId}`,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * Record an event DERIVED FROM A RULE'S OWN CONFIGURATION, addressed to that
 * rule.
 *
 * The two rule-derived triggers are not domain events and must not be delivered
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
  input:
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
      },
): Promise<boolean> {
  const timed = input.triggerType === 'SCHEDULED_TIME';
  const created = await db.automationEvent.createMany({
    data: [
      {
        workspaceId,
        brandId: input.brandId,
        triggerType: input.triggerType,
        ruleId: input.ruleId,
        refType: timed ? null : 'MetricObservation',
        refId: timed ? null : input.refId,
        occurrence: timed ? input.occurrence : null,
        /*
         * THE RULE AND ITS OCCASION. A timed rule's occasion is the local hour it
         * fired for, so a sweep that runs sixty times inside that hour writes ONE
         * row; a threshold rule's occasion is its ARMING CYCLE, so every sweep
         * while the metric stays past the line writes one row between them, and
         * the cycle only advances when the metric goes back and crosses again.
         */
        dedupeKey: timed
          ? `SCHEDULED_TIME:${input.ruleId}:${input.occurrence}`
          : `METRIC_THRESHOLD_CROSSED:${input.occurrenceKey}`,
      },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}
