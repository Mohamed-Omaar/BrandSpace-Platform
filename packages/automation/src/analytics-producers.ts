import { recordRuleAutomationEvent } from '@brandspace/database';
import {
  brandWeeklyEngagement,
  readOnce,
  weeklyDropVerdict,
  weeklyEngagementWindows,
} from './analytics-events';
import { edgeTransitionSinceArming } from './due-events';
import { advanceDueWatermark, type DueProducerContext, type DueVisit } from './due-producers';
import { TIMED_PRODUCER_LIMITS } from './registry';
import { moveState } from './threshold-producer';

/**
 * PHASE 2B-3 PR 4 — ONE VISIT OF ONE ANALYTICS RULE.
 *
 * The same contract as the PR 3 producers (`due-producers.ts`): called by the
 * API's `MaintenanceScheduler` for one rule, inside that tenant's transaction;
 * the events, the rule's cursor and its edge memory commit together (D-186);
 * nothing is kept in memory between sweeps and nothing assumes one scheduler —
 * `automation_event_workspaceId_dedupeKey_key`, the forward-only cursor and the
 * compare-and-set on the edge memory keep two replicas to one outcome.
 *
 * The numbers come from `analytics-events.ts`, read once per brand per sweep.
 */

const NOTHING: DueVisit = { produced: 0, more: false, next: null, skippedLate: 0 };
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// WEEKLY_ENGAGEMENT_DROPPED
// ---------------------------------------------------------------------------

/**
 * The brand's last settled week at least 20% below the week before
 * (report §30), judged once per settled UTC day and EDGE-TRIGGERED on the
 * D-177 memory, exactly as SCHEDULE_GAP (D-430):
 *
 *   - normal → dropped fires `WEEKLY_ENGAGEMENT_DROPPED:<ruleId>:<cycle>` once;
 *   - dropped → still dropped is steady; dropped → normal re-arms (cycle + 1);
 *   - a prior week below the configured baseline is not judged at all, and the
 *     memory is left as it was;
 *   - memory from before the current arming counts as none, so the first
 *     judgement after arming only ESTABLISHES the state, and establishing
 *     advances the cycle, so a key spent before a switch-off is never reused.
 *
 * THE CURSOR IS THE SETTLED DAY ALREADY JUDGED: a new day settles once a day,
 * so the rule is judged at most once per settled day and parks until the next
 * UTC midnight. After an outage only the week as it stands now is judged —
 * nothing is replayed.
 */
export async function produceWeeklyEngagementDropped(
  context: DueProducerContext,
): Promise<DueVisit> {
  const { db, workspaceId, rule, now, analytics } = context;
  const lag = TIMED_PRODUCER_LIMITS.watermarkLagSeconds * 1_000;
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  const next = new Date(tomorrow + lag);
  if (!rule.armedAt || !analytics) return NOTHING;
  const minBaseline = analytics.events.weeklyEngagementDrop.minBaseline;
  if (minBaseline === undefined) return { ...NOTHING, next };

  const windows = weeklyEngagementWindows(now, analytics.refreshWindowDays);
  const judgedToday =
    rule.dueWatermark !== null &&
    rule.dueWatermark.getTime() >= windows.settledEnd.getTime() &&
    rule.thresholdEvaluatedAt !== null &&
    rule.thresholdEvaluatedAt.getTime() >= rule.armedAt.getTime();
  if (judgedToday) return { ...NOTHING, next };

  const totals = await readOnce(
    analytics.shared,
    `weekly:${workspaceId}:${rule.brandId}:${windows.settledEnd.toISOString()}`,
    () => brandWeeklyEngagement(db, { workspaceId, brandId: rule.brandId, windows }),
  );
  const dropped = weeklyDropVerdict({ ...totals, minBaseline });
  const transition = edgeTransitionSinceArming({
    armedAt: rule.armedAt,
    evaluatedAt: rule.thresholdEvaluatedAt,
    previous: rule.thresholdBreached,
    current: dropped,
  });

  let produced = 0;
  switch (transition.kind) {
    case 'unmeasured':
    case 'steady':
      break;
    case 'establish':
      await moveState(db, workspaceId, rule, {
        breached: transition.breached,
        cycle: rule.thresholdCycle + 1,
        now,
      });
      break;
    case 'rearm':
      await moveState(db, workspaceId, rule, {
        breached: false,
        cycle: rule.thresholdCycle + 1,
        now,
      });
      break;
    case 'fire': {
      // The claim, then the event, nothing between them that can decline.
      const claimed = await moveState(db, workspaceId, rule, {
        breached: true,
        cycle: rule.thresholdCycle,
        now,
      });
      if (!claimed) return { ...NOTHING, next };
      const wrote = await recordRuleAutomationEvent(db, workspaceId, {
        triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
        brandId: rule.brandId,
        ruleId: rule.id,
        cycle: rule.thresholdCycle,
      });
      if (wrote) produced = 1;
      break;
    }
  }
  await advanceDueWatermark(db, workspaceId, rule.id, windows.settledEnd);
  return { ...NOTHING, produced, next };
}
