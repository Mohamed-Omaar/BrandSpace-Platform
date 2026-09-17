import { recordRuleAutomationEvent, type TenantScopedClient } from '@brandspace/database';
import type { MetricWindowPort } from './facts';
import {
  metricIsBreaching,
  metricThresholdConfigSchema,
  thresholdOccurrenceKey,
  thresholdTransition,
} from './schedule';

/**
 * ONE THRESHOLD RULE, EVALUATED ONCE.
 *
 * WHY IT IS HERE AND NOT IN THE SCHEDULER. The sweep's job is the CROSS-TENANT
 * question — which rules exist — and F-07 keeps that in `apps/api`. What a
 * crossing MEANS is not a scheduling concern at all, and while it lived inside
 * the sweep the only way to test it was to re-implement it in the test, which
 * tests the copy rather than the code.
 *
 * THE WHOLE EDGE RULE IS THE SIX LINES BELOW, and every one of them is a
 * decision some previous version got wrong:
 *
 *   - AN UNMEASURED WINDOW CHANGES NOTHING. Missing is never zero; a brand with
 *     no readings has not fallen below anything.
 *   - THE FIRST EVALUATION ESTABLISHES THE SIDE AND FIRES NOTHING. A rule made
 *     while the metric is already past the line has not seen anything cross
 *     since somebody asked.
 *   - STAYING PAST THE LINE IS NOT CROSSING IT. This is the defect: comparing
 *     two adjacent windows keeps saying "crossed" for as long as the metric
 *     stays, and keying the event on the newest observation hid the repeat only
 *     until the next reading arrived.
 *   - GOING BACK RE-ARMS, by advancing the cycle — which is what makes the next
 *     crossing a different event rather than a duplicate of the last one.
 *   - THE CLAIM IS A COMPARE-AND-SWAP, so two schedulers racing one crossing
 *     produce one winner.
 *   - AND NOTHING THAT CAN FAIL HAPPENS BETWEEN THE CLAIM AND THE EVENT. A
 *     claimed fire that committed without its event would consume the crossing
 *     for ever; see the fire path below.
 */
export type ThresholdOutcome =
  | 'unmeasured'
  | 'established'
  | 'steady'
  | 'rearmed'
  | 'fired'
  | 'lost_race'
  | 'no_observation'
  | 'unconfigured';

export interface ThresholdRuleRow {
  readonly id: string;
  readonly brandId: string;
  readonly triggerConfig: unknown;
  readonly thresholdBreached: boolean | null;
  readonly thresholdCycle: number;
}

export async function evaluateThresholdRule(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly rule: ThresholdRuleRow;
  readonly metrics: MetricWindowPort;
  readonly now: Date;
}): Promise<ThresholdOutcome> {
  const config = metricThresholdConfigSchema.safeParse(input.rule.triggerConfig ?? {});
  if (!config.success) return 'unconfigured';
  const { metricKey, direction, threshold, windowDays } = config.data;

  const window = await input.metrics.windowFor({
    brandId: input.rule.brandId,
    metricKey,
    windowDays,
  });
  const current = metricIsBreaching({ direction, threshold, value: window.value });
  const transition = thresholdTransition({
    previous: input.rule.thresholdBreached,
    current,
  });

  if (transition.kind === 'unmeasured') return 'unmeasured';
  if (transition.kind === 'steady') return 'steady';

  if (transition.kind === 'establish') {
    await moveState(input.db, input.workspaceId, input.rule, {
      breached: transition.breached,
      cycle: input.rule.thresholdCycle,
      now: input.now,
    });
    return 'established';
  }

  if (transition.kind === 'rearm') {
    await moveState(input.db, input.workspaceId, input.rule, {
      breached: false,
      // THE CYCLE ADVANCES HERE, and only here.
      cycle: input.rule.thresholdCycle + 1,
      now: input.now,
    });
    return 'rearmed';
  }

  /*
   * PROVENANCE IS RESOLVED BEFORE THE CLAIM, AND THAT ORDER IS THE WHOLE POINT.
   *
   * THE DEFECT IT FIXES. This lookup used to run AFTER the compare-and-swap, and
   * a miss returned `'no_observation'` — a NORMAL return, so the surrounding
   * `withWorkspace` transaction COMMITTED `thresholdBreached = true` with no
   * `AutomationEvent` to go with it. On the next sweep the rule was already
   * marked breached, so the transition was `steady`, and a real crossing had
   * been permanently consumed. Nothing failed and nothing was logged.
   *
   * THE RACE IS REACHABLE. Analytics retention prunes `MetricObservation` rows,
   * and `withWorkspace` is one transaction at READ COMMITTED rather than a
   * repeatable-read snapshot, so a pruning commit landing between the metric
   * window read and this lookup is visible to it. The window can therefore
   * answer "past the line" from rows that are gone by the time provenance is
   * asked for.
   *
   * SO THE ORDER IS INVERTED RATHER THAN THE FAILURE HANDLED. Every step that
   * can decline now happens BEFORE anything is committed: a miss here returns
   * with the remembered side untouched, so the rule is still armed, the cycle
   * has not moved, and the next sweep evaluates the same crossing again. After
   * the claim there is no branch, no return and no second query — only the
   * write that the claim exists to authorise. A committed fire therefore cannot
   * exist without its event: either both are in the transaction or neither is.
   *
   * THE CAS IS UNCHANGED AND STILL THE ARBITER. Two schedulers may both read
   * provenance; only one can move the state, and the loser returns having
   * written nothing.
   *
   * THE REFERENCE IS THE READING THE CROSSING WAS SEEN IN — provenance, so a
   * person can look at what the engine looked at. The IDENTITY is the rule and
   * its arming cycle, which is what the outbox de-duplicates on.
   */
  const observation = await input.db.metricObservation.findFirst({
    where: { workspaceId: input.workspaceId, brandId: input.rule.brandId, metricKey },
    orderBy: { periodStart: 'desc' },
    select: { id: true },
  });
  if (!observation) return 'no_observation';

  const claimed = await moveState(input.db, input.workspaceId, input.rule, {
    breached: true,
    cycle: input.rule.thresholdCycle,
    now: input.now,
  });
  if (!claimed) return 'lost_race';

  // NOTHING BETWEEN THE CLAIM AND THE EVENT. `recordRuleAutomationEvent` either
  // writes the row, finds its `dedupeKey` already present — the event exists
  // either way — or throws, and a throw rolls the claim back with it.
  await recordRuleAutomationEvent(input.db, input.workspaceId, {
    triggerType: 'METRIC_THRESHOLD_CROSSED',
    brandId: input.rule.brandId,
    ruleId: input.rule.id,
    refId: observation.id,
    occurrenceKey: thresholdOccurrenceKey(input.rule.id, input.rule.thresholdCycle),
  });
  return 'fired';
}

/** Move the remembered side, but only if nobody moved it first. */
async function moveState(
  db: TenantScopedClient,
  workspaceId: string,
  rule: ThresholdRuleRow,
  next: { breached: boolean; cycle: number; now: Date },
): Promise<boolean> {
  const moved = await db.automationRule.updateMany({
    where: {
      id: rule.id,
      workspaceId,
      thresholdBreached: rule.thresholdBreached,
      thresholdCycle: rule.thresholdCycle,
    },
    data: {
      thresholdBreached: next.breached,
      thresholdCycle: next.cycle,
      thresholdEvaluatedAt: next.now,
    },
  });
  return moved.count > 0;
}
