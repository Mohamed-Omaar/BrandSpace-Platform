/**
 * The payment provider contract — docs/BILLING-AND-CREDITS.md §1.
 *
 * BRANDSPACE OWNS THE COMMERCIAL DOMAIN. A provider moves money and holds the
 * PCI scope; it does not own our truth. Entitlements resolve from OUR
 * `Subscription`, invoices are OUR documents, and a provider outage cannot
 * remove a paying customer's access. Everything below is expressed in terms
 * this package defines, so swapping a provider changes one file.
 *
 * NOTHING HERE NAMES A PRODUCTION PROVIDER, and that is an owner decision rather
 * than an omission (D-204). The only adapter shipped in Phase 9 is the
 * deterministic development one; the production adapter, its credentials and
 * its configuration are Phase 10.
 *
 * HOSTED CHECKOUT IS NOT A PREFERENCE. Every payment path in this interface
 * returns a URL the customer is sent to. There is no method that accepts a card
 * number, a CVC or any payment instrument, because a method that could would be
 * the beginning of PCI scope inside BrandSpace — and the absence of one is the
 * only durable way to guarantee it never arrives.
 */

import type { Money } from '@brandspace/shared';

export type ProviderEnvironment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

/**
 * What a provider can actually do.
 *
 * DECLARED, NEVER ASSUMED EQUAL. A regional provider may not support proration
 * or may not calculate tax; the UI and the validation read these rather than
 * offering a capability that will fail at the till. The same discipline the
 * social connectors use (docs/SOCIAL-INTEGRATIONS.md §1.7).
 */
export interface ProviderCapabilities {
  readonly hostedCheckout: boolean;
  readonly hostedPortal: boolean;
  readonly subscriptions: boolean;
  readonly proration: boolean;
  /** Whether the provider computes tax, or we apply the configured policy. */
  readonly taxCalculation: boolean;
  readonly refunds: boolean;
  readonly partialRefunds: boolean;
  /** ISO codes the provider will settle in. Empty means "ask the owner". */
  readonly currencies: readonly string[];
  /** Trials that do not require a card up front (D-09). */
  readonly trialsWithoutCard: boolean;
}

export interface ProviderCustomerRef {
  readonly providerCustomerId: string;
}

export interface EnsureCustomerParams {
  readonly workspaceId: string;
  readonly billingEmail: string;
  readonly legalName: string | null;
  readonly country: string;
  /** An existing reference, when we already have one. */
  readonly existingProviderCustomerId: string | null;
}

/**
 * A hosted session the customer is redirected into.
 *
 * `url` is where the browser goes. `providerSessionId` is what a later event
 * refers back to — and is NOT an authorization boundary: possession of one
 * proves nothing, and every use of it is a lookup constrained by a tenant
 * predicate we applied first (§23).
 */
export interface HostedSession {
  readonly providerSessionId: string;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface CheckoutParams {
  readonly workspaceId: string;
  readonly providerCustomerId: string;
  /** Our own checkout row id, echoed back on the event so we can reconcile. */
  readonly checkoutSessionId: string;
  readonly purpose: 'SUBSCRIPTION' | 'CREDIT_PACK';
  /** THE AMOUNT WE CALCULATED. Never one the browser supplied. */
  readonly amount: Money;
  readonly tax: Money;
  readonly description: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: Date;
  /** Present for a subscription checkout. */
  readonly planKey?: string;
  readonly billingInterval?: 'MONTH' | 'YEAR';
}

export interface PortalParams {
  readonly providerCustomerId: string;
  readonly returnUrl: string;
}

export interface ProviderSubscription {
  readonly providerSubscriptionId: string;
  readonly status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired';
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
}

export interface UpdateSubscriptionParams {
  readonly providerSubscriptionId: string;
  readonly planKey: string;
  readonly billingInterval: 'MONTH' | 'YEAR';
  readonly amount: Money;
  /** Whether the provider should prorate. Only meaningful if it can. */
  readonly prorate: boolean;
  readonly effective: 'immediate' | 'period_end';
}

export interface CancelParams {
  readonly providerSubscriptionId: string;
  readonly atPeriodEnd: boolean;
}

export interface RefundParams {
  readonly providerPaymentId: string;
  readonly amount: Money;
  readonly reason: string;
  /** One refund per logical request, however many times it is retried. */
  readonly idempotencyKey: string;
}

export interface ProviderRefund {
  readonly providerRefundId: string;
  readonly amount: Money;
}

/**
 * A provider event, normalized into OUR vocabulary.
 *
 * THE SHAPE RECONCILIATION READS. Nothing downstream of `parseWebhook` sees a
 * provider-shaped field, which is what lets the reconciler be written once
 * rather than once per provider.
 *
 * `providerCustomerId` IS HOW THE WORKSPACE IS FOUND, by looking it up in
 * `billing_profile` — a relationship WE wrote. An event that merely claims a
 * workspace id is not believed (§28), and there is deliberately no
 * `workspaceId` field on this type for anybody to reach for.
 */
export interface NormalizedBillingEvent {
  readonly externalEventId: string;
  readonly type: NormalizedBillingEventType;
  /** The provider's own timestamp — ordering is compared against this. */
  readonly occurredAt: Date;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly providerSessionId: string | null;
  readonly providerPaymentId: string | null;
  readonly providerInvoiceId: string | null;
  /** The amount the PROVIDER says moved, for comparison against our own. */
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  /** Our own checkout id, when the provider was able to carry it. Advisory. */
  readonly checkoutSessionId: string | null;
  readonly failureCode: string | null;
  readonly cancelAtPeriodEnd: boolean | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

export const NORMALIZED_BILLING_EVENT_TYPES = [
  'checkout.completed',
  'checkout.cancelled',
  'subscription.created',
  'subscription.updated',
  'subscription.cancelled',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
] as const;

export type NormalizedBillingEventType = (typeof NORMALIZED_BILLING_EVENT_TYPES)[number];

export interface WebhookVerification {
  readonly valid: boolean;
  /** Safe to log. Never the signature, the secret, or the body. */
  readonly reason: string | null;
}

export interface PaymentProviderAdapter {
  readonly key: string;

  capabilities(): ProviderCapabilities;

  ensureCustomer(params: EnsureCustomerParams): Promise<ProviderCustomerRef>;

  /** Hosted. There is no non-hosted alternative, by design. */
  createCheckoutSession(params: CheckoutParams): Promise<HostedSession>;
  createBillingPortalSession(params: PortalParams): Promise<HostedSession>;

  updateSubscription(params: UpdateSubscriptionParams): Promise<ProviderSubscription>;
  cancelSubscription(params: CancelParams): Promise<ProviderSubscription>;
  resumeSubscription(params: { providerSubscriptionId: string }): Promise<ProviderSubscription>;

  refund(params: RefundParams): Promise<ProviderRefund>;

  /**
   * Verify the signature over the RAW body, before any parsing.
   *
   * RAW, and the order matters. Parsing first and verifying the re-serialized
   * result would verify a different document from the one that was signed — a
   * classic way to accept a forged event that happens to round-trip.
   */
  verifyWebhook(raw: Buffer, headers: Readonly<Record<string, string>>): WebhookVerification;

  /** Only ever called on a body that verified. */
  parseWebhook(raw: Buffer): readonly NormalizedBillingEvent[];
}

/** A registry of adapters by provider key. */
export type ProviderRegistry = ReadonlyMap<string, PaymentProviderAdapter>;
