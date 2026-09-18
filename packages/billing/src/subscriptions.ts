/**
 * The commercial lifecycle of a subscription, as the CUSTOMER drives it (§26).
 *
 * ENTITLEMENTS RESOLVE FROM OUR ROW, NOT FROM THE PROVIDER. `providerKey` and
 * `providerSubscriptionId` are references we keep so we can talk to the provider
 * about the right object; they are never consulted to decide what a customer may
 * do. A provider outage therefore removes nobody's access
 * (docs/BILLING-AND-CREDITS.md §1.1).
 *
 * UPGRADE NOW, DOWNGRADE AT PERIOD END (D-12). An upgrade is something the
 * customer is asking for and paying for, so it applies as soon as the payment is
 * authoritative. A downgrade REMOVES capability, so it waits for the period the
 * customer already paid for to end — nothing they have is taken away early, and
 * nothing is ever deleted to make a smaller plan fit (§38).
 *
 * CANCELLING IS NOT DELETING. It stops the renewal. Access runs to the end of
 * the paid period, the workspace's data stays, and an export remains available.
 * There is no path in this file that destroys customer work.
 */

import type { TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { PlanDetail } from '@brandspace/entitlements';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import { planAvailability, type CommercePolicy } from './commerce';
import { nextDunningStep } from './dunning';

export type SubscriptionCommercialStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'PAUSED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'CHECKOUT_PENDING'
  | 'SUSPENDED';

export interface CommercialSubscriptionView {
  readonly workspaceId: string;
  readonly planKey: string;
  readonly status: SubscriptionCommercialStatus;
  readonly billingInterval: 'MONTH' | 'YEAR';
  readonly currency: string;
  readonly monthly: Money;
  readonly annual: Money;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly pendingPlanKey: string | null;
  readonly pendingPlanEffectiveAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pastDueSince: Date | null;
  readonly graceEndsAt: Date | null;
  readonly suspendedAt: Date | null;
}

/** What a plan change will do, BEFORE the customer commits to it (§26). */
export interface PlanChangePreview {
  readonly fromPlanKey: string;
  readonly toPlanKey: string;
  readonly direction: 'upgrade' | 'downgrade' | 'same';
  /** An upgrade is paid for now; a downgrade takes effect at this instant. */
  readonly effectiveAt: Date;
  readonly requiresPayment: boolean;
  readonly amountDueNow: Money | null;
  readonly currency: string;
}

export class SubscriptionLifecycleService {
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  async get(
    db: TenantScopedClient,
    workspaceId: string,
    scale: number,
  ): Promise<CommercialSubscriptionView | null> {
    const row = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!row) return null;
    return {
      workspaceId: row.workspaceId,
      planKey: row.planKey,
      status: row.status as SubscriptionCommercialStatus,
      billingInterval: row.billingInterval as 'MONTH' | 'YEAR',
      currency: row.currency,
      monthly: Money.ofMinor(row.currency, row.pinnedMonthlyMinor, scale),
      annual: Money.ofMinor(row.currency, row.pinnedAnnualMinor, scale),
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      trialEndsAt: row.trialEndsAt,
      pendingPlanKey: row.pendingPlanKey,
      pendingPlanEffectiveAt: row.pendingPlanEffectiveAt,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      pastDueSince: row.pastDueSince,
      graceEndsAt: row.graceEndsAt,
      suspendedAt: row.suspendedAt,
    };
  }

  /**
   * Explain a plan change before anything happens.
   *
   * THE CUSTOMER IS TOLD WHAT THEY WILL PAY AND WHEN, in their own currency,
   * BEFORE the change is made (§26). A commercial action a customer cannot
   * predict is not consent, whatever they clicked.
   */
  async previewChange(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly policy: CommercePolicy;
      readonly current: PlanDetail;
      readonly target: PlanDetail;
      readonly billingInterval: 'MONTH' | 'YEAR';
      readonly country: string;
      readonly currency: string;
    },
  ): Promise<PlanChangePreview> {
    const row = await db.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');

    const availability = planAvailability(
      input.policy,
      input.target,
      input.country,
      input.currency,
    );
    if (!availability.available) {
      throw new AppError('VALIDATION_FAILED', 'That plan cannot be bought here.', {
        reason: availability.reason ?? 'unavailable',
      });
    }

    const direction =
      input.target.tier > input.current.tier
        ? 'upgrade'
        : input.target.tier < input.current.tier
          ? 'downgrade'
          : 'same';

    const price = input.billingInterval === 'YEAR' ? availability.annual : availability.monthly;

    return {
      fromPlanKey: input.current.key,
      toPlanKey: input.target.key,
      direction,
      effectiveAt: direction === 'downgrade' ? row.currentPeriodEnd : this.#clock.now(),
      requiresPayment: direction !== 'downgrade',
      amountDueNow: direction === 'downgrade' ? null : price,
      currency: input.currency,
    };
  }

  /**
   * Record a downgrade. Nothing is removed and nothing is charged.
   *
   * THE ONLY WRITE IS A NOTE OF WHAT WILL HAPPEN LATER. Resources over the
   * smaller plan's limits are handled at the boundary by the entitlement rules
   * (excess becomes read-only or archived — never deleted), and the customer can
   * change their mind until then.
   */
  async scheduleDowngrade(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly targetPlanKey: string;
      readonly actorUserId: string | null;
    },
  ): Promise<CommercialSubscriptionView | null> {
    const row = await db.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');

    await db.workspaceSubscription.update({
      where: { workspaceId: input.workspaceId },
      data: {
        pendingPlanKey: input.targetPlanKey,
        pendingPlanEffectiveAt: row.currentPeriodEnd,
      },
    });

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.subscription.downgrade-scheduled',
      actorType: 'USER',
      actorId: input.actorUserId ?? undefined,
      resourceType: 'WorkspaceSubscription',
      resourceId: input.workspaceId,
      severity: 'NOTICE',
      before: { planKey: row.planKey },
      after: {
        pendingPlanKey: input.targetPlanKey,
        effectiveAt: row.currentPeriodEnd.toISOString(),
      },
    });

    return this.get(db, input.workspaceId, 2);
  }

  /** Withdraw a scheduled downgrade before it takes effect. */
  async clearPendingChange(
    db: TenantScopedClient,
    workspaceId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const { count } = await db.workspaceSubscription.updateMany({
      where: { workspaceId, pendingPlanKey: { not: null } },
      data: { pendingPlanKey: null, pendingPlanEffectiveAt: null },
    });
    if (count === 0) return;
    await writeAuditEvent(db, workspaceId, {
      action: 'billing.subscription.downgrade-cancelled',
      actorType: 'USER',
      actorId: actorUserId ?? undefined,
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
    });
  }

  /**
   * Cancel at the end of the paid period.
   *
   * A HIGH-IMPACT ACTION (CLAUDE.md §2.5): the caller is responsible for the
   * confirmation, and this writes the audit event. It never cancels immediately
   * — the customer paid for the period and keeps it.
   */
  async cancelAtPeriodEnd(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly actorUserId: string | null;
      readonly reason: string;
    },
  ): Promise<Date> {
    const row = await db.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');

    await db.workspaceSubscription.update({
      where: { workspaceId: input.workspaceId },
      data: { cancelAtPeriodEnd: true, cancelRequestedAt: this.#clock.now() },
    });

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.subscription.cancel-requested',
      actorType: 'USER',
      actorId: input.actorUserId ?? undefined,
      resourceType: 'WorkspaceSubscription',
      resourceId: input.workspaceId,
      severity: 'NOTICE',
      reason: input.reason,
      after: { endsAt: row.currentPeriodEnd.toISOString() },
    });

    return row.currentPeriodEnd;
  }

  /** Change their mind, any time before the period ends. */
  async resume(
    db: TenantScopedClient,
    workspaceId: string,
    actorUserId: string | null,
  ): Promise<void> {
    const { count } = await db.workspaceSubscription.updateMany({
      where: { workspaceId, cancelAtPeriodEnd: true },
      data: { cancelAtPeriodEnd: false, cancelRequestedAt: null },
    });
    if (count === 0) return;
    await writeAuditEvent(db, workspaceId, {
      action: 'billing.subscription.resumed',
      actorType: 'USER',
      actorId: actorUserId ?? undefined,
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
    });
  }

  /**
   * Advance the dunning state for one past-due subscription.
   *
   * WHAT IT WILL NEVER DO: delete anything, or reduce a plan to fit unpaid
   * usage. It withdraws ACCESS when the grace period is over, and records that
   * it did. Retention and export are unaffected (§38).
   */
  async advanceDunning(
    db: TenantScopedClient,
    input: { readonly workspaceId: string; readonly policy: CommercePolicy },
  ): Promise<'retry' | 'grace' | 'suspend' | 'not_due'> {
    const row = await db.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!row?.pastDueSince) return 'not_due';

    const attemptsMade = await db.paymentAttempt.count({
      where: {
        workspaceId: input.workspaceId,
        status: 'FAILED',
        attemptedAt: { gte: row.pastDueSince },
      },
    });

    const step = nextDunningStep({
      policy: input.policy.dunning,
      firstFailedAt: row.pastDueSince,
      attemptsMade: Math.max(attemptsMade, 1),
      now: this.#clock.now(),
    });

    if (step.kind !== 'suspend') return step.kind;
    if (row.suspendedAt) return 'suspend';

    await db.workspaceSubscription.update({
      where: { workspaceId: input.workspaceId },
      data: { status: 'SUSPENDED', suspendedAt: this.#clock.now() },
    });
    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.subscription.suspended',
      actorType: 'SYSTEM',
      resourceType: 'WorkspaceSubscription',
      resourceId: input.workspaceId,
      severity: 'CRITICAL',
      reason: 'Payment was not collected before the grace period ended.',
      // Stated so the audit record cannot be misread later as a deletion.
      after: { accessWithdrawn: true, dataRetained: true },
    });
    return 'suspend';
  }
}
