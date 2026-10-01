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

/**
 * PHASE 2B-3 PR 5 — MAY THIS CAMPAIGN BE PAUSED FOR THIS RULE? A live campaign
 * of the workspace and the rule's brand, within `brandScope` (the author's on
 * save, the creator's when the request would be created), PLANNED or ACTIVE.
 * Read-only; `CampaignService.pause` asks again under its own conditional
 * write when a person approves.
 */
export async function campaignPauseRefusal(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly campaignId: unknown;
    readonly brandScope: readonly string[];
  },
): Promise<'campaign_unavailable' | 'campaign_not_pausable' | null> {
  if (typeof input.campaignId !== 'string' || !UUID.test(input.campaignId)) {
    return 'campaign_unavailable';
  }
  if (!brandInScope(input.brandScope, input.brandId)) return 'campaign_unavailable';
  const campaign = await db.campaign.findFirst({
    where: {
      id: input.campaignId,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      deletedAt: null,
    },
    select: { status: true },
  });
  if (!campaign) return 'campaign_unavailable';
  return campaign.status === 'PLANNED' || campaign.status === 'ACTIVE'
    ? null
    : 'campaign_not_pausable';
}
