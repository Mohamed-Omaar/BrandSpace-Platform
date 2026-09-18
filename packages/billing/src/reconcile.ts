/**
 * The webhook inbox and the reconciler — where a payment becomes a fact (§28).
 *
 * THE ORDER OF OPERATIONS IS THE SECURITY PROPERTY:
 *
 *   1. VERIFY THE SIGNATURE OVER THE RAW BYTES, before parsing. Parsing first
 *      and verifying the re-serialized result verifies a different document from
 *      the one that was signed.
 *   2. A FAILED VERIFICATION WRITES NOTHING AT ALL. Not a row, not an audit
 *      event, not a counter. An unauthenticated caller must not be able to make
 *      us store anything they chose — and "we log every rejected event" is how a
 *      table becomes an attacker's storage.
 *   3. RECORD BEFORE APPLYING. The event lands in `billing_event` with the
 *      provider's own id as a unique key, so a replay collides and is recorded
 *      as a DUPLICATE that changes nothing.
 *   4. RESOLVE THE WORKSPACE FROM A RELATIONSHIP WE WROTE — `billing_profile`,
 *      `checkout_session`, `workspace_subscription`, `invoice` — never from the
 *      event body. An event that cannot be tied to one of those is UNRESOLVED:
 *      kept, visible, and applied to nothing. Guessing would be worse than
 *      losing it.
 *   5. COMPARE THE PROVIDER'S TIMESTAMP AGAINST THE STATE IT DESCRIBES. An
 *      event older than what we already applied is STALE: recorded, deliberately
 *      not applied, so an out-of-order delivery cannot wind a subscription
 *      backwards.
 *   6. COMPARE THE AMOUNT AGAINST OUR OWN ROW. A provider event whose amount or
 *      currency does not match what we priced is a FAILURE, not a payment
 *      (§37) — the whole point of having written the amount down first.
 *
 * AND THE ONE THAT UNDERPINS ALL OF IT: NOTHING IS MARKED PAID ANYWHERE ELSE.
 * The browser's success redirect is navigation. `commerce.checkout
 * .trustBrowserRedirect` is the literal `false` so this cannot be configured
 * away (§22).
 */

import type { Prisma, TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { PlanDetail } from '@brandspace/entitlements';
import { findPlan, termsFor } from '@brandspace/entitlements';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import type { NormalizedBillingEvent, ProviderRegistry } from './adapter';
import { taxPolicyFor, type CommercePolicy, type LocalizedText } from './commerce';
import { InvoiceService, type InvoiceLineInput } from './invoices';
import type { TaxAssessment } from './tax';
import { nextDunningStep, normaliseFailureCode } from './dunning';

export type EventOutcome = 'PROCESSED' | 'DUPLICATE' | 'STALE' | 'UNRESOLVED' | 'FAILED';

export interface DeliveryRejected {
  readonly accepted: false;
  /** Safe to log and to return. Never the signature, the body or the secret. */
  readonly reason: string;
}

export interface DeliveryAccepted {
  readonly accepted: true;
  readonly results: readonly EventResult[];
}

export interface EventResult {
  readonly billingEventId: string;
  readonly externalEventId: string;
  readonly type: string;
  readonly outcome: EventOutcome;
  readonly workspaceId: string | null;
  readonly failureReason: string | null;
}

export type DeliveryResult = DeliveryAccepted | DeliveryRejected;

/**
 * Granting prepaid credits, as a port.
 *
 * WHY A PORT AND NOT A DIRECT CALL. The ledger is Phase 3's and stays Phase 3's
 * (§1 — do not duplicate the credit ledger). This package needs exactly one
 * thing from it: "grant these credits, once, inside the transaction I am already
 * in". Handing over the whole service would let billing reach into the wallet;
 * handing over one function does not.
 */
export interface CreditGrantPort {
  grantPackCredits(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly credits: number;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly expiresAt: Date | null;
    },
  ): Promise<string>;
}

export interface ReconcilerOptions {
  readonly providers: ProviderRegistry;
  readonly credits: CreditGrantPort;
  readonly clock?: Clock;
}

export interface ReceiveInput {
  readonly providerKey: string;
  /** The UNPARSED body, exactly as it arrived. */
  readonly raw: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly policy: CommercePolicy;
  readonly plans: readonly PlanDetail[];
  readonly planVersionId: string | null;
}

