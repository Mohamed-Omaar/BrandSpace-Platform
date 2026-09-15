'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { notificationService } from '../../../server/approvals-context';

const log = createLogger({ context: { component: 'dashboard.notifications' } });

/**
 * Notification actions — Phase 5B-3.
 *
 * READ STATE IS THE READER'S OWN. Both actions pass the SESSION's user id to
 * the service, which puts it in the `where` clause. A crafted POST carrying
 * somebody else's notification id matches no row and changes nothing — the same
 * outcome as an id that never existed, so the caller learns nothing either way.
 *
 * NO PERMISSION KEY GATES THESE, and that is correct rather than an omission:
 * a notification is addressed to one member, and membership of the workspace is
 * the whole of the authority needed to read one's own.
 */

function notificationsUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/notifications${search ? `?${search}` : ''}`;
}

function failure(locale: string, error: unknown, action: string): string {
  const correlationId = randomUUID();
  log.warn('notification action failed', { correlationId, action, ...internalErrorFields(error) });
  return notificationsUrl(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

export async function markNotificationReadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const id = String(formData.get('id') ?? '');

  let destination: string;
  try {
    const session = await requireWorkspace(locale);
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      notificationService({ db, workspaceId: session.workspace.workspaceId }).markRead({
        id,
        userId: session.customer.userId,
      }),
    );
    destination = notificationsUrl(locale);
  } catch (error: unknown) {
    destination = failure(locale, error, 'markNotificationRead');
  }
  revalidatePath(`/${locale}/notifications`);
  revalidatePath(`/${locale}/overview`);
  redirect(destination);
}

export async function markAllNotificationsReadAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');

  let destination: string;
  try {
    const session = await requireWorkspace(locale);
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      notificationService({ db, workspaceId: session.workspace.workspaceId }).markAllRead({
        userId: session.customer.userId,
      }),
    );
    destination = notificationsUrl(locale, { ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'markAllNotificationsRead');
  }
  revalidatePath(`/${locale}/notifications`);
  revalidatePath(`/${locale}/overview`);
  redirect(destination);
}
