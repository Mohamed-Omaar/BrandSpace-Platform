import type { PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import { addMonthsClamped } from './credit-policy';

/**
 * The commercial state of a workspace — plan, pinned price, trial, cycle.
 *
 * WHAT THIS IS NOT. It is not billing. No payment provider is called, no
 * invoice is produced, no card is stored. Payment collection is Phase 7 and
 * this phase must not simulate it.
 *
 * WHY IT IS HERE ANYWAY. Three Phase 3 requirements cannot be met from
 * `Workspace.planKey` alone:
 *
 *   AC-04.7  Changing a plan's price must not reprice existing customers. So
 *            the agreed price is COPIED onto the subscription when the plan is
 *            assigned, together with the configuration version it came from.
 *            Every later catalogue edit changes what NEW customers are offered
 *            and nothing else. This is the whole reason the columns exist: a
 *            system that reads the price out of the live catalogue at render
 *            time cannot have this property, however carefully it is written.
 *
 *   AC-04.11 A workspace cannot start a second trial. `trialStartedAt` is set
 *            once and never cleared — not when the trial ends, not when the
 *            plan changes, not when the subscription is cancelled.
 *
 *   Credits   The monthly grant and the rollover sweep run on the
 *            subscription's own period boundary. A customer who starts on the
 *            20th resets on the 20th (docs/BILLING-AND-CREDITS.md §11).
 */

export interface PlanPricing {
  readonly currency: string;
  readonly monthlyMinor: number;
  readonly annualMinor: number;
}

/** What the caller must hand over from the plan configuration. */
export interface PlanTerms {
  readonly planKey: string;
  readonly pricing: PlanPricing;
  readonly monthlyCredits: number;
  readonly trialDays: number;
  readonly trialCredits: number;
  readonly tier: number;
  /** Which `plans` configuration version these terms were read from. */
  readonly sourceVersionId: string | null;
}

export interface SubscriptionView {
  readonly workspaceId: string;
  readonly planKey: string;
  readonly status: 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED';
  readonly billingInterval: 'MONTH' | 'YEAR';
  readonly currency: string;
  readonly pinnedMonthlyMinor: number;
  readonly pinnedAnnualMinor: number;
  readonly pinnedMonthlyCredits: number;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialStartedAt: Date | null;
  readonly trialEndsAt: Date | null;
  readonly pendingPlanKey: string | null;
  readonly pendingPlanEffectiveAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
}

export interface SubscriptionServiceOptions {
  readonly prisma: PrismaClient;
  readonly clock?: Clock;
}

export class SubscriptionService {
  readonly #prisma: PrismaClient;
  readonly #clock: Clock;

  constructor(options: SubscriptionServiceOptions) {
    this.#prisma = options.prisma;
    this.#clock = options.clock ?? systemClock;
  }

  async get(workspaceId: string): Promise<SubscriptionView | null> {
    const row = await this.#prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    return row ? toView(row) : null;
  }

  /**
   * Has this workspace ever had a trial?
   *
   * AC-04.11. Asked of the subscription rather than of the workspace status,
   * because a status moves on and this must not.
   */
  async hasEverTrialed(workspaceId: string): Promise<boolean> {
    const row = await this.#prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { trialStartedAt: true },
    });
    return row?.trialStartedAt !== null && row?.trialStartedAt !== undefined;
  }

  /**
   * Start a trial. Once per workspace, ever.
   *
   * Returns the credits the trial grants, so the caller can make the grant in
   * its own transaction with its own idempotency key — this service does not
   * reach into the wallet.
   */
  async startTrial(
    workspaceId: string,
    terms: PlanTerms,
    billingInterval: 'MONTH' | 'YEAR' = 'MONTH',
  ): Promise<{ readonly subscription: SubscriptionView; readonly trialCredits: number }> {
    if (terms.trialDays <= 0) {
      throw new AppError('VALIDATION_FAILED', 'That plan does not offer a trial.');
    }
    if (await this.hasEverTrialed(workspaceId)) {
      // Deliberately a CONFLICT and not a silent second trial. D-09: one trial
      // per workspace, abuse-checked.
      throw new AppError(
        'CONFLICT',
        'This workspace has already used its trial. A workspace gets one.',
      );
    }

    const now = this.#clock.now();
    const trialEndsAt = new Date(now.getTime() + terms.trialDays * 86_400_000);

    const row = await this.#prisma.workspaceSubscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        planKey: terms.planKey,
        status: 'TRIALING',
        billingInterval,
        ...pinnedFrom(terms),
        currentPeriodStart: now,
        // The trial IS the first period, so the cycle boundary and the trial
        // end are the same instant. Anything else grants a monthly allowance
        // in the middle of a trial that already granted its own.
        currentPeriodEnd: trialEndsAt,
        trialStartedAt: now,
        trialEndsAt,
      },
      update: {
        planKey: terms.planKey,
        status: 'TRIALING',
        billingInterval,
        ...pinnedFrom(terms),
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
        trialStartedAt: now,
        trialEndsAt,
      },
    });

    return { subscription: toView(row), trialCredits: terms.trialCredits };
  }

  /**
   * Assign or change the plan, pinning the price that was agreed.
   *
   * `direction` is derived from the plan tiers rather than passed in, so a
   * caller cannot mislabel a downgrade as an upgrade and skip the period-end
   * rule with it.
   *
   *   upgrade   applies now (docs/BILLING-AND-CREDITS.md §3.2)
   *   downgrade is SCHEDULED for period end (§3.3, D-12). Nothing is removed
   *             at request time, and nothing is ever deleted.
   */
  async changePlan(input: {
    readonly workspaceId: string;
    readonly terms: PlanTerms;
    readonly currentTier: number;
    readonly downgradeTiming: 'immediate' | 'period_end';
  }): Promise<SubscriptionView> {
    const now = this.#clock.now();
    const existing = await this.#prisma.workspaceSubscription.findUnique({
      where: { workspaceId: input.workspaceId },
    });

    if (!existing) {
      const created = await this.#prisma.workspaceSubscription.create({
        data: {
          workspaceId: input.workspaceId,
          planKey: input.terms.planKey,
          status: 'ACTIVE',
          billingInterval: 'MONTH',
          ...pinnedFrom(input.terms),
          currentPeriodStart: now,
          currentPeriodEnd: addMonthsClamped(now, 1),
        },
      });
      return toView(created);
    }

    const isDowngrade = input.terms.tier < input.currentTier;

    if (isDowngrade && input.downgradeTiming === 'period_end') {
      // Recorded, not applied. The customer keeps everything they have until
      // the period ends, which is what "nothing is deleted automatically" means
      // in practice.
      const updated = await this.#prisma.workspaceSubscription.update({
        where: { workspaceId: input.workspaceId },
        data: {
          pendingPlanKey: input.terms.planKey,
          pendingPlanEffectiveAt: existing.currentPeriodEnd,
        },
      });
      return toView(updated);
    }

    const updated = await this.#prisma.workspaceSubscription.update({
      where: { workspaceId: input.workspaceId },
      data: {
        planKey: input.terms.planKey,
        ...pinnedFrom(input.terms),
        status: existing.status === 'TRIALING' ? 'TRIALING' : 'ACTIVE',
        pendingPlanKey: null,
        pendingPlanEffectiveAt: null,
      },
    });
    return toView(updated);
  }

  /**
   * Move the cycle forward, applying any scheduled downgrade.
   *
   * Returns the plan key now in force, which the caller needs in order to grant
   * the right allowance for the new period.
   */
  async advanceCycle(workspaceId: string, nextTerms: PlanTerms | null): Promise<SubscriptionView> {
    const existing = await this.#prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');

    const start = existing.currentPeriodEnd;
    const end =
      existing.billingInterval === 'YEAR'
        ? addMonthsClamped(start, 12)
        : addMonthsClamped(start, 1);

    const applyPending = existing.pendingPlanKey !== null && nextTerms !== null;

    const updated = await this.#prisma.workspaceSubscription.update({
      where: { workspaceId },
      data: {
        currentPeriodStart: start,
        currentPeriodEnd: end,
        // A trial that reaches its boundary without payment expires. It does
        // not silently become a paid subscription.
        status: existing.status === 'TRIALING' ? 'EXPIRED' : existing.status,
        ...(applyPending && nextTerms
          ? {
              planKey: nextTerms.planKey,
              ...pinnedFrom(nextTerms),
              pendingPlanKey: null,
              pendingPlanEffectiveAt: null,
            }
          : {}),
      },
    });
    return toView(updated);
  }

  /** Subscriptions whose period has ended — the cycle sweep's input. */
  async dueForCycle(limit = 200): Promise<ReadonlyArray<{ workspaceId: string; planKey: string }>> {
    const rows = await this.#prisma.workspaceSubscription.findMany({
      where: {
        currentPeriodEnd: { lte: this.#clock.now() },
        status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
      select: { workspaceId: true, planKey: true },
      take: limit,
    });
    return rows;
  }
}

