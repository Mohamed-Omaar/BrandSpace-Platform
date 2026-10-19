'use server';

import { redirect } from 'next/navigation';
import { authorizeParamsFrom, decideAuthorization } from '../../../../server/ai-apps';

/**
 * D-566 — ALLOW OR CANCEL, from the consent screen.
 *
 * The press IS the person's decision (CLAUDE.md §2.5): Allow writes the grant
 * and a one-time code, through the API, and the browser is sent back to the
 * app's registered address with the code. Cancel sends `access_denied` back.
 * Anything the API refuses comes back to the consent screen with a plain
 * reason; a redirect address is only ever the API's, never the form's.
 */
export async function decideConsentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en') === 'ar' ? 'ar' : 'en';
  const params = authorizeParamsFrom(formData);
  const decision = formData.get('decision') === 'allow' ? 'allow' : 'cancel';
  const brandMode = formData.get('brandMode') === 'some' ? 'some' : 'all';
  const brandIds = formData
    .getAll('brandIds')
    .map((value) => String(value))
    .filter((value) => /^[0-9a-f-]{36}$/i.test(value));
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const result = await decideAuthorization(params, {
    decision,
    ...(decision === 'allow'
      ? { workspaceId, brandMode, ...(brandMode === 'some' ? { brandIds } : {}) }
      : {}),
  });
  if (result.status === 'redirect') redirect(result.redirectTo);
  const back = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === 'string')),
    ...(workspaceId ? { ws: workspaceId } : {}),
    error: result.code,
  });
  redirect(`/${locale}/oauth/authorize?${back.toString()}`);
}
