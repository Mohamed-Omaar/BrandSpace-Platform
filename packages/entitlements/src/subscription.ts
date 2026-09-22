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

/**
 * The client one period transition needs.
 *
 * A `PrismaClient` or a transaction of one — the same shape `LedgerTx` names in
 * the credit ledger, and for the same reason: the caller decides whether this
 * write shares a transaction with the allowance that belongs to it.
 */
export type SubscriptionTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

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
   * Move the cycle forward, applying any scheduled downgrade or cancellation.
   *
   * Returns the subscription as it stands after the boundary, which the caller
   * needs in order to grant the right allowance for the new period — and to
   * know whether there is a new period at all.
   *
   * THREE OUTCOMES, AND ONLY ONE OF THEM RENEWS.
   *
   *   - A TRIAL that reaches its boundary without payment EXPIRES. It does not
   *     silently become a paid subscription.
   *   - A subscription the customer asked to CANCEL at period end reaches that
   *     end here. `cancelAtPeriodEnd` used to be a flag nothing ever acted on:
   *     the customer was told access continued until the period end, and then
   *     the period rolled over for ever.
   *   - Everything else renews into the next period, applying any pending
   *     downgrade (docs/BILLING-AND-CREDITS.md §3.3).
   *
   * A TERMINAL OUTCOME LEAVES THE PERIOD WHERE IT IS, deliberately. The row
   * then says when access ended rather than claiming a period the customer
   * neither paid for nor holds, and `dueForCycle` stops offering it because it
   * filters on the serving statuses.
   *
   * IDEMPOTENT ON THE BOUNDARY ITSELF — the requirement a scheduled caller
   * makes of it. The write is conditional on the period end this call read, so
   * two ticks racing, or one tick retried, move the cycle EXACTLY ONCE: the
   * loser matches no row, re-reads, and returns the state the winner left. A
   * second advance is not a harmless repeat — it is a month of access and a
   * month of credits nobody paid for.
   */
  async advanceCycle(workspaceId: string, nextTerms: PlanTerms | null): Promise<SubscriptionView> {
    return this.advanceCycleWithin(this.#prisma, workspaceId, nextTerms);
  }

  /**
   * The body of `advanceCycle`, taking a transaction.
   *
   * SEPARATED SO THE PERIOD AND ITS ALLOWANCE COMMIT TOGETHER. The scheduler
   * moved the period in one transaction and granted the period's credits in
   * another; a failure between them left the period permanently advanced with
   * no allowance, and `dueForCycle` selects on the period end, so the workspace
   * stopped being due and nothing ever retried it. A month of credits was lost
   * silently, which is the worst shape a billing bug can take.
   *
   * Everything below already used the client it was handed; naming it in the
   * signature is what lets a caller hand it the same transaction the credit
   * reset runs in.
   */
  async advanceCycleWithin(
    db: SubscriptionTx,
    workspaceId: string,
    nextTerms: PlanTerms | null,
  ): Promise<SubscriptionView> {
    const existing = await db.workspaceSubscription.findUnique({
      where: { workspaceId },
    });
    if (!existing) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');

    const start = existing.currentPeriodEnd;
    const end =
      existing.billingInterval === 'YEAR'
        ? addMonthsClamped(start, 12)
        : addMonthsClamped(start, 1);

    const status = existing.cancelAtPeriodEnd
      ? 'CANCELLED'
      : existing.status === 'TRIALING'
        ? 'EXPIRED'
        : existing.status;
    const renews = status !== 'CANCELLED' && status !== 'EXPIRED';

    /*
     * A SCHEDULED CHANGE THAT CANNOT BE RESOLVED STOPS THE BOUNDARY.
     *
     * This read `nextTerms !== null` and, when the terms could not be resolved,
     * simply did not apply them — so a subscription with a scheduled downgrade
     * whose target plan had been removed from the catalogue, or which has no
     * price in the currency the customer is billed in, RENEWED FOR ANOTHER
     * PERIOD ON THE OLD PLAN, kept its unresolved `pendingPlanKey`, and
     * received the OLD plan's allowance. The boundary was consumed, the change
     * the customer asked for silently did not happen, and the more expensive
     * terms carried on being charged and granted.
     *
     * THERE IS NO CORRECT TERMS TO SUBSTITUTE, so this does not choose one.
     * Renewing the old plan is a commercial decision nobody made; applying a
     * plan with no price in this currency would be a conversion, which D-08
     * forbids at runtime. The boundary is REFUSED instead: the caller rolls
     * back, the period stays where it was, `dueForCycle` keeps offering the
     * workspace, and an operator who restores the plan, adds the price, or
     * withdraws the scheduled change gets the boundary applied by the next
     * sweep. Exactly the treatment an unresolvable CURRENT plan already gets.
     *
     * THE TERMS MUST ALSO BE THE TERMS OF THE PLAN THAT WAS SCHEDULED. A caller
     * handing over some other plan's terms would move the customer onto a plan
     * nobody scheduled, which is the same class of silent repricing.
     */
    if (renews && existing.pendingPlanKey !== null) {
      if (nextTerms === null) {
        throw new AppError(
          'CONFLICT',
          'The scheduled plan change cannot be resolved, so this boundary was not applied.',
        );
      }
      if (nextTerms.planKey !== existing.pendingPlanKey) {
        throw new AppError(
          'CONFLICT',
          'The terms offered for this boundary are not the scheduled plan’s.',
        );
      }
    }

    const applyPending = renews && existing.pendingPlanKey !== null && nextTerms !== null;

    await db.workspaceSubscription.updateMany({
      // THE PERIOD END THIS CALL READ. Any other value means somebody else
      // already crossed this boundary.
      where: { workspaceId, currentPeriodEnd: existing.currentPeriodEnd },
      data: {
        ...(renews ? { currentPeriodStart: start, currentPeriodEnd: end } : {}),
        status,
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

    /*
     * RE-READ, ALWAYS, AND RETURN THAT. Matching no row is not an error — a
     * duplicated tick is the normal cost of a sweep that is safe to run twice
     * — so the caller is told what is true NOW rather than what this call
     * intended. A grant keyed on the period it reads back therefore cannot be
     * made twice for one boundary.
     */
    const after = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!after) throw new AppError('NOT_FOUND', 'This workspace has no subscription.');
    return toView(after);
  }

  /**
   * Subscriptions whose period has ended — the cycle sweep's input.
   *
   * ORDERED BY THE BOUNDARY THEY ARE WAITING ON, oldest first, then by id to
   * break ties. `take` without an order is a bounded scan whose contents the
   * database is free to choose differently every pass, so a workspace whose
   * boundary keeps failing could sit behind others for ever while they were
   * re-offered — the starvation D-182 records for the analytics queue, in the
   * one sweep where the cost of never being reached is a month of credits.
   */
  async dueForCycle(limit = 200): Promise<ReadonlyArray<{ workspaceId: string; planKey: string }>> {
    const rows = await this.#prisma.workspaceSubscription.findMany({
      where: {
        currentPeriodEnd: { lte: this.#clock.now() },
        status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
      select: { workspaceId: true, planKey: true },
      orderBy: [{ currentPeriodEnd: 'asc' }, { workspaceId: 'asc' }],
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
