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

import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
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

    /*
     * THE SUBSCRIPTION ROW IS LOCKED, THEN READ (review item 8), in the
     * caller's transaction — the one that accepts the request. A plan change
     * committing a moment earlier is seen; one arriving now waits until this
     * request is decided. `finishDue` checks again at the deadline, so a plan
     * resumed while the workspace waits still stops the deletion.
     */
    const subscription = await lockedSubscription(db, input.workspaceId);
    if (stillRenewing(subscription)) {
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
   * `db` MUST BE THE PLATFORM CONNECTION: it acts on every workspace that is
   * due.
   *
   * ONE TRANSACTION PER WORKSPACE (review item 7). The workspace row is locked
   * and re-read, the subscription re-checked, and then DELETED + `deletedAt`,
   * the session revocation and the `workspace.deleted` audit are written
   * together: a failure at any step leaves the workspace exactly as it was —
   * still pending, never half deleted — and the next pass tries again. A
   * cancel that lands first wins, and a rerun is a no-op.
   *
   * A PLAN STILL RENEWING STOPS IT (review item 8): ACTIVE or PAST_DUE and not
   * set to cancel at the period end means the workspace is NOT deleted — the
   * owner resumed or restarted billing while it waited. It stays pending,
   * the reason is audited once (`workspace.deletion_blocked`,
   * `CANCEL_PLAN_FIRST`), and billing is never cancelled here.
   */
  async finishDue(db: PrismaClient, limit = 50): Promise<readonly string[]> {
    const now = this.#clock.now();
    const due = await db.workspace.findMany({
      where: { deletionScheduledFor: { lte: now }, deletedAt: null, status: { not: 'DELETED' } },
      select: { id: true },
      orderBy: { deletionScheduledFor: 'asc' },
      take: limit,
    });

    const finished: string[] = [];
    for (const { id } of due) {
      const outcome = await db.$transaction((tx) =>
        this.#finishOne(tx as unknown as TenantScopedClient, id, now),
      );
      if (outcome === 'deleted') finished.push(id);
    }
    return finished;
  }

  async #finishOne(
    tx: TenantScopedClient,
    workspaceId: string,
    now: Date,
  ): Promise<'deleted' | 'skipped' | 'blocked'> {
    const locked = await tx.$queryRaw<
      { deletionRequestedAt: Date | null; deletionRequestedByUserId: string | null }[]
    >`
      SELECT "deletionRequestedAt", "deletionRequestedByUserId"
        FROM "workspace"
       WHERE "id" = ${workspaceId}::uuid
         AND "deletionScheduledFor" <= ${now}
         AND "deletedAt" IS NULL
         AND "status" <> 'DELETED'
       FOR UPDATE`;
    const workspace = locked[0];
    // Cancelled, already finished, or moved on since the list was read.
    if (!workspace) return 'skipped';

    const subscription = await lockedSubscription(tx, workspaceId);
    if (stillRenewing(subscription)) {
      const flagged = await tx.auditEvent.count({
        where: {
          workspaceId,
          action: 'workspace.deletion_blocked',
          occurredAt: { gte: workspace.deletionRequestedAt ?? new Date(0) },
        },
      });
      if (flagged === 0) {
        await tx.auditEvent.create({
          data: {
            workspaceId,
            actorType: 'SYSTEM',
            actorId: null,
            action: 'workspace.deletion_blocked',
            resourceType: 'workspace',
            resourceId: workspaceId,
            severity: 'WARNING',
            outcome: 'DENIED',
            reason: 'CANCEL_PLAN_FIRST',
            after: { subscriptionStatus: subscription?.status ?? null },
          },
        });
      }
      return 'blocked';
    }

    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'DELETED',
        deletedAt: now,
        statusReason: 'Deleted at the owner’s request after the waiting period.',
        statusChangedAt: now,
      },
    });
    await tx.customerSession.updateMany({
      where: { activeWorkspaceId: workspaceId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'Workspace deleted' },
    });
    await tx.auditEvent.create({
      data: {
        workspaceId,
        actorType: 'SYSTEM',
        actorId: null,
        action: 'workspace.deleted',
        resourceType: 'workspace',
        resourceId: workspaceId,
        severity: 'WARNING',
        outcome: 'SUCCESS',
        after: {
          requestedByUserId: workspace.deletionRequestedByUserId,
          deletedAt: now.toISOString(),
        },
      },
    });
    return 'deleted';
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

/** The workspace's subscription, its row locked FOR UPDATE for this transaction. */
async function lockedSubscription(
  db: TenantScopedClient,
  workspaceId: string,
): Promise<{ readonly status: string; readonly cancelAtPeriodEnd: boolean } | null> {
  const rows = await db.$queryRaw<{ status: string; cancelAtPeriodEnd: boolean }[]>`
    SELECT "status"::text AS "status", "cancelAtPeriodEnd"
      FROM "workspace_subscription"
     WHERE "workspaceId" = ${workspaceId}::uuid
     FOR UPDATE`;
  return rows[0] ?? null;
}

/** Still billing, or will bill again: the existing CANCEL_PLAN_FIRST rule. */
function stillRenewing(
  subscription: { readonly status: string; readonly cancelAtPeriodEnd: boolean } | null,
): boolean {
  return (
    subscription !== null && RENEWING.has(subscription.status) && !subscription.cancelAtPeriodEnd
  );
}
