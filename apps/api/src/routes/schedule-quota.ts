import {
  EntitlementService,
  QUOTA_FEATURES,
  TenantCatalogueSource,
  UsageService,
} from '@brandspace/entitlements';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { currentEnvironment } from './phase7-context';

/**
 * THE PLAN'S MONTHLY SCHEDULING CEILING — one implementation, two callers.
 *
 * The Copilot schedules and so does a confirmed automation, and both must be
 * subject to the same ceiling the dashboard enforces. D-10 puts the limit in the
 * plan (`limit.scheduled_posts`), resolved through plan, override, flag and
 * default in that precedence; a second implementation of that precedence is a
 * second answer, which is the mistake the Asset Library already records.
 *
 * The FEATURE KEY is the shared constant rather than a literal, so there is one
 * spelling of it in the platform.
 */
export function scheduleQuota(db: TenantScopedClient, workspaceId: string) {
  const client = db as unknown as PrismaClient;
  const usage = new UsageService({ prisma: client });
  const entitlements = new EntitlementService({
    prisma: client,
    catalogueSource: new TenantCatalogueSource(client, currentEnvironment()),
    environment: currentEnvironment(),
  });
  const FEATURE = QUOTA_FEATURES.scheduledPostsPerMonth;

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
