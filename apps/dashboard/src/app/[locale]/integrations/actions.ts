'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { callSocialApi, inSocial } from '../../../server/social-context';

const log = createLogger({ context: { component: 'dashboard.integrations' } });

/**
 * Connected accounts and publishing actions.
 *
 * THE WORKSPACE, THE ROLE, THE PERMISSIONS AND THE BRANDSCOPE ALL COME FROM THE
 * SESSION. `requireWorkspace(locale, permission)` reads them and re-verifies
 * membership on every call; no form field names any of them, and there is no
 * field a crafted POST could add that would change which workspace is touched.
 *
 * THE IDS *ARE* TAKEN FROM THE FORM, because the customer chooses them. RLS,
 * the composite foreign keys and the services' own brand-scope PREDICATES are
 * what make a foreign one produce a not-found rather than an effect.
 *
 * THE TWO HALVES GO TO DIFFERENT PLACES, AND THAT IS THE POINT:
 *   - connect / disconnect / check-health need the platform app's own client
 *     secret, so they are forwarded to `apps/api` (F-07).
 *   - cancel / retry touch only tenant tables, so they run here.
 */

function pageUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/integrations${search ? `?${search}` : ''}`;
}

function failure(locale: string, error: unknown, action: string): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No account name and no provider text either side.
  log.warn('integrations action failed', {
    correlationId,
    action,
    ...internalErrorFields(error),
  });
  return pageUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

/** The API's refusal code, or a stable INTERNAL. Never its prose. */
function upstreamCode(payload: unknown): string {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}

function actorOf(session: WorkspaceSession) {
  return {
    actorUserId: session.customer.userId,
    brandScope: session.workspace.brandScope,
  };
}

/** Begin an OAuth authorization and send the customer to the provider. */
export async function connectAccountAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.manage');
    const provider = String(formData.get('provider') ?? '');
    const brandId = String(formData.get('brandId') ?? '');

    const result = await callSocialApi('/v1/social/connect', { provider, brandId });
    if (!result.ok) {
      destination = pageUrl(locale, { error: upstreamCode(result.payload) });
    } else {
      const url = (result.payload as { authorizationUrl?: unknown }).authorizationUrl;
      if (typeof url !== 'string') {
        destination = pageUrl(locale, { error: 'INTERNAL' });
      } else {
        /*
         * STRAIGHT TO THE PROVIDER. The authorization URL is the only thing
         * that leaves this action; the state travels inside it and is never
         * echoed into our own query string, where it would land in a browser
         * history, a referrer header and every proxy log between here and
         * there.
         */
        redirect(url);
      }
    }
  } catch (error: unknown) {
    // `redirect()` throws by design; re-throw so Next can handle it.
    if (error instanceof Error && error.message === 'NEXT_REDIRECT') throw error;
    if ((error as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw error;
    destination = failure(locale, error, 'connect');
  }
  revalidatePath(`/${locale}/integrations`);
  redirect(destination!);
}

/** Disconnect, revoking at the provider where it can be reached. */
export async function disconnectAccountAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.manage');
    const connectionId = String(formData.get('connectionId') ?? '');
    const result = await callSocialApi(
      `/v1/social/connections/${encodeURIComponent(connectionId)}/disconnect`,
    );
    destination = result.ok
      ? pageUrl(locale, { ok: 'ACCOUNT_DISCONNECTED' })
      : pageUrl(locale, { error: upstreamCode(result.payload) });
  } catch (error: unknown) {
    destination = failure(locale, error, 'disconnect');
  }
  revalidatePath(`/${locale}/integrations`);
  redirect(destination);
}

/** Ask the provider whether this grant still works. */
export async function checkAccountAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.read');
    const connectionId = String(formData.get('connectionId') ?? '');
    const result = await callSocialApi(
      `/v1/social/connections/${encodeURIComponent(connectionId)}/check`,
    );
    destination = result.ok
      ? pageUrl(locale, { ok: 'ACCOUNT_CHECKED' })
      : pageUrl(locale, { error: upstreamCode(result.payload) });
  } catch (error: unknown) {
    destination = failure(locale, error, 'check');
  }
  revalidatePath(`/${locale}/integrations`);
  redirect(destination);
}

/** Cancel a post that has not left yet. */
export async function cancelPublishAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'publishing.manage');
    const jobId = String(formData.get('jobId') ?? '');
    await inSocial(session.workspace.workspaceId, async ({ pipeline }) =>
      (await pipeline()).cancel({ jobId, ...actorOf(session) }),
    );
    destination = pageUrl(locale, { ok: 'POST_CANCELLED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'cancel');
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}

/** Try a failed post again, after a human has fixed whatever was wrong. */
export async function retryPublishAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'publishing.manage');
    const jobId = String(formData.get('jobId') ?? '');
    await inSocial(session.workspace.workspaceId, async ({ pipeline }) =>
      (await pipeline()).retry({ jobId, ...actorOf(session) }),
    );
    destination = pageUrl(locale, { ok: 'POST_RETRY_QUEUED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'retry');
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}
