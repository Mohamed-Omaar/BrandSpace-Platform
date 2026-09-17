import type { Environment } from '@brandspace/config';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { EntitlementService, TenantCatalogueSource } from './service';
import { QUOTA_FEATURES, UsageService } from './usage';

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
  const client = input.db as unknown as PrismaClient;
  const usage = new UsageService({ prisma: client });
  const entitlements = new EntitlementService({
    prisma: client,
    catalogueSource: new TenantCatalogueSource(client, input.environment),
    environment: input.environment,
  });
  const FEATURE = QUOTA_FEATURES.scheduledPostsPerMonth;
  const workspaceId = input.workspaceId;

  return {
    async limit(): Promise<number | null> {
      return entitlements.limit(workspaceId, FEATURE);
    },
    async consume(idempotencyKey: string): Promise<boolean> {
      try {
        await usage.consume({
          workspaceId,
          featureKey: FEATURE,
          limitValue: await entitlements.limit(workspaceId, FEATURE),
          period: 'month',
          idempotencyKey,
        });
        return true;
      } catch (error: unknown) {
        /*
         * A REFUSAL IS A `QUOTA_EXCEEDED`, AND IT IS THE ONLY FAILURE THIS
         * BOOLEAN MAY SWALLOW. Anything else — a connection fault, a conflicting
         * key — is a real error and must not be reported to the caller as "the
         * plan is full", which would send them to a billing page over a database
         * hiccup.
         */
        if (error instanceof AppError && error.code === 'QUOTA_EXCEEDED') return false;
        throw error;
      }
    },
    async refund(idempotencyKey: string): Promise<void> {
      await usage.refund({ workspaceId, featureKey: FEATURE, period: 'month', idempotencyKey });
    },
  };
}
