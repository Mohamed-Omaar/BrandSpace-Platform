/**
 * Opening a hosted checkout — the only way money starts moving.
 *
 * THE PRICE IS RESOLVED HERE AND NOWHERE ELSE. A request names a plan key and
 * an interval, or a pack key. It does NOT carry an amount, and there is no
 * parameter it could carry one in: the total is looked up from the activated
 * catalogue, taxed by the market's configured policy, and written onto our own
 * row BEFORE the provider is called. Reconciliation later compares what the
 * provider says moved against that row (§37), so a customer who edits a form
 * changes nothing at all.
 *
 * A REDIRECT IS NOT A PAYMENT. Nothing in this file marks anything paid. It
 * creates a PENDING session and hands back a URL; the session becomes COMPLETED
 * only when a signed provider event is verified and reconciled. `commerce`
 * carries `trustBrowserRedirect: false` as a literal so that this cannot be
 * configured away (§22).
 *
 * IDEMPOTENT BY CONSTRUCTION. A double-submitted form, a retried fetch and an
 * impatient customer all resolve to ONE session, because `(workspaceId,
 * idempotencyKey)` is unique in the database and a replay that matches returns
 * the original rather than opening a second one.
 */

import type { TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { PlanDetail } from '@brandspace/entitlements';
import { priceIn } from '@brandspace/entitlements';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import type { PaymentProviderAdapter, ProviderRegistry } from './adapter';
import {
  findCurrency,
  planAvailability,
  priceOfPack,
  providerKeyFor,
  taxPolicyFor,
  type CommercePolicy,
} from './commerce';
import { assessTax, type TaxAssessment } from './tax';

export type BillingInterval = 'MONTH' | 'YEAR';

export interface CheckoutView {
  readonly id: string;
  readonly workspaceId: string;
  readonly purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
  readonly status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
  readonly planKey: string | null;
  readonly billingInterval: BillingInterval | null;
  readonly packKey: string | null;
  readonly amount: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly providerKey: string;
  readonly providerSessionId: string | null;
  /** Where to send the browser. Null on a replay of a session already finished. */
  readonly redirectUrl: string | null;
  readonly expiresAt: Date;
}

interface OpenCheckoutBase {
  readonly workspaceId: string;
  readonly policy: CommercePolicy;
  /** The caller's own key. One logical intent, however many times it is sent. */
  readonly idempotencyKey: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly actorUserId: string | null;
  /** Which activated `commerce` version the amount was read from. */
  readonly commerceVersionId?: string | null;
}

export interface OpenSubscriptionCheckoutInput extends OpenCheckoutBase {
  readonly plan: PlanDetail;
  readonly billingInterval: BillingInterval;
  readonly planVersionId?: string | null;
}

export interface OpenPackCheckoutInput extends OpenCheckoutBase {
  readonly packKey: string;
}

export interface CheckoutServiceOptions {
  readonly providers: ProviderRegistry;
  readonly clock?: Clock;
}

/** The commercial identity a checkout is opened against. */
interface ResolvedBuyer {
  readonly country: string;
  readonly currency: string;
  readonly providerCustomerId: string;
  readonly provider: PaymentProviderAdapter;
  readonly providerKey: string;
}

export class CheckoutService {
  readonly #providers: ProviderRegistry;
  readonly #clock: Clock;

  constructor(options: CheckoutServiceOptions) {
    this.#providers = options.providers;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Open a checkout for a subscription.
   *
   * REFUSES RATHER THAN SUBSTITUTES. A plan with no price in the workspace's
   * chosen currency is unavailable and says which of the two reasons applies —
   * there is no conversion, and no "nearest currency" (D-08, §7).
   */
  async openSubscription(
    db: TenantScopedClient,
    input: OpenSubscriptionCheckoutInput,
  ): Promise<CheckoutView> {
    const replay = await this.#replay(db, input.workspaceId, input.idempotencyKey);
    if (replay) return replay;

    const buyer = await this.#resolveBuyer(db, input.workspaceId, input.policy);

    const availability = planAvailability(input.policy, input.plan, buyer.country, buyer.currency);
    if (!availability.available) {
      throw new AppError('VALIDATION_FAILED', 'That plan cannot be bought here.', {
        reason: availability.reason ?? 'unavailable',
        planKey: input.plan.key,
        currency: buyer.currency,
        country: buyer.country,
      });
    }

    const quoted = input.billingInterval === 'YEAR' ? availability.annual : availability.monthly;
    // Unreachable while `available` holds — both prices are set together. Kept
    // because a type that says "null" and a caller that assumes otherwise is
    // how a free subscription gets sold.
    if (!quoted) {
      throw new AppError('VALIDATION_FAILED', 'That plan has no price in this currency.');
    }

    const row = priceIn(input.plan, buyer.currency);
    if (!row) {
      throw new AppError('VALIDATION_FAILED', 'That plan has no price in this currency.');
    }

    return this.#open(db, {
      base: input,
      buyer,
      purpose: 'SUBSCRIPTION',
      planKey: input.plan.key,
      billingInterval: input.billingInterval,
      packKey: null,
      quoted,
      description: input.plan.nameEn,
      planVersionId: input.planVersionId ?? null,
    });
  }

  /** Open a checkout for a prepaid credit pack (D-196 — never an overage). */
  async openCreditPack(
    db: TenantScopedClient,
    input: OpenPackCheckoutInput,
  ): Promise<CheckoutView> {
    const replay = await this.#replay(db, input.workspaceId, input.idempotencyKey);
    if (replay) return replay;

    const buyer = await this.#resolveBuyer(db, input.workspaceId, input.policy);
    // Priced from the catalogue by KEY. The caller cannot supply an amount
    // because `priceOfPack` has no parameter for one.
    const offer = priceOfPack(input.policy, input.packKey, buyer.country, buyer.currency);

    return this.#open(db, {
      base: input,
      buyer,
      purpose: 'CREDIT_PACK',
      planKey: null,
      billingInterval: null,
      packKey: offer.pack.key,
      quoted: offer.price,
      description: offer.pack.name.en,
      planVersionId: null,
    });
  }

  /**
   * The customer abandoned the hosted page.
   *
   * A CANCELLATION IS NOT AUTHORITATIVE EITHER. It is recorded from the return
   * URL because it costs nothing to be wrong about — the worst case is a
   * session marked cancelled that a later `checkout.completed` event resurrects,
   * and reconciliation handles exactly that. The reverse — trusting a *success*
   * redirect — is what §22 forbids.
   */
  async cancel(
    db: TenantScopedClient,
    workspaceId: string,
    checkoutSessionId: string,
  ): Promise<void> {
    const result = await db.checkoutSession.updateMany({
      where: { workspaceId, id: checkoutSessionId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: this.#clock.now() },
    });
    if (result.count === 0) return;
    await writeAuditEvent(db, workspaceId, {
      action: 'billing.checkout.cancelled',
      actorType: 'USER',
      resourceType: 'CheckoutSession',
      resourceId: checkoutSessionId,
    });
  }

  /**
   * Close sessions whose window has passed.
   *
   * ONLY EVER `PENDING → EXPIRED`. A session that a provider event already
   * completed is not touched, however late the sweep runs — the `status` in the
   * WHERE clause is what makes this safe to run concurrently with reconciliation.
   */
  async expireDue(db: TenantScopedClient, workspaceId: string): Promise<number> {
    const { count } = await db.checkoutSession.updateMany({
      where: { workspaceId, status: 'PENDING', expiresAt: { lt: this.#clock.now() } },
      data: { status: 'EXPIRED' },
    });
    return count;
  }

  async get(
    db: TenantScopedClient,
    workspaceId: string,
    checkoutSessionId: string,
  ): Promise<CheckoutView | null> {
    const row = await db.checkoutSession.findFirst({
      where: { workspaceId, id: checkoutSessionId },
    });
    return row ? toView(row, null) : null;
  }

  // ---------------------------------------------------------------------------

  async #replay(
    db: TenantScopedClient,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<CheckoutView | null> {
    if (!idempotencyKey.trim()) {
      throw new AppError('VALIDATION_FAILED', 'An idempotency key is required.');
    }
    const existing = await db.checkoutSession.findFirst({
      where: { workspaceId, idempotencyKey },
    });
    if (!existing) return null;
    // A replay returns the ORIGINAL outcome — including its status. A caller
    // retrying after the customer already paid gets the completed session, not
    // a second bill.
    return toView(existing, null);
  }

  /**
   * Who is buying, in what currency, through which adapter.
   *
   * THE CURRENCY COMES FROM THE WORKSPACE, which the customer chose explicitly
   * at creation (D-194, §4). It is never inferred from the country, never
   * defaulted, and never read from the request.
   */
  async #resolveBuyer(
    db: TenantScopedClient,
    workspaceId: string,
    policy: CommercePolicy,
  ): Promise<ResolvedBuyer> {
    const workspace = await db.workspace.findFirst({
      where: { workspaceId },
      select: { country: true, currency: true, name: true, legalName: true },
    });
    if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found.');

    const profile = await db.billingProfile.findFirst({ where: { workspaceId } });
    if (!profile) {
      throw new AppError('VALIDATION_FAILED', 'This workspace has no billing details yet.');
    }

    const country = profile.country;
    const currency = workspace.currency.toUpperCase();

    const currencyDetail = findCurrency(policy, currency);
    if (!currencyDetail || currencyDetail.status !== 'active') {
      throw new AppError('VALIDATION_FAILED', 'That currency is not on sale.', { currency });
    }

    const providerKey = providerKeyFor(policy, country, currency);
    if (!providerKey) {
      // Refused, not defaulted. Routing money through an adapter the owner did
      // not choose for this market is worse than not selling there yet.
      throw new AppError('VALIDATION_FAILED', 'No payment provider serves this market.', {
        country,
        currency,
      });
    }
    const provider = this.#providers.get(providerKey);
    if (!provider) {
      throw new AppError('INTERNAL', 'The configured payment provider is not available.');
    }

    const capabilities = provider.capabilities();
    if (!capabilities.hostedCheckout) {
      throw new AppError('INTERNAL', 'The configured payment provider cannot host checkout.');
    }

    const ref = await provider.ensureCustomer({
      workspaceId,
      billingEmail: profile.billingEmail,
      legalName: profile.legalName ?? workspace.legalName ?? workspace.name,
      country,
      existingProviderCustomerId: profile.providerCustomerId,
    });

    if (
      profile.providerCustomerId !== ref.providerCustomerId ||
      profile.providerKey !== providerKey
    ) {
      // THE TRUSTED MAPPING, written by us. Every webhook resolves its workspace
      // through this row and never through the event body (§28).
      await db.billingProfile.update({
        where: { id: profile.id },
        data: { providerKey, providerCustomerId: ref.providerCustomerId },
      });
    }

    return {
      country,
      currency,
      providerCustomerId: ref.providerCustomerId,
      provider,
      providerKey,
    };
  }

  async #open(
    db: TenantScopedClient,
    args: {
      readonly base: OpenCheckoutBase;
      readonly buyer: ResolvedBuyer;
      readonly purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
      readonly planKey: string | null;
      readonly billingInterval: BillingInterval | null;
      readonly packKey: string | null;
      readonly quoted: Money;
      readonly description: string;
      readonly planVersionId: string | null;
    },
  ): Promise<CheckoutView> {
    const { base, buyer, quoted } = args;
    const assessment: TaxAssessment = assessTax(quoted, taxPolicyFor(base.policy, buyer.country));

    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + base.policy.checkout.sessionTtlMinutes * 60_000);

    const session = await db.checkoutSession.create({
      data: {
        workspaceId: base.workspaceId,
        purpose: args.purpose,
        status: 'PENDING',
        planKey: args.planKey,
        billingInterval: args.billingInterval,
        packKey: args.packKey,
        currency: assessment.subtotal.currency,
        currencyScale: assessment.subtotal.scale,
        amountMinor: assessment.subtotal.minorUnits,
        taxMinor: assessment.tax.minorUnits,
        totalMinor: assessment.total.minorUnits,
        planVersionId: args.planVersionId,
        commerceVersionId: base.commerceVersionId ?? null,
        providerKey: buyer.providerKey,
        returnUrl: base.successUrl,
        idempotencyKey: base.idempotencyKey,
        expiresAt,
        createdByUserId: base.actorUserId,
      },
    });

    const hosted = await buyer.provider.createCheckoutSession({
      workspaceId: base.workspaceId,
      providerCustomerId: buyer.providerCustomerId,
      checkoutSessionId: session.id,
      purpose: args.purpose,
      amount: assessment.subtotal,
      tax: assessment.tax,
      description: args.description,
      successUrl: base.successUrl,
      cancelUrl: base.cancelUrl,
      expiresAt,
      ...(args.planKey ? { planKey: args.planKey } : {}),
      ...(args.billingInterval ? { billingInterval: args.billingInterval } : {}),
    });

    const updated = await db.checkoutSession.update({
      where: { id: session.id },
      data: { providerSessionId: hosted.providerSessionId },
    });

    await writeAuditEvent(db, base.workspaceId, {
      action: 'billing.checkout.opened',
      actorType: base.actorUserId ? 'USER' : 'SYSTEM',
      actorId: base.actorUserId ?? undefined,
      resourceType: 'CheckoutSession',
      resourceId: session.id,
      // The AMOUNT is audited, so what was agreed is provable later. No card
      // data can appear here: hosted checkout means we never receive any.
      after: {
        purpose: args.purpose,
        planKey: args.planKey,
        packKey: args.packKey,
        currency: assessment.total.currency,
        totalMinor: assessment.total.minorUnits.toString(),
        providerKey: buyer.providerKey,
      },
    });

    return toView(updated, hosted.url);
  }
}

interface CheckoutRow {
  id: string;
  workspaceId: string;
  purpose: string;
  status: string;
  planKey: string | null;
  billingInterval: string | null;
  packKey: string | null;
  currency: string;
  currencyScale: number;
  amountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  providerKey: string;
  providerSessionId: string | null;
  expiresAt: Date;
}

export function toView(row: CheckoutRow, redirectUrl: string | null): CheckoutView {
  const money = (minor: bigint): Money => Money.ofMinor(row.currency, minor, row.currencyScale);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    purpose: row.purpose as CheckoutView['purpose'],
    status: row.status as CheckoutView['status'],
    planKey: row.planKey,
    billingInterval: (row.billingInterval as BillingInterval | null) ?? null,
    packKey: row.packKey,
    amount: money(row.amountMinor),
    tax: money(row.taxMinor),
    total: money(row.totalMinor),
    providerKey: row.providerKey,
    providerSessionId: row.providerSessionId,
    redirectUrl,
    expiresAt: row.expiresAt,
  };
}
