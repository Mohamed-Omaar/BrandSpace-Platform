import type { MetricUnit } from '@brandspace/database';
import type { AnalyticsPolicy } from './policy';
import type { TimeSeriesPoint } from './queries';

/**
 * ANOMALY DETECTION, AND THE RULE THAT MAKES IT HONEST.
 *
 * THERE IS NO "AI DETECTED A PROBLEM" IN THIS PRODUCT. Every anomaly this
 * function returns carries the BASELINE it was compared against, the WINDOW that
 * baseline was computed over, the OBSERVED value and the DEVIATION that crossed
 * the threshold — so a customer can look at the four numbers and disagree. An
 * anomaly a customer cannot audit is a claim, not a finding, and a product that
 * makes unauditable claims about a customer's own performance teaches them to
 * ignore it.
 *
 * IT IS ARITHMETIC, NOT A MODEL. No gateway call, no credits, no provider. That
 * matters twice over: it is free, and it is REPRODUCIBLE — the same series and
 * the same thresholds produce the same anomalies on every run, which is what
 * lets an automation trigger on one without firing differently each time.
 *
 * THE THREE GUARDS, each closing a way this feature becomes noise:
 *
 *  - A MINIMUM NUMBER OF BASELINE PERIODS. Two data points do not have a
 *    baseline; calling the third one anomalous is calling a coin flip a trend.
 *  - A MINIMUM BASELINE VALUE. A post that went from 2 impressions to 6 is not a
 *    200% surge. Below the configured floor, nothing is reported at all.
 *  - GAPS ARE NOT ZEROES. A bucket with no observation is excluded from the
 *    baseline entirely. Treating a day nobody posted as "zero engagement" would
 *    drag every baseline down and then flag the next ordinary day as a spike.
 */

export type AnomalyDirection = 'above' | 'below';

export interface Anomaly {
  readonly metricKey: string;
  readonly unit: MetricUnit;
  readonly direction: AnomalyDirection;
  /** The period whose value crossed the threshold. */
  readonly periodStart: Date;
  readonly observedValue: bigint;
  /** The mean of the preceding periods that had an observation. */
  readonly baselineValue: bigint;
  /** How many periods the baseline was computed from. */
  readonly baselinePeriods: number;
  /** The first and last period contributing to the baseline. */
  readonly baselineStart: Date;
  readonly baselineEnd: Date;
  /** Deviation from the baseline in parts per mille. Signed. */
  readonly deviationMilli: number;
  /** The threshold it crossed, so the finding states its own rule. */
  readonly thresholdMilli: number;
}

/**
 * Find anomalies in one metric's series.
 *
 * WALKS FORWARD, using only the periods BEFORE each candidate. A baseline that
 * included the candidate — or the periods after it — would be hindsight, and an
 * anomaly detected with hindsight cannot be the trigger for anything, because it
 * changes its mind as more data arrives.
 */
export function detectAnomalies(input: {
  metricKey: string;
  unit: MetricUnit;
  points: readonly TimeSeriesPoint[];
  policy: AnalyticsPolicy;
}): readonly Anomaly[] {
  const { baselinePeriods, deviationThresholdMilli, minimumBaselineValue } = input.policy.anomaly;
  const anomalies: Anomaly[] = [];

  // Only buckets that actually HAVE an observation. A gap is not a zero.
  const observed = input.points.flatMap((p) =>
    p.value === null ? [] : [{ periodStart: p.periodStart, value: p.value }],
  );

  for (let i = baselinePeriods; i < observed.length; i += 1) {
    const candidate = observed[i];
    /* c8 ignore next -- the loop bound guarantees this. */
    if (!candidate) continue;

    const window = observed.slice(i - baselinePeriods, i);
    if (window.length < baselinePeriods) continue;

    const first = window[0];
    const last = window[window.length - 1];
    /* c8 ignore next -- window.length was just checked. */
    if (!first || !last) continue;

    const sum = window.reduce((total, point) => total + point.value, 0n);
    const baseline = sum / BigInt(window.length);

    // THE FLOOR. Below it, the arithmetic still works and the finding would be
    // meaningless, so nothing is reported.
    const magnitude = baseline < 0n ? -baseline : baseline;
    if (magnitude < BigInt(minimumBaselineValue)) continue;

    const deviationMilli = Number(((candidate.value - baseline) * 1000n) / magnitude);
    if (Math.abs(deviationMilli) < deviationThresholdMilli) continue;

    anomalies.push({
      metricKey: input.metricKey,
      unit: input.unit,
      direction: deviationMilli > 0 ? 'above' : 'below',
      periodStart: candidate.periodStart,
      observedValue: candidate.value,
      baselineValue: baseline,
      baselinePeriods: window.length,
      baselineStart: first.periodStart,
      baselineEnd: last.periodStart,
      deviationMilli,
      thresholdMilli: deviationThresholdMilli,
    });
  }

  return anomalies;
}
