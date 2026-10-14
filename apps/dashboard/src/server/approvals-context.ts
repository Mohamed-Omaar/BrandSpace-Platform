import 'server-only';
import { ActivityLogService } from '@brandspace/activity';
import { ContentApprovalService, approvalNotifier } from '@brandspace/content';
import { NotificationService } from '@brandspace/notifications';
import { writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { inWorkspace } from './customer-context';

// F-102 (final review): the notifier lives in `@brandspace/content` now, so
// the worker uses the same one. Re-exported for this app's existing callers.
export { approvalNotifier };

/**
 * Phase 5B-3 wiring — Approvals, Activity Log, Notifications.
 *
 * Kept beside `content-context.ts` rather than inside it because the three
 * modules here are read and written by screens the Content Studio knows nothing
 * about: the Command Center, the Activity Log and the notification inbox.
 *
 * NOTHING HERE HOLDS THE PLATFORM IDENTITY. Every one of these services touches
 * tenant tables under RLS only — approvals, the audit read model and
 * notifications — so unlike generation they run in this app directly, and F-07
 * is not in play.
 */

/**
 * AC-15.6 — where a refused approval gets recorded.
 *
 * A SEPARATE TRANSACTION, deliberately. The service is called inside
 * `withWorkspace`, and a refusal throws, which rolls that transaction back —
 * taking an audit row written just before the throw with it. So the denial is
 * written on its own connection, which commits whatever happens to the one that
 * refused. `packages/auth`'s workspace-access denial does the same thing for the
 * same reason.
 */
export function denialSink(workspaceId: string) {
  return async (event: {
    approvalId: string;
    brandId: string;
    actorUserId: string;
    reason: string;
  }): Promise<void> => {
    await inWorkspace(workspaceId, async ({ db }) =>
      writeDeniedAudit(db, workspaceId, {
        action: 'content.approval_denied',
        actorType: 'USER',
        actorId: event.actorUserId,
        resourceType: 'Approval',
        resourceId: event.approvalId,
        brandId: event.brandId,
        reason: event.reason,
      }),
    );
  };
}

export function approvalService(input: {
  db: TenantScopedClient;
  workspaceId: string;
  policy: ConstructorParameters<typeof ContentApprovalService>[0]['policy'];
}): ContentApprovalService {
  return new ContentApprovalService({
    db: input.db,
    workspaceId: input.workspaceId,
    policy: input.policy,
    notifier: approvalNotifier({ db: input.db, workspaceId: input.workspaceId }),
  });
}

export function activityService(input: {
  db: TenantScopedClient;
  workspaceId: string;
}): ActivityLogService {
  return new ActivityLogService({ db: input.db, workspaceId: input.workspaceId });
}

export function notificationService(input: {
  db: TenantScopedClient;
  workspaceId: string;
}): NotificationService {
  return new NotificationService({ db: input.db, workspaceId: input.workspaceId });
}
