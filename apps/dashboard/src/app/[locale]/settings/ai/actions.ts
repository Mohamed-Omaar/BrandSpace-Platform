'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { inWorkspace, requireWorkspaceAction } from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';
import { saveBrandAiLanguage } from '../../../../server/brand-ai-language';

const log = createLogger({ context: { component: 'dashboard.ai-settings' } });

/**
 * SETTINGS → AI: the brand's AI writing language (G3, D-331).
 *
 * `brand.manage` here; BrandScope, the language's closed set and the audit
 * event in `saveBrandAiLanguage`, inside the workspace's RLS transaction.
 */
export async function saveAiLanguageAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      saveBrandAiLanguage(
        db,
        {
          workspaceId: session.workspace.workspaceId,
          actorUserId: session.customer.userId,
          brandScope: session.workspace.brandScope,
        },
        {
          brandId: String(formData.get('brandId') ?? ''),
          defaultLocale: String(formData.get('defaultLocale') ?? ''),
        },
      ),
    );
    destination = `/${locale}/settings/ai?ok=SETTINGS_SAVED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('AI settings save failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/settings/ai?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings/ai`);
  redirect(destination);
}
