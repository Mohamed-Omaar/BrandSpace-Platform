import type { Environment } from '@brandspace/config';
import type { TenantScopedClient } from '@brandspace/database';
import { systemClock, type Clock } from '@brandspace/shared';
import { AnalyticsQueryService } from './queries';
import { TenantAnalyticsPolicySource } from './policy';
import { createAnalyticsRegistry } from './registry';

/**
 * WHAT IS THIS METRIC OVER THIS WINDOW — ONE ANSWER, ONE IMPLEMENTATION.
 *
 * TWO CALLERS NEED IT AND THEY MUST NOT DISAGREE. The scheduler asks in order to
 * decide whether a threshold was crossed; the worker asks in order to put
 * `metric.value` and `metric.changeMilli` in front of a rule's CONDITION. If
 * those were two pieces of code, a rule could fire on one number and then
 * evaluate its condition against another — and the customer would see a rule
 * that triggered and then did nothing, with both halves looking right on their
 * own.
 *
 * IT IS ALSO THE PLACE THAT KNOWS P7-R7: a level metric's window value is each
 * subject's most recent reading summed across subjects, an additive one's is a
 * total. Nobody outside this package should be computing either.
 *
 * STRUCTURALLY TYPED ON PURPOSE. `@brandspace/automation` declares the port it
 * needs and this satisfies it without either package importing the other.
 */
export function createMetricWindowPort(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly environment: Environment;
  readonly clock?: Clock;
}): {
  windowFor(request: {
    readonly brandId: string;
    readonly metricKey: string;
    readonly windowDays: number;
  }): Promise<{ readonly value: bigint | null; readonly changeMilli: number | null }>;
} {
  const clock = input.clock ?? systemClock;
  return {
    async windowFor(request) {
      const now = clock.now();
      const windowMs = request.windowDays * 86_400_000;
      const period = { start: new Date(now.getTime() - windowMs), end: now };
      /*
       * THE COMPARISON IS THE ADJACENT WINDOW, which is what `changeMilli` means
       * everywhere else in the product — the same figure the analytics screen
       * shows beside the number.
       */
      const comparison = { start: new Date(period.start.getTime() - windowMs), end: period.start };

      const policy = await new TenantAnalyticsPolicySource(input.db, input.environment).load();
      const queries = new AnalyticsQueryService({
        db: input.db,
        workspaceId: input.workspaceId,
        policy,
        registry: createAnalyticsRegistry({ environment: input.environment }),
      });
      const summary = await queries.summary({
        scope: { brandId: request.brandId },
        period,
        comparison,
        /*
         * THE RULE'S OWN BRAND PINS THE QUERY, and there is no member here whose
         * scope could narrow it: this runs for the platform's own clock, inside
         * `withWorkspace` so RLS still applies, and NOTHING IS ACTED ON — the
         * engine re-resolves the rule creator's live permissions and BrandScope
         * before any action runs, and an external one still stops for a human.
         */
        brandScope: [],
        metricKeys: [request.metricKey],
      });
      const metric = summary.metrics.find((row) => row.metricKey === request.metricKey);
      return { value: metric?.value ?? null, changeMilli: metric?.changeMilli ?? null };
    },
  };
}