export class BillingReconciler {
  readonly #providers: ProviderRegistry;
  readonly #credits: CreditGrantPort;
  readonly #clock: Clock;
  readonly #invoices: InvoiceService;

  constructor(options: ReconcilerOptions) {
    this.#providers = options.providers;
    this.#credits = options.credits;
    this.#clock = options.clock ?? systemClock;
    this.#invoices = new InvoiceService({ clock: this.#clock });
  }

  /**
   * Receive one delivery.
   *
   * `db` MUST BE A PLATFORM-SCOPED CLIENT. The inbox is platform-owned, the
   * workspace is not known until it is resolved, and invoice numbering is
   * refused to the tenant role. This is not a convenience: an event arrives
   * before anyone knows whose it is, so there is no tenant context to run it in.
   */
  async receive(db: TenantScopedClient, input: ReceiveInput): Promise<DeliveryResult> {
    const provider = this.#providers.get(input.providerKey);
    if (!provider) {
      return { accepted: false, reason: 'unknown_provider' };
    }

    const verification = provider.verifyWebhook(input.raw, input.headers);
    if (!verification.valid) {
      // NOTHING IS WRITTEN. See the header — an unverified caller cannot make us
      // store a row of their choosing.
      return { accepted: false, reason: verification.reason ?? 'invalid_signature' };
    }

    let events: readonly NormalizedBillingEvent[];
    try {
      events = provider.parseWebhook(input.raw);
    } catch {
      // Verified but unintelligible. Refused rather than recorded, because a
      // shape we cannot normalize is a shape we cannot reconcile.
      return { accepted: false, reason: 'unparseable_event' };
    }

    const results: EventResult[] = [];
    for (const event of events) {
      results.push(await this.#ingest(db, input, event));
    }
    return { accepted: true, results };
  }

  // ---------------------------------------------------------------------------

  async #ingest(
    db: TenantScopedClient,
    input: ReceiveInput,
    event: NormalizedBillingEvent,
  ): Promise<EventResult> {
    const existing = await db.billingEvent.findUnique({
      where: {
        providerKey_externalEventId: {
          providerKey: input.providerKey,
          externalEventId: event.externalEventId,
        },
      },
      select: { id: true, status: true, resolvedWorkspaceId: true },
    });
    if (existing) {
      // A REPLAY CHANGES NOTHING. Not the state, and not the record of what the
      // first delivery did — the row keeps its original status.
      return {
        billingEventId: existing.id,
        externalEventId: event.externalEventId,
        type: event.type,
        outcome: 'DUPLICATE',
        workspaceId: existing.resolvedWorkspaceId,
        failureReason: null,
      };
    }

    const row = await db.billingEvent.create({
      data: {
        providerKey: input.providerKey,
        externalEventId: event.externalEventId,
        eventType: event.type,
        occurredAt: event.occurredAt,
        signatureVerified: true,
        payload: serialisePayload(event),
        status: 'RECEIVED',
        attempts: 1,
      },
    });

    const workspaceId = await this.#resolveWorkspace(db, input.providerKey, event);
    if (!workspaceId) {
      await db.billingEvent.update({
        where: { id: row.id },
        data: {
          status: 'UNRESOLVED',
          failureReason: 'no_trusted_mapping',
          processedAt: this.#clock.now(),
        },
      });
      return {
        billingEventId: row.id,
        externalEventId: event.externalEventId,
        type: event.type,
        outcome: 'UNRESOLVED',
        workspaceId: null,
        failureReason: 'no_trusted_mapping',
      };
    }

    let outcome: EventOutcome = 'PROCESSED';
    let failureReason: string | null = null;
    try {
      outcome = await this.#apply(db, input, event, workspaceId, row.id);
    } catch (error: unknown) {
      outcome = 'FAILED';
      failureReason = error instanceof AppError ? error.code : 'apply_failed';
    }

    await db.billingEvent.update({
      where: { id: row.id },
      data: {
        status: outcome === 'PROCESSED' ? 'PROCESSED' : outcome,
        resolvedWorkspaceId: workspaceId,
        failureReason,
        processedAt: this.#clock.now(),
      },
    });

    return {
      billingEventId: row.id,
      externalEventId: event.externalEventId,
      type: event.type,
      outcome,
      workspaceId,
      failureReason,
    };
  }

