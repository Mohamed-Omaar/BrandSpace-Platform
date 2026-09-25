'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { assertBrandInScope, createLogger, internalErrorFields } from '@brandspace/shared';
import { requireWorkspaceAction } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inContentStudio } from '../../../server/content-context';
import { campaignFormFrom } from '../../../server/campaign-form';

const log = createLogger({ context: { component: 'dashboard.campaigns' } });

/**
 * THE CAMPAIGN WRITE PATH.
 *
 * WHAT EACH LAYER IS FOR, so none of them is mistaken for the others:
 *
 *   1. `requireWorkspace(locale, 'campaigns.manage')` re-verifies the session
 *      and the permission on every request, and answers 404 without it — never
 *      403, so a role cannot learn which screens exist but are shut to it.
 *   2. `assertBrandInScope` runs BEFORE any read on the create path, because a
 *      brand outside the member's scope must be indistinguishable from one that
 *      does not exist.
 *   3. `CampaignService` puts the scope in the WHERE (D-132), so an
 *      out-of-scope campaign is never retrieved rather than retrieved and then
 *      rejected — and writes the `AuditEvent` for every transition.
 *   4. RLS, under `inContentStudio`, which is the only one still true after
 *      somebody edits this file.
 *
 * THE CHANNEL LIST COMES FROM THE ACTIVATED CONFIGURATION, not from this file
 * (CLAUDE.md §2.2). The decoder is TOLD what is legal; a platform key the
 * operator has not enabled is refused rather than quietly stored.
 */
export async function createCampaignAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const brandId = String(formData.get('brandId') ?? '');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'campaigns.manage');
    assertBrandInScope(session.workspace.brandScope, brandId);

    const created = await inContentStudio(session.workspace.workspaceId, async (services) => {
      const policy = await services.policy();
      const input = campaignFormFrom(formData, {
        allowedChannels: policy.platforms.map((platform) => platform.key),
        withStatus: false,
      });
      return services.campaigns().create({
        brandId,
        name: input.name,
        objective: input.objective,
        ...(input.brief ? { brief: input.brief } : {}),
        ...(input.description === null ? {} : { description: input.description }),
        ...(input.startDate === null ? {} : { startDate: input.startDate }),
        ...(input.endDate === null ? {} : { endDate: input.endDate }),
        channels: input.channels,
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
        },
      });
    });

    destination = `/${locale}/campaigns/${created.id}?ok=CAMPAIGN_CREATED`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('campaign create failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/campaigns/new?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/campaigns`);
  redirect(destination);
}

export async function updateCampaignAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const campaignId = String(formData.get('campaignId') ?? '');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'campaigns.manage');

    await inContentStudio(session.workspace.workspaceId, async (services) => {
      const policy = await services.policy();
      const input = campaignFormFrom(formData, {
        allowedChannels: policy.platforms.map((platform) => platform.key),
        withStatus: true,
      });
      /*
       * OPTIMISTIC CONCURRENCY, carried by the form. Two people editing the
       * same campaign is an ordinary thing; the second save losing the first
       * one's work silently is not. The service compares and refuses.
       */
      const expected = Number(formData.get('version'));
      return services.campaigns().update({
        campaignId,
        ...(Number.isInteger(expected) && expected > 0 ? { expectedVersion: expected } : {}),
        name: input.name,
        objective: input.objective,
        ...(input.brief ? { brief: input.brief } : {}),
        description: input.description,
        ...(input.status ? { status: input.status } : {}),
        startDate: input.startDate,
        endDate: input.endDate,
        channels: input.channels,
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
        },
      });
    });

    destination = `/${locale}/campaigns/${campaignId}?ok=CAMPAIGN_SAVED`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('campaign update failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/campaigns/${campaignId}?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/campaigns`);
  redirect(destination);
}

/**
 * Archive a campaign.
 *
 * A SOFT DELETE WITH ITS OWN AUDIT EVENT, not a status a dropdown can reach —
 * which is why `ARCHIVED` is absent from the form decoder's status list. One
 * state with two doors behind it is how two behaviours end up wearing one name.
 * The campaign's content is untouched: `content_item.campaignId` is
 * `ON DELETE SET NULL` and nothing here deletes a row.
 */
export async function archiveCampaignAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const campaignId = String(formData.get('campaignId') ?? '');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'campaigns.manage');
    await inContentStudio(session.workspace.workspaceId, async (services) =>
      services.campaigns().archive({
        campaignId,
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
        },
      }),
    );
    destination = `/${locale}/campaigns?ok=CAMPAIGN_ARCHIVED`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('campaign archive failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/campaigns/${campaignId}?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/campaigns`);
  redirect(destination);
}

/** Next.js signals `notFound()` and `redirect()` by throwing; this is that. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    ((error as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (error as { digest: string }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
  );
}
