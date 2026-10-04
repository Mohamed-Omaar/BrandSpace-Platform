import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { readPlanCatalogue } from '@brandspace/entitlements';
import { parseConfigPayload } from '@brandspace/config';
import { currentEnvironment } from '@brandspace/shared';

/**
 * THE TRIAL A NEW CUSTOMER WOULD START, from the activated plan catalogue: the
 * lowest active plan with trial days. Null when no plan offers one, and then no
 * screen states a trial. Read by the workspace form and, since the review of
 * #67, by sign-up's trial note — the same terms in both places.
 */
export async function trialTerms(): Promise<{ days: number; credits: number } | null> {
  return withoutTenantContext(
    async (db) => {
      const snapshot = await db.entitlementCatalogueSnapshot.findUnique({
        where: {
          domain_environment: { domain: 'plans', environment: currentEnvironment() },
        },
      });
      const plans = readPlanCatalogue(
        parseConfigPayload('plans', snapshot?.payload ?? {}) as unknown as Record<string, unknown>,
      );
      const trialPlan =
        [...plans]
          .filter((plan) => plan.status === 'active' && plan.trialDays > 0)
          .sort((a, b) => a.tier - b.tier)[0] ?? null;
      return trialPlan ? { days: trialPlan.trialDays, credits: trialPlan.trialCredits } : null;
    },
    { prisma: getPrisma() },
  );
}