  /**
   * Find the workspace through a relationship WE wrote.
   *
   * FOUR TRUSTED MAPPINGS, tried in order of how directly we own them. Not one
   * of them reads a workspace id out of the event: `NormalizedBillingEvent` has
   * no such field, so there is nothing here for a future maintainer to reach
   * for even by accident.
   */
  async #resolveWorkspace(
    db: TenantScopedClient,
    providerKey: string,
    event: NormalizedBillingEvent,
  ): Promise<string | null> {
    if (event.providerCustomerId) {
      const profile = await db.billingProfile.findFirst({
        where: { providerKey, providerCustomerId: event.providerCustomerId },
        select: { workspaceId: true },
      });
      if (profile) return profile.workspaceId;
    }
    if (event.providerSessionId) {
      const session = await db.checkoutSession.findFirst({
        where: { providerKey, providerSessionId: event.providerSessionId },
        select: { workspaceId: true },
      });
      if (session) return session.workspaceId;
    }
    if (event.providerSubscriptionId) {
      const subscription = await db.workspaceSubscription.findFirst({
        where: { providerKey, providerSubscriptionId: event.providerSubscriptionId },
        select: { workspaceId: true },
      });
      if (subscription) return subscription.workspaceId;
    }
    if (event.providerInvoiceId) {
      const invoice = await db.invoice.findFirst({
        where: { providerKey, providerInvoiceId: event.providerInvoiceId },
        select: { workspaceId: true },
      });
      if (invoice) return invoice.workspaceId;
    }
    return null;
  }

  async #apply(
    db: TenantScopedClient,
    input: ReceiveInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    switch (event.type) {
      case 'checkout.completed':
        return this.#applyCheckoutCompleted(db, input, event, workspaceId, billingEventId);
      case 'checkout.cancelled':
        return this.#applyCheckoutCancelled(db, event, workspaceId);
      case 'invoice.paid':
        return this.#applyInvoicePaid(db, event, workspaceId, billingEventId);
      case 'invoice.payment_failed':
        return this.#applyPaymentFailed(db, input, event, workspaceId, billingEventId);
      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.cancelled':
        return this.#applySubscriptionEvent(db, event, workspaceId, billingEventId);
      case 'charge.refunded':
        // Recorded, not acted on. A refund BrandSpace initiated already has its
        // credit note; one initiated at the provider is an operator's business
        // and must not silently rewrite our documents.
        return 'PROCESSED';
      default:
        return 'FAILED';
    }
  }

  /**
   * The money path. A checkout the provider says is paid.
   *
   * THE SESSION IS LOOKED UP BY (workspaceId, id), never by the id alone. The
   * workspace came from a mapping we wrote; the id came from the event. Pairing
   * them means a forged id belonging to another tenant resolves to nothing —
   * indistinguishable from an id that never existed.
   */
  async #applyCheckoutCompleted(
    db: TenantScopedClient,
    input: ReceiveInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const session = event.checkoutSessionId
      ? await db.checkoutSession.findFirst({
          where: { workspaceId, id: event.checkoutSessionId },
        })
      : event.providerSessionId
        ? await db.checkoutSession.findFirst({
            where: { workspaceId, providerSessionId: event.providerSessionId },
          })
        : null;

    if (!session) return 'UNRESOLVED';

    if (session.status === 'COMPLETED') {
      // Already reconciled. Not an error, and nothing to do twice.
      return 'DUPLICATE';
    }

    // THE AMOUNT CHECK (§37). What the provider says moved must be what we
    // priced. A mismatch is never "close enough".
    if (
      event.amountMinor === null ||
      event.amountMinor !== session.totalMinor ||
      (event.currency ?? '').toUpperCase() !== session.currency.toUpperCase()
    ) {
      await writeAuditEvent(db, workspaceId, {
        action: 'billing.reconcile.amount-mismatch',
        actorType: 'SYSTEM',
        resourceType: 'CheckoutSession',
        resourceId: session.id,
        severity: 'CRITICAL',
        outcome: 'ERROR',
        reason: 'The provider amount does not match the agreed amount.',
        after: {
          expectedMinor: session.totalMinor.toString(),
          expectedCurrency: session.currency,
          reportedMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
          reportedCurrency: event.currency,
        },
      });
      throw new AppError('CONFLICT', 'The provider amount does not match the agreed amount.');
    }

    const now = this.#clock.now();
    const completed = await db.checkoutSession.updateMany({
      where: { workspaceId, id: session.id, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (completed.count === 0) {
      // Another delivery won the race and is completing it. Ours changes nothing.
      return 'DUPLICATE';
    }

    const assessment = await this.#assessmentOf(db, input.policy, workspaceId, session);

    if (session.purpose === 'SUBSCRIPTION') {
      await this.#settleSubscription(db, input, {
        workspaceId,
        session,
        assessment,
        event,
        billingEventId,
        now,
      });
    } else {
      await this.#settleCreditPack(db, input, {
        workspaceId,
        session,
        assessment,
        event,
        now,
      });
    }

    return 'PROCESSED';
  }

  /**
   * The tax treatment to RECORD on the invoice for a settled checkout.
   *
   * THE AMOUNTS COME FROM THE CHECKOUT ROW, NEVER FROM RE-PRICING. What the
   * customer agreed to is what we invoice, even if the catalogue moved between
   * the redirect and the payment — that is the entire reason the amount was
   * written down before the provider was called (§25).
   *
   * Only the MODE, the RATE and the POLICY KEY are read from configuration, so
   * the document can explain which rule produced a tax figure it does not
   * recompute. When the agreed tax is zero the mode is NONE regardless, because
   * a rate that charged nothing did not apply.
   */
  async #assessmentOf(
    db: TenantScopedClient,
    policy: CommercePolicy,
    workspaceId: string,
    session: CheckoutRow,
  ): Promise<TaxAssessment> {
    const profile = await db.billingProfile.findFirst({
      where: { workspaceId },
      select: { country: true },
    });
    const taxPolicy = profile ? taxPolicyFor(policy, profile.country) : null;
    const money = (minor: bigint): Money =>
      Money.ofMinor(session.currency, minor, session.currencyScale);

    const zeroTax = session.taxMinor === 0n;
    return {
      mode: zeroTax ? 'NONE' : taxPolicy?.mode === 'inclusive' ? 'INCLUSIVE' : 'EXCLUSIVE',
      rateBasisPoints: zeroTax ? 0 : (taxPolicy?.rateBasisPoints ?? 0),
      policyKey: taxPolicy?.key ?? null,
      subtotal: money(session.amountMinor),
      tax: money(session.taxMinor),
      total: money(session.totalMinor),
    };
  }

  async #settleSubscription(
    db: TenantScopedClient,
    input: ReceiveInput,
    args: {
      readonly workspaceId: string;
      readonly session: CheckoutRow;
      readonly assessment: TaxAssessment;
      readonly event: NormalizedBillingEvent;
      readonly billingEventId: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const { workspaceId, session, now } = args;
    const plan = findPlan(input.plans, session.planKey);
    if (!plan) {
      throw new AppError('CONFLICT', 'The plan this checkout bought no longer exists.');
    }
    const terms = termsFor(plan, session.currency, input.planVersionId);
    if (!terms) {
      throw new AppError('CONFLICT', 'That plan has no price in the currency it was bought in.');
    }

    const line: InvoiceLineInput = {
      kind: 'SUBSCRIPTION',
      description: {
        ar: plan.nameAr,
        en: plan.nameEn,
      } satisfies LocalizedText,
      quantity: 1,
      unitAmount: args.assessment.subtotal,
      amount: args.assessment.subtotal,
      tax: args.assessment.tax,
      metadata: { planKey: plan.key, billingInterval: session.billingInterval },
    };

    const periodEnd = session.billingInterval === 'YEAR' ? addMonths(now, 12) : addMonths(now, 1);

    const draft = await this.#invoices.draft(db, {
      workspaceId,
      assessment: args.assessment,
      lines: [line],
      checkoutSessionId: session.id,
      periodStart: now,
      periodEnd,
      providerKey: session.providerKey,
      commercialSnapshot: {
        planKey: plan.key,
        billingInterval: session.billingInterval,
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.amountMinor.toString(),
        planVersionId: session.planVersionId,
        commerceVersionId: session.commerceVersionId,
      },
    });
    const issued = await this.#invoices.issue(db, {
      workspaceId,
      invoiceId: draft.id,
      policy: input.policy,
    });
    await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: issued.id,
      providerPaymentId: args.event.providerPaymentId,
      paidAt: now,
    });

    await db.paymentAttempt.create({
      data: {
        workspaceId,
        invoiceId: issued.id,
        checkoutSessionId: session.id,
        status: 'SUCCEEDED',
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.totalMinor,
        providerPaymentId: args.event.providerPaymentId,
        idempotencyKey: `attempt:${args.event.externalEventId}`,
        settledAt: now,
      },
    });

    /*
     * THE SUBSCRIPTION MOVES TO ACTIVE AND PINS ITS PRICE.
     *
     * Pinned, not read live (AC-04.7): a later catalogue edit changes what NEW
     * customers are offered and nothing about this one. The dunning clock is
     * cleared in the same write — a collected payment ends the episode.
     */
    await db.workspaceSubscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        planKey: plan.key,
        status: 'ACTIVE',
        billingInterval: session.billingInterval ?? 'MONTH',
        currency: terms.pricing.currency.toUpperCase(),
        pinnedMonthlyMinor: terms.pricing.monthlyMinor,
        pinnedAnnualMinor: terms.pricing.annualMinor,
        pinnedMonthlyCredits: terms.monthlyCredits,
        pinnedFromVersionId: terms.sourceVersionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        providerKey: session.providerKey,
        providerSubscriptionId: args.event.providerSubscriptionId,
        lastEventAt: args.event.occurredAt,
        lastBillingEventId: args.billingEventId,
      },
      update: {
        planKey: plan.key,
        status: 'ACTIVE',
        billingInterval: session.billingInterval ?? 'MONTH',
        currency: terms.pricing.currency.toUpperCase(),
        pinnedMonthlyMinor: terms.pricing.monthlyMinor,
        pinnedAnnualMinor: terms.pricing.annualMinor,
        pinnedMonthlyCredits: terms.monthlyCredits,
        pinnedFromVersionId: terms.sourceVersionId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        providerKey: session.providerKey,
        providerSubscriptionId: args.event.providerSubscriptionId,
        pendingCheckoutSessionId: null,
        pastDueSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        lastEventAt: args.event.occurredAt,
        lastBillingEventId: args.billingEventId,
      },
    });

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.subscription.activated',
      actorType: 'SYSTEM',
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
      after: { planKey: plan.key, invoice: issued.number },
    });
  }

  /**
   * A prepaid pack. Paid once, granted once.
   *
   * THE GRANT AND THE PURCHASE COMMIT TOGETHER, and `creditGrantId` is unique
   * with a CHECK that a COMPLETED purchase must name one. So "the webhook ran
   * twice and the customer got double credits" is refused by the database, not
   * only by the idempotency check above it.
   */
  async #settleCreditPack(
    db: TenantScopedClient,
    input: ReceiveInput,
    args: {
      readonly workspaceId: string;
      readonly session: CheckoutRow;
      readonly assessment: TaxAssessment;
      readonly event: NormalizedBillingEvent;
      readonly now: Date;
    },
  ): Promise<void> {
    const { workspaceId, session, now } = args;
    const pack = input.policy.creditPacks.find((p) => p.key === session.packKey);
    if (!pack) {
      throw new AppError('CONFLICT', 'The credit pack this checkout bought no longer exists.');
    }

    const existing = await db.creditPackPurchase.findFirst({
      where: { workspaceId, checkoutSessionId: session.id },
    });
    if (existing?.status === 'COMPLETED') return;

    const line: InvoiceLineInput = {
      kind: 'CREDIT_PACK',
      description: { ar: pack.name.ar, en: pack.name.en },
      quantity: 1,
      unitAmount: args.assessment.subtotal,
      amount: args.assessment.subtotal,
      tax: args.assessment.tax,
      metadata: { packKey: pack.key, credits: pack.credits },
    };

    const draft = await this.#invoices.draft(db, {
      workspaceId,
      assessment: args.assessment,
      lines: [line],
      checkoutSessionId: session.id,
      providerKey: session.providerKey,
      commercialSnapshot: {
        packKey: pack.key,
        credits: pack.credits,
        currency: session.currency,
        currencyScale: session.currencyScale,
        amountMinor: session.amountMinor.toString(),
        commerceVersionId: session.commerceVersionId,
      },
    });
    const issued = await this.#invoices.issue(db, {
      workspaceId,
      invoiceId: draft.id,
      policy: input.policy,
    });
    await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: issued.id,
      providerPaymentId: args.event.providerPaymentId,
      paidAt: now,
    });

    const grantId = await this.#credits.grantPackCredits(db, {
      workspaceId,
      credits: pack.credits,
      reason: `Credit pack ${pack.key}`,
      // KEYED ON THE CHECKOUT, not on the event: two different provider events
      // about the same purchase must not grant twice.
      idempotencyKey: `pack:${session.id}`,
      expiresAt: pack.expiryDays ? new Date(now.getTime() + pack.expiryDays * 86_400_000) : null,
    });

    const purchaseData = {
      packKey: pack.key,
      credits: pack.credits,
      currency: session.currency,
      currencyScale: session.currencyScale,
      amountMinor: session.totalMinor,
      status: 'COMPLETED' as const,
      invoiceId: issued.id,
      creditGrantId: grantId,
      providerPaymentId: args.event.providerPaymentId,
      completedAt: now,
    };

    if (existing) {
      await db.creditPackPurchase.update({ where: { id: existing.id }, data: purchaseData });
    } else {
      await db.creditPackPurchase.create({
        data: { workspaceId, checkoutSessionId: session.id, ...purchaseData },
      });
    }

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.credit-pack.purchased',
      actorType: 'SYSTEM',
      resourceType: 'CreditPackPurchase',
      resourceId: session.id,
      after: { packKey: pack.key, credits: pack.credits, invoice: issued.number },
    });
  }

  async #applyCheckoutCancelled(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
  ): Promise<EventOutcome> {
    if (!event.providerSessionId && !event.checkoutSessionId) return 'UNRESOLVED';
    const { count } = await db.checkoutSession.updateMany({
      where: {
        workspaceId,
        status: 'PENDING',
        ...(event.checkoutSessionId
          ? { id: event.checkoutSessionId }
          : { providerSessionId: event.providerSessionId }),
      },
      data: { status: 'CANCELLED', cancelledAt: this.#clock.now() },
    });
    return count > 0 ? 'PROCESSED' : 'DUPLICATE';
  }

  async #applyInvoicePaid(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    if (!event.providerInvoiceId) return 'UNRESOLVED';
    const invoice = await db.invoice.findFirst({
      where: { workspaceId, providerInvoiceId: event.providerInvoiceId },
      select: { id: true, status: true, totalMinor: true, currency: true },
    });
    if (!invoice) return 'UNRESOLVED';
    if (invoice.status === 'PAID') return 'DUPLICATE';

    if (
      event.amountMinor === null ||
      event.amountMinor !== invoice.totalMinor ||
      (event.currency ?? '').toUpperCase() !== invoice.currency.toUpperCase()
    ) {
      throw new AppError('CONFLICT', 'The provider amount does not match the invoice.');
    }

    const paid = await this.#invoices.markPaid(db, {
      workspaceId,
      invoiceId: invoice.id,
      providerPaymentId: event.providerPaymentId,
      paidAt: event.occurredAt,
    });
    if (!paid) return 'DUPLICATE';

    // Collection succeeded: the dunning episode is over.
    await db.workspaceSubscription.updateMany({
      where: { workspaceId },
      data: {
        status: 'ACTIVE',
        pastDueSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });
    return 'PROCESSED';
  }

  /**
   * Collection failed.
   *
   * THE CLOCK STARTS AT THE FIRST FAILURE AND IS NOT RESTARTED. `pastDueSince`
   * is written only when it is null, so a second failure inside the same episode
   * cannot extend the customer's grace period — nor shorten it.
   */
  async #applyPaymentFailed(
    db: TenantScopedClient,
    input: ReceiveInput,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const subscription = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!subscription) return 'UNRESOLVED';

    const invoice = event.providerInvoiceId
      ? await db.invoice.findFirst({
          where: { workspaceId, providerInvoiceId: event.providerInvoiceId },
          select: { id: true, currency: true, currencyScale: true, totalMinor: true },
        })
      : null;

    const firstFailedAt = subscription.pastDueSince ?? event.occurredAt;
    const attemptsMade =
      (await db.paymentAttempt.count({
        where: { workspaceId, status: 'FAILED', attemptedAt: { gte: firstFailedAt } },
      })) + 1;

    const step = nextDunningStep({
      policy: input.policy.dunning,
      firstFailedAt,
      attemptsMade,
      now: this.#clock.now(),
    });

    await db.paymentAttempt.create({
      data: {
        workspaceId,
        invoiceId: invoice?.id ?? null,
        status: 'FAILED',
        currency: invoice?.currency ?? subscription.currency,
        currencyScale: invoice?.currencyScale ?? 2,
        amountMinor: invoice?.totalMinor ?? 0n,
        failureCode: normaliseFailureCode(event.failureCode),
        attemptNumber: attemptsMade,
        providerPaymentId: event.providerPaymentId,
        idempotencyKey: `attempt:${event.externalEventId}`,
        settledAt: event.occurredAt,
        nextRetryAt: step.kind === 'retry' ? step.at : null,
      },
    });

    const graceEndsAt =
      step.kind === 'retry' || step.kind === 'grace'
        ? new Date(firstFailedAt.getTime() + input.policy.dunning.graceDays * 86_400_000)
        : subscription.graceEndsAt;

    await db.workspaceSubscription.update({
      where: { workspaceId },
      data: {
        status: step.kind === 'suspend' ? 'SUSPENDED' : 'PAST_DUE',
        pastDueSince: subscription.pastDueSince ?? event.occurredAt,
        graceEndsAt,
        suspendedAt: step.kind === 'suspend' ? this.#clock.now() : subscription.suspendedAt,
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });

    await writeAuditEvent(db, workspaceId, {
      action: 'billing.payment.failed',
      actorType: 'SYSTEM',
      resourceType: 'WorkspaceSubscription',
      resourceId: workspaceId,
      severity: 'WARNING',
      outcome: 'ERROR',
      reason: normaliseFailureCode(event.failureCode),
      after: { step: step.kind, attemptNumber: attemptsMade },
    });

    return 'PROCESSED';
  }

  /**
   * A subscription's own lifecycle, as the provider sees it.
   *
   * STALENESS IS DECIDED HERE. `lastEventAt` holds the provider's timestamp for
   * the last event we applied; an older one is recorded and refused, because
   * applying it would replace newer truth with older truth — the classic
   * out-of-order webhook bug.
   */
  async #applySubscriptionEvent(
    db: TenantScopedClient,
    event: NormalizedBillingEvent,
    workspaceId: string,
    billingEventId: string,
  ): Promise<EventOutcome> {
    const subscription = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!subscription) return 'UNRESOLVED';

    if (subscription.lastEventAt && event.occurredAt <= subscription.lastEventAt) {
      return 'STALE';
    }

    const cancelled = event.type === 'subscription.cancelled';
    await db.workspaceSubscription.update({
      where: { workspaceId },
      data: {
        providerSubscriptionId: event.providerSubscriptionId ?? subscription.providerSubscriptionId,
        ...(event.cancelAtPeriodEnd !== null ? { cancelAtPeriodEnd: event.cancelAtPeriodEnd } : {}),
        ...(event.periodStart ? { currentPeriodStart: event.periodStart } : {}),
        ...(event.periodEnd ? { currentPeriodEnd: event.periodEnd } : {}),
        ...(cancelled ? { status: 'CANCELLED' as const, cancelledAt: event.occurredAt } : {}),
        lastEventAt: event.occurredAt,
        lastBillingEventId: billingEventId,
      },
    });
    return 'PROCESSED';
  }
}

