import type { Anomaly, MetricAbsenceReason } from '@brandspace/analytics';
import type { AttentionItem } from './command-center';

/**
 * WHAT HAPPENED, AND WHAT TO DO NEXT — the analytics half of P6-11.
 *
 * Analytics answered "what are the numbers" honestly: a real figure, or one of
 * six named reasons it has none. It did not answer the two questions a reader
 * actually brings to the screen — **did anything change**, and **what should I
 * do about it** — so a member read an accurate chart and still had to decide
 * alone whether it mattered.
 *
 * BOTH ANSWERS ARE DERIVED, NEVER GENERATED. A shift is `detectAnomalies` —
 * arithmetic against a baseline the reader can see, thresholds that come from
 * the tenant's analytics configuration — and a next step is a fixed mapping
 * from a condition the page has already measured to the screen where it is
 * fixed. No model is called, no credit is spent, and nothing here can state a
 * figure the stored observations do not hold.
 *
 * PURE, AND NOT `server-only`, for the reason `command-center.ts` gives: rule
 * modules the unit suite imports directly. It reads nothing and holds nothing.
 */

/**
 * The most recent anomaly inside the last `withinDays`, or null.
 *
 * WHY "MOST RECENT" AND NOT "LARGEST". A shift three weeks ago that has since
 * settled is history; the one that is still the latest is the one a reader can
 * still act on. And WHY A WINDOW AT ALL: `detectAnomalies` walks the whole
 * series, so without one a 90-day range would keep resurfacing a change from
 * two months ago as though it were news.
 */
export function latestShift(
  anomalies: readonly Anomaly[],
  input: { readonly now: Date; readonly withinDays: number },
): Anomaly | null {
  const since = input.now.getTime() - input.withinDays * 86_400_000;
  let latest: Anomaly | null = null;
  for (const anomaly of anomalies) {
    const at = anomaly.periodStart.getTime();
    if (at < since || at > input.now.getTime()) continue;
    if (!latest || at > latest.periodStart.getTime()) latest = anomaly;
  }
  return latest;
}

/**
 * How recent a shift must be for Home to raise it. A presentation horizon —
 * "this past week" — in the same class as the calendar-gap horizon; it sets no
 * limit and changes no behaviour.
 */
export const PERFORMANCE_SHIFT_RECENT_DAYS = 7;

/**
 * A recent shift, as a Pulse item for Home.
 *
 * `notice`, not `blocked` or `waiting`: a number moving is worth knowing, and
 * nothing is stuck because of it. The metric key rides in `detail` and is
 * translated by the page — the item never carries the figure itself, for the
 * same reason a notification does not (templates.ts): the number belongs on the
 * analytics screen, under its freshness and scope checks.
 */
export function performanceShiftItem(anomaly: Anomaly | null): AttentionItem | null {
  if (!anomaly) return null;
  return {
    kind: anomaly.direction === 'above' ? 'performance-above' : 'performance-below',
    severity: 'notice',
    count: 1,
    href: '/analytics',
    detail: anomaly.metricKey,
    date: anomaly.periodStart,
  };
}

/** One suggested next step on the analytics screen. */
export interface NextStep {
  /** Stable identity; also the message-key suffix (`analytics.next.<key>`). */
  readonly key:
    'connect' | 'reconnect' | 'schedule' | 'wait-for-sync' | 'explain-shift' | 'review-findings';
  /** Where to act, WITHOUT the locale prefix. Null when the step is an action
   *  on this screen (explain) or needs no action (wait). */
  readonly href: string | null;
}

/**
 * Next steps, from conditions the page has already measured.
 *
 * EVERY STEP IS GATED ON THE PERMISSION ITS DESTINATION REQUIRES, so the
 * screen never suggests a link that answers 404 (§20, and the Command Center's
 * rule). A condition the reader cannot act on is not turned into a step they
 * cannot take.
 *
 * ORDERED BY WHAT UNBLOCKS WHAT: an account that is not connected makes every
 * other step moot, so it comes first; explaining a shift only makes sense once
 * there are numbers to explain.
 *
 * `not_published_by_platform` and `components_missing` produce NO step. The
 * first is a fact about a provider nobody here can change; the second resolves
 * itself when the missing components arrive. A suggestion with no action behind
 * it would be the decorative advice this screen exists to avoid.
 */
export function analyticsNextSteps(input: {
  readonly absences: readonly (MetricAbsenceReason | null)[];
  readonly shift: Anomaly | null;
  readonly unreviewedFindings: number;
  readonly permissionKeys: readonly string[];
}): readonly NextStep[] {
  const may = (key: string): boolean => input.permissionKeys.includes(key);
  const absent = new Set(input.absences.filter((r): r is MetricAbsenceReason => r !== null));
  const steps: NextStep[] = [];

  if (absent.has('no_connection') && may('integrations.read')) {
    steps.push({ key: 'connect', href: '/integrations' });
  }
  if (absent.has('connection_needs_reauthorization') && may('integrations.read')) {
    steps.push({ key: 'reconnect', href: '/integrations' });
  }
  if (absent.has('no_published_content') && may('content.read')) {
    steps.push({ key: 'schedule', href: '/calendar' });
  }
  if (absent.has('metrics_pending')) {
    steps.push({ key: 'wait-for-sync', href: null });
  }
  if (input.shift && may('analytics.explain')) {
    steps.push({ key: 'explain-shift', href: null });
  }
  if (input.unreviewedFindings > 0 && may('strategy.read')) {
    steps.push({ key: 'review-findings', href: '/intelligence' });
  }
  return steps;
}
