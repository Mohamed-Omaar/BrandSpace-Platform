'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { getPrisma, writeAuditEvent, withWorkspace } from '@brandspace/database';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { requireWorkspace } from '../../../server/customer-context';

const log = createLogger({ context: { component: 'dashboard.settings' } });

/**
 * Workspace settings, edited by the customer.
 *
 * Runs inside `withWorkspace()`, so PostgreSQL RLS applies to every statement:
 * even a bug that dropped the `where` clause could not reach another tenant's
 * row. That is the second, independent layer CLAUDE.md §2.1 requires.
 *
 * The slug, status, plan and country are NOT editable here: they carry billing
 * and routing consequences and belong to the Control Center.
 */
export async function saveSettingsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspace(locale, 'workspace.update');
    const name = String(formData.get('name') ?? '').trim();
    if (name.length < 2) throw new AppError('VALIDATION_FAILED', 'A workspace name is required.');

    const defaultLocale = String(formData.get('defaultLocale') ?? 'EN');
    if (defaultLocale !== 'AR' && defaultLocale !== 'EN') {
      throw new AppError('VALIDATION_FAILED', 'Unsupported locale.');
    }
    const timezone = String(formData.get('timezone') ?? '').trim();

    await withWorkspace(
      session.workspace.workspaceId,
      async (db) => {
        const before = await db.workspace.findUniqueOrThrow({
          where: { id: session.workspace.workspaceId },
          select: { name: true, defaultLocale: true, timezone: true },
        });
        await db.workspace.update({
          where: { id: session.workspace.workspaceId },
          data: { name, defaultLocale, timezone },
        });
        await writeAuditEvent(db, session.workspace.workspaceId, {
          action: 'workspace.settings.updated',
          actorType: 'USER',
          actorId: session.customer.userId,
          resourceType: 'workspace',
          resourceId: session.workspace.workspaceId,
          severity: 'NOTICE',
          before,
          after: { name, defaultLocale, timezone },
        });
      },
      { prisma: getPrisma() },
    );

    destination = `/${locale}/settings?ok=SETTINGS_SAVED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('settings save failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/settings?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings`);
  redirect(destination);
}