interface CheckoutRow {
  id: string;
  workspaceId: string;
  purpose: string;
  status: string;
  planKey: string | null;
  billingInterval: 'MONTH' | 'YEAR' | null;
  packKey: string | null;
  currency: string;
  currencyScale: number;
  amountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  planVersionId: string | null;
  commerceVersionId: string | null;
  providerKey: string;
  providerSessionId: string | null;
}

function addMonths(from: Date, months: number): Date {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/**
 * What gets stored in `billing_event.payload`.
 *
 * NORMALIZED, NOT RAW. The provider's own body may carry fields we have no use
 * for and no right to keep; this is the subset reconciliation reads. `bigint`
 * becomes a decimal string because JSON has no integer wide enough to be trusted
 * with money.
 */
function serialisePayload(event: NormalizedBillingEvent): Prisma.InputJsonValue {
  return {
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    providerCustomerId: event.providerCustomerId,
    providerSubscriptionId: event.providerSubscriptionId,
    providerSessionId: event.providerSessionId,
    providerPaymentId: event.providerPaymentId,
    providerInvoiceId: event.providerInvoiceId,
    amountMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
    currency: event.currency,
    checkoutSessionId: event.checkoutSessionId,
    failureCode: event.failureCode,
    cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    periodStart: event.periodStart?.toISOString() ?? null,
    periodEnd: event.periodEnd?.toISOString() ?? null,
  } satisfies Prisma.InputJsonValue;
}
