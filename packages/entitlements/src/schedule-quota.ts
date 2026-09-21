import type { Environment } from '@brandspace/config';
import type { TenantScopedClient } from '@brandspace/database';
import { createPlanQuota, type PlanQuotaAdapter } from './plan-quota';
import { QUOTA_FEATURES } from './usage';

/**
 * THE PLAN'S MONTHLY SCHEDULING CEILING — one implementation, every caller.
 *
 * WHY IT MOVED HERE (P7-R6). It was written inside `apps/api/src/routes`, so the
 * two callers in that app shared it and the THIRD one — the automation worker,
 * which places content on the calendar when nobody is watching — could not
 * import it without reaching into another app. What it did instead was supply
 * its own adapter whose `limit()` returned `null`, whose `consume()` returned
 * `true` and whose `refund()` did nothing, under a comment claiming the quota
 * was real. So `PLACE_ON_CALENDAR` scheduled past `limit.scheduled_posts`
 * without counting, and a rule was a way to buy headroom for free.
 *
 * A SHARED RULE BELONGS AT THE BOUNDARY THAT OWNS IT. Plans, limits, precedence
 * and the usage ledger are this package; the calendar consumes the result
 * through its own narrow `ScheduleQuota` interface, which this satisfies
 * structurally without either package importing the other.
 *
 * IT IS NOW `createPlanQuota` WITH THIS DIMENSION'S TWO ARGUMENTS. The body was
 * generic apart from the feature key and the window, and the current execution
 * Phase 3 needed the same twelve lines for `limit.brands` and
 * `limit.social_accounts`. Copying them would have been three places for the
 * "only a QUOTA_EXCEEDED may become a boolean" rule to be got wrong.
 *
 * D-10 PRECEDENCE IS NOT RE-IMPLEMENTED. `EntitlementService.limit` resolves
 * plan → override → flag → default, and the FEATURE KEY is the shared constant
 * rather than a literal, so there is one spelling of it in the platform.
 */
export interface ScheduleQuotaAdapter {
  /** The plan's monthly ceiling. `null` is unlimited. */
  limit(): Promise<number | null>;
  /** Take one. Returns false when the ceiling is reached. */
  consume(idempotencyKey: string): Promise<boolean>;
  /** Give one back when a slot is cancelled. */
  refund(idempotencyKey: string): Promise<void>;
}

export function createScheduleQuota(input: {
  db: TenantScopedClient;
  workspaceId: string;
  environment: Environment;
}): ScheduleQuotaAdapter {
  const quota: PlanQuotaAdapter = createPlanQuota({
    db: input.db,
    workspaceId: input.workspaceId,
    environment: input.environment,
    featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
    period: 'month',
  });
  return {
    limit: () => quota.limit(),
    consume: (idempotencyKey: string) => quota.consume(idempotencyKey),
    refund: (idempotencyKey: string) => quota.refund(idempotencyKey),
  };
}
