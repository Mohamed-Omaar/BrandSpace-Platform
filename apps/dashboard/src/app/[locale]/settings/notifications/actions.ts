'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  NOTIFICATION_CATEGORIES,
  NotificationPreferenceService,
  type NotificationCategory,
} from '@brandspace/notifications';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';

const log = createLogger({ context: { component: 'dashboard.notification-preferences' } });

/**
 * SAVE MY NOTIFICATION SWITCHES (A10 / G2, D-331).
 *
 * Any member, for THEMSELVES only: the person is the session's, never a field
 * of the form, and the service names that `userId` in every query. A checkbox
 * that is absent is "off"; the four categories are a closed set, so nothing
 * the form invents can be stored (the database CHECK agrees).
 */
export async function saveNotificationPreferencesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspace(locale);
    const on = new Set(formData.getAll('category').map((value) => String(value)));
    const next = Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((category) => [category, on.has(category)]),
    ) as Record<NotificationCategory, boolean>;
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      new NotificationPreferenceService({ db, workspaceId: session.workspace.workspaceId }).set(
        session.customer.userId,
        next,
      ),
    );
    destination = `/${locale}/settings/notifications?ok=SETTINGS_SAVED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('notification preferences save failed', {
      correlationId,
      ...internalErrorFields(error),
    });
    destination = `/${locale}/settings/notifications?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings/notifications`);
  redirect(destination);
}
