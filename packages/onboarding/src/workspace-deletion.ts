/**
 * THE OWNER'S WORKSPACE DELETION — A8, prototype v94 Phase 2B-1 (D-328).
 *
 * THREE STEPS, EACH AN AUDIT EVENT:
 *
 *   1. REQUEST (`request`). A member holding `workspace.delete` — the Owner
 *      only — asks for it, having typed the workspace's name and re-entered
 *      their password (the caller verifies both; docs/SECURITY.md §3 asks for
 *      step-up on account deletion). Refused while a paid subscription is
 *      still set to renew: the owner cancels the plan first, through the
 *      existing billing flow, so deleting never becomes a way around a bill
 *      and never cancels one silently. The workspace becomes PENDING DELETION
 *      until `now + graceDays` (configuration, default 30).
 *   2. CANCEL (`cancel`). Any member holding `workspace.delete` may take it
 *      back while it is pending. Nothing was removed, so nothing is restored.
 *   3. FINISH (`finishDue`). A platform job marks a workspace whose deadline
 *      has passed DELETED (`status` + `deletedAt`), revokes the sessions acting
 *      in it and audits `workspace.deleted`. PHYSICAL PURGE of its data is the
 *      data-deletion lifecycle of docs/SECURITY.md §15 and is not done here.
 *
 * WHILE PENDING, nobody works in it: every member lands on a screen that says
 * when it will be deleted (owners may cancel there), the API and credit
 * spending refuse it, and due posts are not published. Those checks live
 * where each surface already authorizes (`listWorkspaces`, the credit ledger,
 * the publishing sweep); this service owns only the state.
 *
 * THE MEMBERS ARE TOLD, IN-APP, through the existing `NotificationService`
 * (owner decision): `workspace.deletion_requested` and
 * `workspace.deletion_cancelled` to every active member but the actor.
 *
 * Request and cancel run on the TENANT client, inside the workspace's own
 * context; `finishDue` runs on the PLATFORM connection because it acts on
 * every workspace that is due.
 */

import type { TenantScopedClient } from '@brandspace/database';
import { NotificationService } from '@brandspace/notifications';
import { AppError, systemClock, type Clock } from '@brandspace/shared';

export const WORKSPACE_PENDING_DELETION_REASON = 'WORKSPACE_PENDING_DELETION';

/** Subscription states that are still billing, or will bill again. */
const RENEWING = new Set(['ACTIVE', 'PAST_DUE']);

export interface DeletionRequestInput {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly actorName: string;
  readonly graceDays: number;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface DeletionCancelInput {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly actorName: string;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export class WorkspaceDeletionService {
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async request(
    db: TenantScopedClient,
    input: DeletionRequestInput,
  ): Promise<{ readonly scheduledFor: Date }> {
    if (!Number.isInteger(input.graceDays) || input.graceDays < 1) {
      throw new AppError('INTERNAL', 'The deletion grace period is not configured.');
    }
    const workspace = await db.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, deletionScheduledFor: true, deletedAt: true },
    });
    if (!workspace || workspace.deletedAt) {
      throw new AppError('NOT_FOUND', 'Not found.');
    }
    if (workspace.deletionScheduledFor) {
      throw new AppError('CONFLICT', 'This workspace is already scheduled for deletion.', {
        reason: 'ALREADY_PENDING',
      });
    }