function pinnedFrom(terms: PlanTerms): {
  currency: string;
  pinnedMonthlyMinor: number;
  pinnedAnnualMinor: number;
  pinnedMonthlyCredits: number;
  pinnedFromVersionId: string | null;
} {
  return {
    currency: terms.pricing.currency.toUpperCase(),
    pinnedMonthlyMinor: terms.pricing.monthlyMinor,
    pinnedAnnualMinor: terms.pricing.annualMinor,
    pinnedMonthlyCredits: terms.monthlyCredits,
    pinnedFromVersionId: terms.sourceVersionId,
  };
}

function toView(row: {
  workspaceId: string;
  planKey: string;
  status: string;
  billingInterval: string;
  currency: string;
  pinnedMonthlyMinor: number;
  pinnedAnnualMinor: number;
  pinnedMonthlyCredits: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  pendingPlanKey: string | null;
  pendingPlanEffectiveAt: Date | null;
  cancelAtPeriodEnd: boolean;
}): SubscriptionView {
  return {
    workspaceId: row.workspaceId,
    planKey: row.planKey,
    status: row.status as SubscriptionView['status'],
    billingInterval: row.billingInterval as SubscriptionView['billingInterval'],
    currency: row.currency,
    pinnedMonthlyMinor: row.pinnedMonthlyMinor,
    pinnedAnnualMinor: row.pinnedAnnualMinor,
    pinnedMonthlyCredits: row.pinnedMonthlyCredits,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialStartedAt: row.trialStartedAt,
    trialEndsAt: row.trialEndsAt,
    pendingPlanKey: row.pendingPlanKey,
    pendingPlanEffectiveAt: row.pendingPlanEffectiveAt,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
  };
}
