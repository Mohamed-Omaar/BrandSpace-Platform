'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { TenantOnboardingPolicySource, WorkspaceDeletionService } from '@brandspace/onboarding';
import { AppError, createLogger, internalErrorFields } from '@brandspace/shared';
import {
  currentEnvironment,
  getCustomerAuth,
  inWorkspace,
  memberDisplayName,
  requestOrigin,
  requireWorkspaceAction,
} from '../../../../server/customer-context';
import { actionErrorCode } from '../../../../server/denial';

const log = createLogger({ context: { component: 'dashboard.workspace-deletion' } });

/**
 * THE OWNER ASKS FOR THE WORKSPACE TO BE DELETED (A8, D-328).
 *
 * `workspace.delete` — the Owner only (the Admin's deny list excludes it).
 * Two confirmations, both checked HERE, on the server, before anything is
 * written: the workspace's exact name typed back, and the person's password
 * (step-up, docs/SECURITY.md §3 — a wrong one counts toward their lockout).
 * The service then refuses a workspace whose paid plan still renews, sets the
 * deletion date from configuration, audits it and tells the members.
 */
export async function requestWorkspaceDeletionAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'workspace.delete');
    const typed = String(formData.get('typedWorkspaceName') ?? '').trim();
    if (typed !== session.workspace.workspaceName.trim()) {
      throw new AppError('VALIDATION_FAILED', 'The workspace name does not match.', {
        reason: 'DELETION_NAME_MISMATCH',
      });
    }
    const origin = await requestOrigin();
    const passwordOk = await getCustomerAuth().confirmPassword({
      token: session.token,
      password: String(formData.get('password') ?? ''),
      ip: origin.ip,
      userAgent: origin.userAgent,
    });
    if (!passwordOk) {
      throw new AppError('UNAUTHENTICATED', 'The password is not correct.', {
        reason: 'STEP_UP_FAILED',
      });
    }

    await inWorkspace(session.workspace.workspaceId, async ({ db }) => {
      const policy = await new TenantOnboardingPolicySource(db, currentEnvironment()).load();
      await new WorkspaceDeletionService().request(db, {
        workspaceId: session.workspace.workspaceId,
        actorUserId: session.customer.userId,
        actorName: memberDisplayName(session.customer),
        graceDays: policy.workspaceDeletion.graceDays,
        ip: origin.ip,
        userAgent: origin.userAgent,
      });
    });
    destination = `/${locale}/deletion-pending`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('workspace deletion request failed', {
      correlationId,
      ...internalErrorFields(error),
    });
    const reason =
      error instanceof AppError && typeof error.publicDetails['reason'] === 'string'
        ? error.publicDetails['reason']
        : null;
    const code =
      reason === 'CANCEL_PLAN_FIRST' ||
      reason === 'DELETION_NAME_MISMATCH' ||
      reason === 'STEP_UP_FAILED'
        ? reason
        : actionErrorCode(error);
    destination = `/${locale}/settings/data?error=${code}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings/data`);
  redirect(destination);
}