    const subscription = await db.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { status: true, cancelAtPeriodEnd: true },
    });
    if (subscription && RENEWING.has(subscription.status) && !subscription.cancelAtPeriodEnd) {
      throw new AppError('CONFLICT', 'Cancel the plan before deleting the workspace.', {
        reason: 'CANCEL_PLAN_FIRST',
      });
    }

    const now = this.#clock.now();
    const scheduledFor = new Date(now.getTime() + input.graceDays * 86_400_000);
    // CONDITIONAL, so two concurrent requests cannot both set a date.
    const claimed = await db.workspace.updateMany({
      where: { id: input.workspaceId, deletionScheduledFor: null, deletedAt: null },
      data: {
        deletionRequestedAt: now,
        deletionScheduledFor: scheduledFor,
        deletionRequestedByUserId: input.actorUserId,
      },
    });
    if (claimed.count === 0) {
      throw new AppError('CONFLICT', 'This workspace is already scheduled for deletion.', {
        reason: 'ALREADY_PENDING',
      });
    }

    await db.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorType: 'USER',
        actorId: input.actorUserId,
        action: 'workspace.deletion_requested',
        resourceType: 'workspace',
        resourceId: input.workspaceId,
        severity: 'WARNING',
        outcome: 'SUCCESS',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        after: { scheduledFor: scheduledFor.toISOString(), graceDays: input.graceDays },
      },
    });

    await this.#tellMembers(db, input.workspaceId, input.actorUserId, {
      templateKey: 'workspace.deletion_requested',
      idempotencyKey: `workspace.deletion_requested:${input.workspaceId}:${now.toISOString()}`,
      actorName: input.actorName,
      scheduledFor,
    });
    return { scheduledFor };
  }

  async cancel(db: TenantScopedClient, input: DeletionCancelInput): Promise<void> {
    const before = await db.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { deletionScheduledFor: true, deletedAt: true },
    });
    const released = await db.workspace.updateMany({
      where: { id: input.workspaceId, deletionScheduledFor: { not: null }, deletedAt: null },
      data: {
        deletionRequestedAt: null,
        deletionScheduledFor: null,
        deletionRequestedByUserId: null,
      },
    });
    if (released.count === 0) {
      throw new AppError('CONFLICT', 'This workspace is not scheduled for deletion.', {
        reason: 'NOT_PENDING',
      });
    }

    const now = this.#clock.now();
    await db.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorType: 'USER',
        actorId: input.actorUserId,
        action: 'workspace.deletion_cancelled',
        resourceType: 'workspace',
        resourceId: input.workspaceId,
        severity: 'NOTICE',
        outcome: 'SUCCESS',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        before: { scheduledFor: before?.deletionScheduledFor?.toISOString() ?? null },
      },
    });

    await this.#tellMembers(db, input.workspaceId, input.actorUserId, {
      templateKey: 'workspace.deletion_cancelled',
      idempotencyKey: `workspace.deletion_cancelled:${input.workspaceId}:${now.toISOString()}`,
      actorName: input.actorName,
      scheduledFor: null,
    });
  }

  /**
   * Mark every workspace whose deadline has passed DELETED.
   *
   * `db` MUST BE THE PLATFORM CONNECTION. Each workspace is finished in its own
   * conditional update, so a cancel that lands first wins and a rerun is a
   * no-op: nothing is ever finished twice.
   */
  async finishDue(db: TenantScopedClient, limit = 50): Promise<readonly string[]> {
    const now = this.#clock.now();
    const due = await db.workspace.findMany({
      where: { deletionScheduledFor: { lte: now }, deletedAt: null, status: { not: 'DELETED' } },
      select: { id: true, deletionRequestedByUserId: true },
      orderBy: { deletionScheduledFor: 'asc' },
      take: limit,
    });

    const finished: string[] = [];
    for (const workspace of due) {
      const updated = await db.workspace.updateMany({
        where: {
          id: workspace.id,
          deletionScheduledFor: { lte: now },
          deletedAt: null,
          status: { not: 'DELETED' },
        },
        data: {
          status: 'DELETED',
          deletedAt: now,
          statusReason: 'Deleted at the owner’s request after the waiting period.',
          statusChangedAt: now,
        },
      });
      if (updated.count === 0) continue;

      await db.customerSession.updateMany({
        where: { activeWorkspaceId: workspace.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Workspace deleted' },
      });
      await db.auditEvent.create({
        data: {
          workspaceId: workspace.id,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'workspace.deleted',
          resourceType: 'workspace',
          resourceId: workspace.id,
          severity: 'WARNING',
          outcome: 'SUCCESS',
          after: {
            requestedByUserId: workspace.deletionRequestedByUserId,
            deletedAt: now.toISOString(),
          },
        },
      });
      finished.push(workspace.id);
    }
    return finished;
  }

  async #tellMembers(
    db: TenantScopedClient,
    workspaceId: string,
    actorUserId: string,
    event: {
      readonly templateKey: 'workspace.deletion_requested' | 'workspace.deletion_cancelled';
      readonly idempotencyKey: string;
      readonly actorName: string;
      readonly scheduledFor: Date | null;
    },
  ): Promise<void> {
    const members = await db.membership.findMany({
      where: { workspaceId, status: 'ACTIVE', userId: { not: actorUserId } },
      select: { userId: true },
    });
    await new NotificationService({ db, workspaceId, clock: this.#clock }).create({
      userIds: members.map((member) => member.userId),
      templateKey: event.templateKey,
      payload: {
        actorName: event.actorName,
        ...(event.scheduledFor ? { scheduledFor: event.scheduledFor.toISOString() } : {}),
      },
      resourceType: 'workspace',
      resourceId: workspaceId,
      idempotencyKey: event.idempotencyKey,
    });
  }
}
