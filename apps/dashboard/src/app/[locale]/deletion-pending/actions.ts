'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { WorkspaceDeletionService } from '@brandspace/onboarding';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import {
  holdsPermission,
  inWorkspace,
  memberDisplayName,
  requestOrigin,
} from '../../../server/customer-context';
import { actionErrorCode, permissionDenied } from '../../../server/denial';
import { pendingDeletionSession } from '../../../server/pending-deletion';

const log = createLogger({ context: { component: 'dashboard.workspace-deletion' } });

/**
 * AN OWNER TAKES THE DELETION REQUEST BACK (A8, D-328).
 *
 * The ONE action a workspace pending deletion still accepts, so it cannot go
 * through `requireWorkspaceAction` — that gate closes the workspace. Its own
 * gate asks the same two things: the session's workspace is this one and is
 * pending, and the member holds `workspace.delete` (the Owner). Refused
 * otherwise, and nothing is written.
 */
export async function cancelWorkspaceDeletionAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await pendingDeletionSession(locale);
    if (!holdsPermission(session.workspace, 'workspace.delete')) {
      throw permissionDenied('workspace.delete');
    }
    const origin = await requestOrigin();
    await inWorkspace(session.workspace.workspaceId, async ({ db }) =>
      new WorkspaceDeletionService().cancel(db, {
        workspaceId: session.workspace.workspaceId,
        actorUserId: session.customer.userId,
        actorName: memberDisplayName(session.customer),
        ip: origin.ip,
        userAgent: origin.userAgent,
      }),
    );
    destination = `/${locale}/settings/data?ok=DELETION_CANCELLED`;
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    const correlationId = randomUUID();
    log.warn('workspace deletion cancel failed', { correlationId, ...internalErrorFields(error) });
    destination = `/${locale}/deletion-pending?error=${actionErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/deletion-pending`);
  redirect(destination);
}

function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}
