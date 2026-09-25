'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWorkspaceAction } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inContentStudio } from '../../../server/content-context';

/**
 * A person's decision on a preference BrandSpace noticed (D-277 §9, D-295).
 *
 * `content.create` because a preference only ever shapes the drafts this
 * member generates. The service refuses ACCEPT unless the preference is
 * noticed NOW from this person's own audited edits, so a crafted form cannot
 * manufacture a default; dismiss and snooze are theirs to make. Every
 * decision is audited.
 */
const DECISIONS = new Set(['accept', 'dismiss', 'snooze']);
const RETURNS = new Set(['/overview', '/content/compose']);

export async function decidePreferenceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en') === 'ar' ? 'ar' : 'en';
  const decision = String(formData.get('decision') ?? '');
  const key = String(formData.get('key') ?? '');
  const brandId = String(formData.get('brandId') ?? '');
  const requested = String(formData.get('returnTo') ?? '/overview');
  const back = RETURNS.has(requested) ? requested : '/overview';
  let destination = `/${locale}${back}`;
  try {
    const { customer, workspace } = await requireWorkspaceAction(locale, 'content.create');
    if (!DECISIONS.has(decision)) throw new Error('decision');
    await inContentStudio(workspace.workspaceId, async ({ suggestions }) => {
      const service = await suggestions();
      if (decision === 'dismiss' && formData.get('forget') === '1') {
        await service.forgetPreference({ userId: customer.userId, brandId, key });
        return;
      }
      await service.decidePreference({
        userId: customer.userId,
        brandId,
        brandScope: workspace.brandScope,
        key,
        decision: decision as 'accept' | 'dismiss' | 'snooze',
      });
    });
    destination += `?ok=PREFERENCE_${decision.toUpperCase()}`;
  } catch (error: unknown) {
    destination += `?error=${actionErrorCode(error)}`;
  }
  revalidatePath(`/${locale}/overview`);
  redirect(destination);
}

/**
 * "Not now" / "Don't suggest this again" for a recurring workflow (D-296).
 * Accepting one is handing it to the Copilot — there is nothing to store.
 */
export async function decideWorkflowAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en') === 'ar' ? 'ar' : 'en';
  const decision = String(formData.get('decision') ?? '');
  const key = String(formData.get('key') ?? '');
  const brandId = String(formData.get('brandId') ?? '');
  let destination = `/${locale}/overview`;
  try {
    const { customer, workspace } = await requireWorkspaceAction(locale, 'content.create');
    if (decision !== 'dismiss' && decision !== 'snooze') throw new Error('decision');
    await inContentStudio(workspace.workspaceId, async ({ suggestions }) =>
      (await suggestions()).decideWorkflow({
        userId: customer.userId,
        brandId,
        brandScope: workspace.brandScope,
        key,
        decision,
      }),
    );
    destination += `?ok=WORKFLOW_${decision.toUpperCase()}`;
  } catch (error: unknown) {
    destination += `?error=${actionErrorCode(error)}`;
  }
  revalidatePath(`/${locale}/overview`);
  redirect(destination);
}
