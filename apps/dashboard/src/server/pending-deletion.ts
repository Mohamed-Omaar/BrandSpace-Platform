import 'server-only';
import { redirect } from 'next/navigation';
import {
  getCustomerAuth,
  getSessionToken,
  requireCustomer,
  type WorkspaceSession,
} from './customer-context';

/**
 * THE SESSION'S WORKSPACE, WHEN — AND ONLY WHEN — IT IS PENDING DELETION
 * (A8, D-328).
 *
 * `requireWorkspace` sends every page and action of such a workspace to the
 * "scheduled for deletion" screen; this is that screen's own gate, and its
 * cancel action's. A workspace that is not pending goes back to Home; a
 * session with no workspace goes to the chooser.
 */
export async function pendingDeletionSession(locale: string): Promise<
  WorkspaceSession & {
    readonly workspace: WorkspaceSession['workspace'] & { readonly deletionScheduledFor: Date };
  }
> {
  const customer = await requireCustomer(locale);
  const token = (await getSessionToken()) ?? '';
  const available = await getCustomerAuth()
    .listWorkspaces(token, { includePendingDeletion: true })
    .catch(() => null);
  if (available === null) redirect(`/${locale}/sign-in`);
  const workspace = customer.activeWorkspaceId
    ? available.find((w) => w.workspaceId === customer.activeWorkspaceId)
    : undefined;
  if (!workspace) redirect(`/${locale}/workspaces`);
  const scheduledFor = workspace.deletionScheduledFor ?? null;
  if (!scheduledFor) redirect(`/${locale}/overview`);
  return { customer, workspace: { ...workspace, deletionScheduledFor: scheduledFor }, token };
}
