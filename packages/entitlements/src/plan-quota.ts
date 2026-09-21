import type { Environment } from '@brandspace/config';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { EntitlementService, TenantCatalogueSource } from './service';
import { UsageService, type QuotaPeriod } from './usage';

/**
 * A plan quota, as the thing that consumes it sees it.
 *
 * WHY AN INTERFACE AND NOT THE SERVICE. The packages that consume quotas —
 * content, social connectors, assets — must not each construct an entitlement
 * engine, a catalogue source and an environment to ask one question. They take
 * this, which is satisfied structurally, so neither side imports the other and
 * the quota can be handed in by the app that already knows the environment.
 *
 * D-10 PRECEDENCE IS NEVER RE-IMPLEMENTED BEHIND IT. `limit()` is
 * `EntitlementService.limit`, which resolves plan → override → flag → default;
 * `null` is unlimited and `0` is none, and a caller that collapses the two locks
 * out exactly the customers who negotiated no limit.
 */
export interface PlanQuotaAdapter {
  /** The ceiling in force. `null` is unlimited. */
  limit(): Promise<number | null>;
  /** Take `amount` (default 1). False means the ceiling refused it. */
  consume(idempotencyKey: string, amount?: number): Promise<boolean>;
  /** Give it back when the thing it counted stops existing. */
  refund(idempotencyKey: string, amount?: number): Promise<void>;
}

/**
 * Build a quota adapter for one feature over one window.
 *
 * ONE IMPLEMENTATION, EVERY DIMENSION. `createScheduleQuota` was this, written
 * for `limit.scheduled_posts` alone, and the next dimension that needed
 * enforcing would have been a second copy of the same twelve lines — including
 * the part that is easy to get wrong, which is that a `QUOTA_EXCEEDED` is the
 * ONLY failure a boolean may swallow. A connection fault reported as "the plan
 * is full" sends a customer to a billing page over a database hiccup.
 */
export function createPlanQuota(input: {
  db: TenantScopedClient;
  workspaceId: string;
  environment: Environment;
  featureKey: string;
  period: QuotaPeriod;
}): PlanQuotaAdapter {
  const client = input.db as unknown as PrismaClient;
  const usage = new UsageService({ prisma: client });
  const entitlements = new EntitlementService({
    prisma: client,
    catalogueSource: new TenantCatalogueSource(client, input.environment),
    environment: input.environment,
  });
  const { workspaceId, featureKey, period } = input;

  return {
    async limit(): Promise<number | null> {
      return entitlements.limit(workspaceId, featureKey);
    },
    async consume(idempotencyKey: string, amount = 1): Promise<boolean> {
      try {
        await usage.consume({
          workspaceId,
          featureKey,
          limitValue: await entitlements.limit(workspaceId, featureKey),
          period,
          amount,
          idempotencyKey,
        });
        return true;
      } catch (error: unknown) {
        if (error instanceof AppError && error.code === 'QUOTA_EXCEEDED') return false;
        throw error;
      }
    },
    async refund(idempotencyKey: string, amount = 1): Promise<void> {
      await usage.refund({ workspaceId, featureKey, period, amount, idempotencyKey });
    },
  };
}
