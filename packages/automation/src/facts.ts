import type { TenantScopedClient } from '@brandspace/database';
import { metricThresholdConfigSchema } from './schedule';
import { CONDITION_FIELD_TRIGGERS, type ConditionField } from './registry';
import type { AutomationTrigger } from '@brandspace/database';

/**
 * THE FACTS A CONDITION MAY READ, GATHERED FROM THE DATABASE AT DELIVERY.
 *
 * WHY THIS MOVED OUT OF THE WORKER (R3-3). It lived beside the queue consumer,
 * which meant the list of fields a customer could CHOOSE lived in one package
 * and the code that PRODUCES them lived in an application — and the two drifted,
 * exactly as they always do. `metric.changeMilli` was offered and produced by
 * nothing; `CONTENT_SCHEDULED` reached a calendar slot and produced no content
 * facts at all. Both were selectable, and both compared false for ever.
 *
 * Here, next to `CONDITION_FIELD_TRIGGERS`, a parity test can walk the declared
 * mapping against the real gatherer and fail the build when they disagree.
 *
 * NOT CARRIED IN THE MESSAGE, still. A fact in a queue payload was true when the
 * message was written; by the time it is read the draft may have been edited,
 * the post may have failed, the campaign may have been detached. An automation
 * acting on a stale fact is the hardest kind of bug to see, because the rule and
 * the data each look right on their own.
 *
 * THE SET IS CLOSED and matches `CONDITION_FIELDS` exactly: a condition can only
 * read a key this function puts here, so there is no path from a rule to a query
 * the customer shaped.
 */

/**
 * A metric's value over a rule's own window, and how it moved.
 *
 * INJECTED RATHER THAN IMPORTED, so this package does not depend on analytics —
 * and, more importantly, so there is exactly ONE implementation of "what is this
 * metric over this window", shared with the producer that decided the threshold
 * was crossed. Two answers to that question would mean a rule whose condition
 * disagrees with the trigger that fired it.
 */
export interface MetricWindowPort {
  windowFor(input: {
    readonly brandId: string;
    readonly metricKey: string;
    readonly windowDays: number;
  }): Promise<{ readonly value: bigint | null; readonly changeMilli: number | null }>;
}

export interface FactEvent {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly triggerType: AutomationTrigger;
  readonly refType: string | null;
  readonly refId: string | null;
  /** Set for the rule-derived triggers; the rule carries the metric and window. */
  readonly ruleId: string | null;
}

export async function gatherFacts(
  db: TenantScopedClient,
  event: FactEvent,
  ports: { readonly metrics?: MetricWindowPort | undefined } = {},
): Promise<Record<string, unknown>> {
  const facts: Record<string, unknown> = { 'brand.id': event.brandId };

  if (event.refType === 'ContentItem' && event.refId) {
    await addContentFacts(db, event.workspaceId, event.refId, facts);
  }

  /*
   * A SLOT REACHES ITS CONTENT ITEM. The registry already says
   * `contentItemVia: 'calendarSlot'` for `CONTENT_SCHEDULED`; without this the
   * three content fields were offered on a scheduling rule and resolved to
   * nothing.
   */
  if (event.refType === 'CalendarSlot' && event.refId) {
    const slot = await db.calendarSlot.findFirst({
      where: { id: event.refId, workspaceId: event.workspaceId },
      select: { contentItemId: true },
    });
    if (slot) await addContentFacts(db, event.workspaceId, slot.contentItemId, facts);
  }

  if (event.refType === 'PublishJob' && event.refId) {
    const job = await db.publishJob.findFirst({
      where: { id: event.refId, workspaceId: event.workspaceId },
      select: { provider: true, failureClass: true, contentItemId: true },
    });
    if (job) {
      facts['publish.provider'] = job.provider;
      facts['publish.failureClass'] = job.failureClass;
      await addContentFacts(db, event.workspaceId, job.contentItemId, facts);
    }
  }

  /*
   * THE METRIC FACTS COME FROM THE RULE'S OWN WINDOW, THROUGH THE SAME PORT THE
   * PRODUCER USED.
   *
   * NOT FROM THE REFERENCED OBSERVATION'S RAW VALUE, which is what an earlier
   * version read. A threshold is evaluated over a WINDOW — a level metric's
   * latest reading per subject, summed across subjects, or an additive metric's
   * total (P7-R7) — and a single observation is one subject's one bucket. A
   * condition comparing `metric.value` against the number the customer typed
   * would have been comparing against a different quantity from the one that
   * fired the rule.
   */
  if (event.triggerType === 'METRIC_THRESHOLD_CROSSED' && event.ruleId && ports.metrics) {
    const rule = await db.automationRule.findFirst({
      where: { id: event.ruleId, workspaceId: event.workspaceId },
      select: { triggerConfig: true },
    });
    const config = metricThresholdConfigSchema.safeParse(rule?.triggerConfig ?? {});
    if (config.success) {
      const window = await ports.metrics.windowFor({
        brandId: event.brandId,
        metricKey: config.data.metricKey,
        windowDays: config.data.windowDays,
      });
      facts['metric.key'] = config.data.metricKey;
      // A `bigint` never reaches a condition: every declared operator compares
      // numbers, and a mixed comparison is FALSE rather than surprising.
      if (window.value !== null) facts['metric.value'] = Number(window.value);
      if (window.changeMilli !== null) facts['metric.changeMilli'] = window.changeMilli;
    }
  }

  return facts;
}

async function addContentFacts(
  db: TenantScopedClient,
  workspaceId: string,
  contentItemId: string,
  facts: Record<string, unknown>,
): Promise<void> {
  const item = await db.contentItem.findFirst({
    where: { id: contentItemId, workspaceId },
    select: {
      status: true,
      pillar: true,
      campaignId: true,
      _count: { select: { variants: true } },
    },
  });
  if (!item) return;
  facts['content.status'] = item.status;
  facts['content.pillar'] = item.pillar;
  facts['content.platformCount'] = item._count.variants;
  facts['content.hasCampaign'] = item.campaignId !== null;
}

/**
 * The fields this gatherer is CONTRACTED to produce for one trigger.
 *
 * Exported so the parity test asserts against the declared table rather than
 * against a second copy of the list written in the test — a test that carries
 * its own expectations is a test that drifts with the code it checks.
 */
export function contractedFieldsFor(trigger: AutomationTrigger): readonly ConditionField[] {
  return (Object.keys(CONDITION_FIELD_TRIGGERS) as ConditionField[]).filter((field) =>
    CONDITION_FIELD_TRIGGERS[field].includes(trigger),
  );
}
