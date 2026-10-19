'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWorkspace } from '../../../../server/customer-context';
import { revokeAiAppConnection } from '../../../../server/ai-apps';

/**
 * D-566 — REVOKE A CONNECTED AI APP.
 *
 * Two steps, like disconnecting an account (CLAUDE.md §2.5): only the
 * confirming button carries `intent=REVOKE`, and the API holds the
 * confirmation too (`confirm: true`). Whose connection may be revoked is the
 * API's decision: your own, or everyone's with `integrations.manage`; anything
 * else is a miss.
 */
export async function revokeAiAppAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en') === 'ar' ? 'ar' : 'en';
  await requireWorkspace(locale);
  const id = String(formData.get('connectionId') ?? '');
  const ok =
    formData.get('intent') === 'REVOKE' && /^[0-9a-f-]{36}$/i.test(id)
      ? await revokeAiAppConnection(id)
      : false;
  revalidatePath(`/${locale}/settings/ai-apps`);
  redirect(`/${locale}/settings/ai-apps?${ok ? 'ok=AI_APP_REVOKED' : 'error=AI_APP_NOT_REVOKED'}`);
}
