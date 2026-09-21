import type { Environment } from '@brandspace/config';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { EntitlementService, TenantCatalogueSource } from './service';
import { QUOTA_FEATURES, UsageService, type QuotaPeriod } from './usage';

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
 * What each TOTAL resource dimension is counting — ONE definition, every caller.
 *
 * WHY THIS LIVES BESIDE THE DIMENSIONS RATHER THAN AT THE CALL SITES. A total
 * quota's meaning is two things that must agree: the feature key, and which
 * rows occupy a slot. Splitting them put the predicate at the call site and the
 * key here, and the first thing that happened was a test building its own
 * adapter without a population at all — which passed, and measured nothing.
 *
 * It costs this package two model names it would otherwise not mention, and
 * that is the trade: the alternative is the same `where` clause written in the
 * route, in the server action and in every suite, drifting apart one copy at a
 * time. "Occupies a slot" has to mean one thing.
 *
 * A REVOKED connection and a soft-deleted brand are not there. Both are the
 * same predicates the product already uses to decide what is live, which is
 * what makes the plan ceiling and the platform ceiling agree about a workspace.
 */
export const TOTAL_RESOURCE_DIMENSIONS = {
  brands: {
    featureKey: QUOTA_FEATURES.brands,
    live: (db: TenantScopedClient, workspaceId: string): Promise<number> =>
      db.brand.count({ where: { workspaceId, deletedAt: null } }),
  },
  socialAccounts: {
    featureKey: QUOTA_FEATURES.socialAccounts,
    live: (db: TenantScopedClient, workspaceId: string): Promise<number> =>
      db.socialConnection.count({
        where: { workspaceId, status: { in: ['PENDING', 'ACTIVE', 'NEEDS_REAUTH'] } },
      }),
  },
} as const;

export type TotalResourceDimension = keyof typeof TOTAL_RESOURCE_DIMENSIONS;

/**
 * A plan quota over things that EXIST, counted against what actually exists.
 *
 * The only way to build one, so no caller can quietly omit the population and
 * get a quota that only knows what it was told. `limit.seats` is deliberately
 * absent: nothing consumes it yet, and what a seat is remains a product
 * decision (D-233).
 */
export function createTotalResourceQuota(input: {
  db: TenantScopedClient;
  workspaceId: string;
  environment: Environment;
  dimension: TotalResourceDimension;
}): PlanQuotaAdapter {
  const dimension = TOTAL_RESOURCE_DIMENSIONS[input.dimension];
  return createPlanQuota({
    db: input.db,
    workspaceId: input.workspaceId,
    environment: input.environment,
    featureKey: dimension.featureKey,
    period: 'total',
    liveCount: (scoped) => dimension.live(scoped, input.workspaceId),
  });
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
  /**
   * How many of the thing already exist — for a TOTAL resource quota only.
   *
   * WITHOUT IT, A TOTAL QUOTA ONLY KNOWS WHAT IT WAS TOLD. A counter records
   * what has been consumed through it, and the resources it is meant to be
   * counting predate the day the dimension was wired up: four connected
   * accounts and a counter of zero admitted four more under a limit of five.
   * The count is taken inside the consuming transaction, behind the counter
   * row's lock, so it cannot be a read-then-write race.
   *
   * A quota that counts EVENTS in a window rather than things that exist —
   * scheduled posts per month — has no live population and supplies none.
   */
  liveCount?: (db: TenantScopedClient) => Promise<number>;
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
          ...(input.liveCount ? { baselineCount: input.liveCount } : {}),
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
