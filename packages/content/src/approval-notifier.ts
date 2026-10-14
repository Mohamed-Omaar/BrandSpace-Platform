import type { TenantScopedClient } from '@brandspace/database';
import { NotificationService } from '@brandspace/notifications';
import type { ApprovalNotifier, ApprovalVerdict } from './approvals';

/*
 * F-102 (FINAL REVIEW) — ONE NOTIFIER FOR EVERY CALLER. This adapter lived in
 * the dashboard (`apps/dashboard/src/server/approvals-context.ts`), so the
 * worker, which cannot import from an app, built its `ContentApprovalService`
 * without one: a review an automation asked for reached no reviewer's inbox.
 * It moved here unchanged, and the dashboard and the worker both use it.
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
        // THE POST ITSELF, in the composer, where its conversation is (D-277
        // §28/§29): a "changes requested" verdict is answered by editing there.
        linkPath: `/content/compose?item=${event.itemId}`,
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
