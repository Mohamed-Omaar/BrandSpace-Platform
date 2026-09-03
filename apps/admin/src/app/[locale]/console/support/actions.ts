'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  getSupportModeService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';
import { SUPPORT_COOKIE } from '../../../../server/support-cookie';

const log = createLogger({ context: { component: 'admin.support' } });

/**
 * Support Mode server actions.
 *
 * The active session id lives in its own short-lived cookie. It is NOT a
 * session in its own right: it names a grant that the service re-validates on
 * every use — owner, expiry and workspace all re-checked server-side. Holding
 * the cookie without the platform session grants nothing at all, because
 * `requirePlatformActor()` runs first and the grant is bound to that actor.
 */

function backTo(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/console/support${search ? `?${search}` : ''}`;
}

export async function startSupportAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.support_mode.enter');
    const grant = await withSpan('support_mode.start', {}, async () =>
      getSupportModeService().start(
        serviceActor(actor),
        String(formData.get('workspaceId') ?? ''),
        String(formData.get('reason') ?? ''),
        String(formData.get('ticketRef') ?? '') || undefined,
      ),
    );

    const store = await cookies();
    store.set(SUPPORT_COOKIE, grant.id, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      // The cookie cannot outlive the grant. Even if it did, the service
      // re-checks `expiresAt` on every resolve.
      maxAge: Math.max(1, grant.remainingSeconds),
    });
    destination = backTo(locale, { ok: 'SUPPORT_STARTED' });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.error('support mode start failed', { correlationId, ...internalErrorFields(error) });
    destination = backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
  }
  revalidatePath(`/${locale}/console`);
  redirect(destination);
}

export async function endSupportAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.support_mode.enter');
    const store = await cookies();
    const sessionId = store.get(SUPPORT_COOKIE)?.value;
    if (sessionId) {
      await getSupportModeService().end(sessionId, actor.platformUserId);
      store.delete(SUPPORT_COOKIE);
    }
    destination = backTo(locale, { ok: 'SUPPORT_ENDED' });
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.error('support mode end failed', { correlationId, ...internalErrorFields(error) });
    destination = backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
  }
  revalidatePath(`/${locale}/console`);
  redirect(destination);
}
