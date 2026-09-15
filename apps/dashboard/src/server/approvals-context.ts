import 'server-only';
import { ActivityLogService } from '@brandspace/activity';
import {
  ContentApprovalService,
  type ApprovalNotifier,
  type ApprovalVerdict,
} from '@brandspace/content';
import { NotificationService } from '@brandspace/notifications';
import { writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { inWorkspace } from './customer-context';

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
 * Who hears about a review.
 *
 * THE RECIPIENT LIST IS RESOLVED BY THE SERVICE, and this adapter only
 * delivers. It used to build the list here — every member holding
 * `content.approve` — which ignored membership status and BrandScope, so a
 * member restricted to Brand A learned the title of Brand B's content and a
 * suspended member kept being told. `ContentApprovalService.eligibleReviewers`
 * is now the one answer to "who may review this", used both to validate an
 * assignment and to address the notification, so the two cannot disagree.
 *
 * A NOTIFICATION IS A POINTER, NOT A COPY. It carries the item's title and the
 * link; following the link runs the ordinary permission checks. Copying the
 * caption in would route around them.
 */
export function approvalNotifier(input: {
  db: TenantScopedClient;
  workspaceId: string;
}): ApprovalNotifier {
  const notifications = new NotificationService({ db: input.db, workspaceId: input.workspaceId });

  return {
    async approvalRequested(event) {
      await notifications.create({
        userIds: event.recipientUserIds,
        templateKey: 'approval.requested',
        payload: { itemTitle: event.itemTitle },
        // The REVIEW context, not the content library: the notification is
        // about one cycle, and the review screen is where a reviewer acts on
        // it. Every recipient holds `content.approve` (D-62), so both routes
        // would open — this one is simply the right place to land.
        linkPath: `/approvals?review=${event.approvalId}`,
        brandId: event.brandId,
        resourceType: 'Approval',
        resourceId: event.approvalId,
        // The APPROVAL id, not a clock: a retried submit reuses the same row
        // and must not produce a second notification.
        idempotencyKey: `approval.requested:${event.approvalId}`,
      });
    },

    async approvalDecided(event) {
      // The verdict goes back to whoever asked, and to nobody else: a decision
      // is an answer to a question one person put.
      if (event.notifyUserId === event.decidedByUserId) return;
      await notifications.create({
        userIds: [event.notifyUserId],
        templateKey: templateForVerdict(event.verdict),
        payload: { itemTitle: event.itemTitle },
        linkPath: `/content?item=${event.itemId}`,
        brandId: event.brandId,
        resourceType: 'Approval',
        resourceId: event.approvalId,
        idempotencyKey: `approval.decided:${event.approvalId}`,
      });
    },
  };
}

function templateForVerdict(
  verdict: ApprovalVerdict,
): 'approval.approved' | 'approval.changes_requested' | 'approval.rejected' {
  if (verdict === 'APPROVE') return 'approval.approved';
  if (verdict === 'REQUEST_CHANGES') return 'approval.changes_requested';
  return 'approval.rejected';
}

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
