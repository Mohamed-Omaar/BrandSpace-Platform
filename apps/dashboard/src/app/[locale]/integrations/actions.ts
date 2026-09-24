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

function pageUrl(
  locale: string,
  params: Record<string, string> = {},
  back: ReturnTo = { path: '/integrations' },
): string {
  const search = new URLSearchParams({
    ...(back.path === '/onboarding' ? { step: 'connect' } : {}),
    ...(back.tab ? { tab: back.tab } : {}),
    ...params,
  });
  const query = search.toString();
  return `/${locale}${back.path}${query ? `?${query}` : ''}`;
}

/**
 * WHERE AN ACTION RETURNS TO — a CLOSED SET, never a caller-supplied URL.
 *
 * The same cancel, retry and check controls now appear on Publishing (Phase 6
 * final, D-277) and on Settings > Connections, and the Setup Wizard's
 * "Connect socials" step starts the same OAuth flow (§6). The form names which
 * screen it came from; anything outside this set returns to Connections, so a
 * crafted `returnTo` cannot send the browser anywhere else.
 */
interface ReturnTo {
  readonly path: '/integrations' | '/publishing' | '/onboarding';
  readonly tab?: 'queue' | 'published' | 'failed' | 'accounts' | undefined;
}

const PUBLISHING_TABS = new Set(['queue', 'published', 'failed', 'accounts']);

function returnToOf(formData: FormData): ReturnTo {
  const requested = String(formData.get('returnTo') ?? '');
  if (requested === '/onboarding') return { path: '/onboarding' };
  if (requested !== '/publishing') return { path: '/integrations' };
  const tab = String(formData.get('tab') ?? '');
  return {
    path: '/publishing',
    tab: PUBLISHING_TABS.has(tab) ? (tab as ReturnTo['tab']) : undefined,
  };
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  back: ReturnTo = { path: '/integrations' },
): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No account name and no provider text either side.
  log.warn('integrations action failed', {
    correlationId,
    action,
    ...internalErrorFields(error),
  });
  return pageUrl(locale, { error: toPublicErrorCode(error), ref: correlationId }, back);
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
  const locale = String(formData.get('locale') ?? 'en');
  const back = returnToOf(formData);
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.manage');
    const provider = String(formData.get('provider') ?? '');
    const brandId = String(formData.get('brandId') ?? '');

    const result = await callSocialApi('/v1/social/connect', { provider, brandId });
    if (!result.ok) {
      destination = pageUrl(locale, { error: upstreamCode(result.payload) }, back);
    } else {
      const url = (result.payload as { authorizationUrl?: unknown }).authorizationUrl;
      if (typeof url !== 'string') {
        destination = pageUrl(locale, { error: 'INTERNAL' }, back);
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
    destination = failure(locale, error, 'connect', back);
  }
  revalidatePath(`/${locale}/integrations`);
  redirect(destination!);
}

/** Disconnect, revoking at the provider where it can be reached. */
export async function disconnectAccountAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
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
  const locale = String(formData.get('locale') ?? 'en');
  const back = returnToOf(formData);
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.read');
    const connectionId = String(formData.get('connectionId') ?? '');
    const result = await callSocialApi(
      `/v1/social/connections/${encodeURIComponent(connectionId)}/check`,
    );
    destination = result.ok
      ? pageUrl(locale, { ok: 'ACCOUNT_CHECKED' }, back)
      : pageUrl(locale, { error: upstreamCode(result.payload) }, back);
  } catch (error: unknown) {
    destination = failure(locale, error, 'check', back);
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/publishing`);
  redirect(destination);
}

/** Cancel a post that has not left yet. */
export async function cancelPublishAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const back = returnToOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'publishing.manage');
    const jobId = String(formData.get('jobId') ?? '');
    await inSocial(session.workspace.workspaceId, async ({ pipeline }) =>
      (await pipeline()).cancel({ jobId, ...actorOf(session) }),
    );
    destination = pageUrl(locale, { ok: 'POST_CANCELLED' }, back);
  } catch (error: unknown) {
    destination = failure(locale, error, 'cancel', back);
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/publishing`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}

/** Try a failed post again, after a human has fixed whatever was wrong. */
export async function retryPublishAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const back = returnToOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'publishing.manage');
    const jobId = String(formData.get('jobId') ?? '');
    await inSocial(session.workspace.workspaceId, async ({ pipeline }) =>
      (await pipeline()).retry({ jobId, ...actorOf(session) }),
    );
    destination = pageUrl(locale, { ok: 'POST_RETRY_QUEUED' }, back);
  } catch (error: unknown) {
    destination = failure(locale, error, 'retry', back);
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/publishing`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}

/**
 * Retry a post that failed on a broken account, through the same account now
 * reconnected (D-291). A person pressing Retry; the pipeline decides whether
 * it is allowed and re-checks everything before anything is sent.
 */
export async function retryOnReconnectedAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const back = returnToOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'publishing.manage');
    const jobId = String(formData.get('jobId') ?? '');
    await inSocial(session.workspace.workspaceId, async ({ pipeline }) =>
      (await pipeline()).retryOnReconnectedAccount({ jobId, ...actorOf(session) }),
    );
    destination = pageUrl(locale, { ok: 'POST_RETRY_QUEUED' }, back);
  } catch (error: unknown) {
    destination = failure(locale, error, 'retry-reconnected', back);
  }
  revalidatePath(`/${locale}/integrations`);
  revalidatePath(`/${locale}/publishing`);
  revalidatePath(`/${locale}/calendar`);
  redirect(destination);
}

/**
 * Bind a pending multi-target grant to the page the customer chose (D-142).
 *
 * THE SELECTION SECRET COMES FROM THE FORM AND PROVES NOTHING ON ITS OWN. It
 * arrived in the callback redirect, so it is in a browser history and possibly
 * a referrer; that is why the API checks the workspace, the permission, the
 * brand scope AND that the caller is the person who started the authorization
 * before it will act on it. This action forwards, and `apps/api` decides.
 *
 * FORWARDED RATHER THAN RUN HERE for the usual reason: completing a grant
 * writes a credential, and the dashboard holds no key material at all (F-07).
 */
export async function selectTargetAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    await requireWorkspace(locale, 'integrations.manage');
    const selectionToken = String(formData.get('selectionToken') ?? '');
    const externalAccountId = String(formData.get('externalAccountId') ?? '');

    const result = await callSocialApi('/v1/social/connections/select', {
      selectionToken,
      externalAccountId,
    });
    destination = result.ok
      ? pageUrl(locale, { ok: 'ACCOUNT_CONNECTED' })
      : pageUrl(locale, { error: upstreamCode(result.payload) });
  } catch (error: unknown) {
    destination = failure(locale, error, 'select-target');
  }
  revalidatePath(`/${locale}/integrations`);
  redirect(destination);
}
