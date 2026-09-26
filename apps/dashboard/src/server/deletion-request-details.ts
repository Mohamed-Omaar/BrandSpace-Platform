import type { TenantScopedClient } from '@brandspace/database';

/**
 * WHO ASKED FOR THE DELETION, AND WHEN (review item 9, D-328) — for the
 * "scheduled for deletion" screen, read inside the workspace's own RLS context.
 *
 * Nothing new is exposed: the screen is shown only to the workspace's members,
 * and every member but the requester was already sent the requester's name in
 * the `workspace.deletion_requested` notification. The name comes from the
 * requester's MEMBERSHIP of this workspace — so a person who has since left, or
 * a user row this workspace cannot see, is simply not named.
 */
export interface DeletionRequestDetails {
  readonly requestedAt: Date | null;
  readonly requestedByName: string | null;
  readonly scheduledFor: Date | null;
}

export async function deletionRequestDetails(
  db: TenantScopedClient,
  workspaceId: string,
): Promise<DeletionRequestDetails> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      deletionRequestedAt: true,
      deletionRequestedByUserId: true,
      deletionScheduledFor: true,
    },
  });
  if (!workspace) return { requestedAt: null, requestedByName: null, scheduledFor: null };
  const requester = workspace.deletionRequestedByUserId
    ? await db.membership.findFirst({
        where: { workspaceId, userId: workspace.deletionRequestedByUserId },
        select: { user: { select: { name: true } } },
      })
    : null;
  const name = requester?.user.name?.trim();
  return {
    requestedAt: workspace.deletionRequestedAt,
    requestedByName: name ? name : null,
    scheduledFor: workspace.deletionScheduledFor,
  };
}
