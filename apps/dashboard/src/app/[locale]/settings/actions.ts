'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { inWorkspace, requireWorkspaceAction } from '../../../server/customer-context';
import { generalSettingsFrom, saveGeneralSettings } from '../../../server/general-settings';
import { actionErrorCode } from '../../../server/denial';

const log = createLogger({ context: { component: 'dashboard.settings' } });

/**
 * Workspace settings, edited by the customer — Settings → General (A9, D-330).
 *
 * Runs inside `withWorkspace()` (through `inWorkspace`), so PostgreSQL RLS
 * applies to every statement: even a bug that dropped the `where` clause could
 * not reach another tenant's row. That is the second, independent layer
 * CLAUDE.md §2.1 requires.
 *
 * `workspace.update` opens the form. The sole brand's industry and website ride
 * along only with `brand.manage`, inside the member's BrandScope, and only
 * while multi-brand is off — `saveGeneralSettings` checks all three.
 *
 * The slug, status, plan and billing currency are NOT editable here: they
 * carry billing and routing consequences and belong to the Control Center.
 */
export async function saveSettingsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;

  try {
    const session = await requireWorkspaceAction(locale, 'workspace.update');
    const input = generalSettingsFrom(formData);

    await inWorkspace(session.workspace.workspaceId, async ({ db, entitlements }) =>
      saveGeneralSettings(
        db,
        entitlements,
        {
          workspaceId: session.workspace.workspaceId,
          actorUserId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
          brandScope: session.workspace.brandScope,
        },
        input,
      ),
    );

    destination = `/${locale}/settings?ok=SETTINGS_SAVED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('settings save failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/settings?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings`);
  redirect(destination);
}
