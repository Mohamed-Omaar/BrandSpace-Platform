import type { TenantScopedClient } from '@brandspace/database';
import { brandInScope } from '@brandspace/shared';

/**
 * PHASE 2B-3 PR 2 — DOES THE PERSON OR CAMPAIGN A RULE'S ACTION NAMES STILL
 * RESOLVE FOR THE RULE'S BRAND?
 *
 * Asked twice with the same answer: when the rule is saved (a refusal shaped
 * like a genuine miss, D-132) and on every run (a run that ends BLOCKED and says
 * why). The definitions are the ones the stale-condition check already uses, so
 * "who may be named" means one thing everywhere:
 *
 *   - a PERSON is an ACTIVE member of the workspace whose BrandScope admits the
 *     brand — decided by `brandInScope` in code, never by an array filter in
 *     SQL, because NULL means "every brand" and SQL drops it;
 *   - a CAMPAIGN is a live (not deleted) campaign of this workspace AND this
 *     brand.
 *
 * AN ID THAT IS NOT A UUID RESOLVES TO NOTHING and never reaches the database:
 * comparing it to a `uuid` column would abort the caller's transaction.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function personTargetResolves(
  db: TenantScopedClient,
  input: { readonly workspaceId: string; readonly brandId: string; readonly userId: unknown },
): Promise<boolean> {
  if (typeof input.userId !== 'string' || !UUID.test(input.userId)) return false;
  const membership = await db.membership.findFirst({
    where: { workspaceId: input.workspaceId, userId: input.userId, status: 'ACTIVE' },
    select: { brandScope: true },
  });
  return membership !== null && brandInScope(membership.brandScope, input.brandId);
}

export async function campaignTargetResolves(
  db: TenantScopedClient,
  input: { readonly workspaceId: string; readonly brandId: string; readonly campaignId: unknown },
): Promise<boolean> {
  if (typeof input.campaignId !== 'string' || !UUID.test(input.campaignId)) return false;
  const campaign = await db.campaign.findFirst({
    where: {
      id: input.campaignId,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      deletedAt: null,
    },
    select: { id: true },
  });
  return campaign !== null;
}
