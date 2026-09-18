/**
 * The development payment provider — deterministic, signed, and not a stub.
 *
 * WHAT IT IS FOR. Proving every commercial workflow end to end before a
 * production vendor is chosen (D-204), and doing it in a way that exercises the
 * SAME code paths a real provider will: a hosted page the customer is sent to,
 * an authoritative event signed over a raw body, ordering by the provider's own
 * timestamp, and a reconciliation that trusts none of it until the signature
 * verifies.
 *
 * WHY IT IS NOT A STUB THAT RETURNS SUCCESS. A "provider" that reports paid the
 * moment it is called would let the product be built on the assumption that a
 * redirect is money, which is the single most expensive thing to get wrong here
 * (§22). This one issues an event that must be delivered, verified and
 * reconciled before anything is paid — so the honest path is the only path that
 * works, in development as in production.
 *
 * THE SECRET IS NOT A PRODUCTION CREDENTIAL. It is generated per environment
 * for the development adapter and is only ever used to sign and verify the
 * loopback events this adapter produces. No real provider credential exists in
 * this repository (§3, §48).
 *
 * DETERMINISM. Ids derive from the inputs, so a replayed call produces the same
 * id and a test can assert on it. Nothing here reaches the network.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, systemClock, type Clock, type Money } from '@brandspace/shared';
import type {
  CancelParams,
  CheckoutParams,
  EnsureCustomerParams,
  HostedSession,
  NormalizedBillingEvent,
  NormalizedBillingEventType,
  PaymentProviderAdapter,
  PortalParams,
  ProviderCapabilities,
  ProviderCustomerRef,
  ProviderRefund,
  ProviderSubscription,
  RefundParams,
  UpdateSubscriptionParams,
  WebhookVerification,
} from '../adapter';

export const DEVELOPMENT_PROVIDER_KEY = 'development-mock';

/** The header the adapter signs into. Mirrors how real providers do it. */
export const DEVELOPMENT_SIGNATURE_HEADER = 'x-brandspace-billing-signature';
export const DEVELOPMENT_TIMESTAMP_HEADER = 'x-brandspace-billing-timestamp';

/** How far a signed timestamp may drift before the event is refused. */
const MAX_SIGNATURE_AGE_SECONDS = 300;

export interface DevelopmentProviderOptions {
  /**
   * The signing secret for this environment's loopback events.
   *
   * NOT A PRODUCTION CREDENTIAL and never a real provider's. It is supplied by
   * the caller rather than defaulted so that a deployment which forgot to set
   * one fails closed instead of silently signing with a value an attacker could
   * read out of this file.
   */
  readonly webhookSecret: string;
  /** Where the hosted page lives. The API serves it in development. */
  readonly hostedBaseUrl: string;
  readonly clock?: Clock;
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHmac('sha256', 'development-provider-id')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

export class DevelopmentPaymentProvider implements PaymentProviderAdapter {
  readonly key = DEVELOPMENT_PROVIDER_KEY;

  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #clock: Clock;

  constructor(options: DevelopmentProviderOptions) {
    if (!options.webhookSecret || options.webhookSecret.length < 16) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The development billing provider needs a signing secret of at least 16 characters.',
      );
    }
    this.#secret = options.webhookSecret;
    this.#baseUrl = options.hostedBaseUrl.replace(/\/+$/, '');
    this.#clock = options.clock ?? systemClock;
  }

  capabilities(): ProviderCapabilities {
    return {
      hostedCheckout: true,
      hostedPortal: true,
      subscriptions: true,
      proration: true,
      /*
       * FALSE ON PURPOSE. Tax is applied from the market's configured policy
       * (§32), so the platform proves the configuration-driven path rather than
       * leaning on a provider engine it may not have in every market.
       */
      taxCalculation: false,
      refunds: true,
      partialRefunds: true,
      /*
       * EMPTY MEANS "WHATEVER THE OWNER CONFIGURED". The development adapter
       * settles in any currency the commerce catalogue carries, because
       * restricting it here would be this file deciding which markets exist.
       */
      currencies: [],
      trialsWithoutCard: true,
    };
  }

  async ensureCustomer(params: EnsureCustomerParams): Promise<ProviderCustomerRef> {
    if (params.existingProviderCustomerId) {
      return { providerCustomerId: params.existingProviderCustomerId };
    }
    // Derived from the workspace, so re-running onboarding cannot create a
    // second customer for the same workspace — the mapping must stay one to one
    // or webhook resolution becomes ambiguous.
    return { providerCustomerId: stableId('cus', params.workspaceId) };
  }

  async createCheckoutSession(params: CheckoutParams): Promise<HostedSession> {
    const providerSessionId = stableId('cs', params.checkoutSessionId);
    const url = new URL(`${this.#baseUrl}/billing/checkout/${providerSessionId}`);
    // The hosted page needs to know what it is collecting and where to send the
    // customer back. It is given NO amount it could alter: the total is read
    // from our own row by id.
    url.searchParams.set('session', params.checkoutSessionId);
    url.searchParams.set('success', params.successUrl);
    url.searchParams.set('cancel', params.cancelUrl);
    return { providerSessionId, url: url.toString(), expiresAt: params.expiresAt };
  }

  async createBillingPortalSession(params: PortalParams): Promise<HostedSession> {
    const providerSessionId = stableId('bps', params.providerCustomerId);
    const url = new URL(`${this.#baseUrl}/billing/portal/${providerSessionId}`);
    url.searchParams.set('return', params.returnUrl);
    return {
      providerSessionId,
      url: url.toString(),
      expiresAt: new Date(this.#clock.now().getTime() + 900_000),
    };
  }

  async updateSubscription(params: UpdateSubscriptionParams): Promise<ProviderSubscription> {
    const start = this.#clock.now();
    return {
      providerSubscriptionId: params.providerSubscriptionId,
      status: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: addInterval(start, params.billingInterval),
      cancelAtPeriodEnd: false,
    };
  }

  async cancelSubscription(params: CancelParams): Promise<ProviderSubscription> {
    const now = this.#clock.now();
    return {
      providerSubscriptionId: params.providerSubscriptionId,
      status: params.atPeriodEnd ? 'active' : 'cancelled',
      currentPeriodStart: now,
      currentPeriodEnd: now,
      cancelAtPeriodEnd: params.atPeriodEnd,
    };
  }

  async resumeSubscription(params: {
    providerSubscriptionId: string;
  }): Promise<ProviderSubscription> {
    const now = this.#clock.now();
    return {
      providerSubscriptionId: params.providerSubscriptionId,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: addInterval(now, 'MONTH'),
      cancelAtPeriodEnd: false,
    };
  }

  async refund(params: RefundParams): Promise<ProviderRefund> {
    // Derived from the idempotency key, so a retried refund returns the SAME
    // provider refund id rather than making a second one.
    return {
      providerRefundId: stableId('re', params.idempotencyKey),
      amount: params.amount,
    };
  }

  /**
   * Verify the HMAC over `timestamp.rawBody`.
   *
   * THE TIMESTAMP IS INSIDE THE SIGNED STRING, which is what stops a captured
   * event being replayed forever: the signature is valid but the timestamp is
   * old, and this refuses it. Idempotency on the event id makes a replay a
   * no-op; this makes an old one not arrive at all.
   *
   * `timingSafeEqual` because comparing signatures with `===` leaks their
   * prefix through timing.
   */
  verifyWebhook(raw: Buffer, headers: Readonly<Record<string, string>>): WebhookVerification {
    const signature = headers[DEVELOPMENT_SIGNATURE_HEADER];
    const timestamp = headers[DEVELOPMENT_TIMESTAMP_HEADER];

    if (!signature || !timestamp) {
      return { valid: false, reason: 'missing_signature' };
    }

    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) {
      return { valid: false, reason: 'bad_timestamp' };
    }
    const ageSeconds = Math.abs(this.#clock.now().getTime() / 1000 - sentAt);
    if (ageSeconds > MAX_SIGNATURE_AGE_SECONDS) {
      return { valid: false, reason: 'stale_signature' };
    }

    const expected = this.sign(raw, sentAt);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: 'signature_mismatch' };
    }
    return { valid: true, reason: null };
  }

  /** The signature a caller must send. Exposed so the loopback can produce one. */
  sign(raw: Buffer, timestampSeconds: number): string {
    return createHmac('sha256', this.#secret)
      .update(`${timestampSeconds}.`)
      .update(raw)
      .digest('hex');
  }

  /**
   * Parse a verified body into our own vocabulary.
   *
   * THROWS ON A SHAPE IT DOES NOT RECOGNISE rather than returning an empty list.
   * An event we cannot understand is not the same as no event, and silently
   * dropping one is how money goes missing.
   */
  parseWebhook(raw: Buffer): readonly NormalizedBillingEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'The billing event body is not JSON.');
    }

    const events = Array.isArray(parsed) ? parsed : [parsed];
    return events.map((event) => normalizeEvent(event as Record<string, unknown>));
  }
}

function addInterval(from: Date, interval: 'MONTH' | 'YEAR'): Date {
  const next = new Date(from);
  if (interval === 'YEAR') next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

const KNOWN_TYPES = new Set<string>([
  'checkout.completed',
  'checkout.cancelled',
  'subscription.created',
  'subscription.updated',
  'subscription.cancelled',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeEvent(raw: Record<string, unknown>): NormalizedBillingEvent {
  const id = str(raw['id']);
  const type = str(raw['type']);
  if (!id || !type || !KNOWN_TYPES.has(type)) {
    throw new AppError('VALIDATION_FAILED', 'Unrecognised billing event.');
  }

  const occurredAtRaw = str(raw['occurredAt']);
  const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    // ORDERING DEPENDS ON THIS. An event with no usable timestamp cannot be
    // compared against the state it claims to describe, so it is refused rather
    // than applied in arrival order.
    throw new AppError('VALIDATION_FAILED', 'A billing event needs a valid timestamp.');
  }

  const data = (raw['data'] ?? {}) as Record<string, unknown>;
  const amount = data['amountMinor'];

  return {
    externalEventId: id,
    type: type as NormalizedBillingEventType,
    occurredAt,
    providerCustomerId: str(data['providerCustomerId']),
    providerSubscriptionId: str(data['providerSubscriptionId']),
    providerSessionId: str(data['providerSessionId']),
    providerPaymentId: str(data['providerPaymentId']),
    providerInvoiceId: str(data['providerInvoiceId']),
    amountMinor: typeof amount === 'string' || typeof amount === 'number' ? BigInt(amount) : null,
    currency: str(data['currency']),
    checkoutSessionId: str(data['checkoutSessionId']),
    failureCode: str(data['failureCode']),
    cancelAtPeriodEnd:
      typeof data['cancelAtPeriodEnd'] === 'boolean' ? data['cancelAtPeriodEnd'] : null,
    periodStart: str(data['periodStart']) ? new Date(str(data['periodStart'])!) : null,
    periodEnd: str(data['periodEnd']) ? new Date(str(data['periodEnd'])!) : null,
  };
}

/**
 * Compose a signed delivery, the way the provider would send one.
 *
 * USED BY THE HOSTED PAGE AND BY TESTS, and by nothing in the reconciliation
 * path — the reconciler only ever receives bytes and headers, so it cannot
 * accidentally be handed a trusted object.
 */
export function signedDelivery(
  provider: DevelopmentPaymentProvider,
  event: DevelopmentEventInput,
  at: Date = systemClock.now(),
): { readonly body: Buffer; readonly headers: Record<string, string> } {
  const body = Buffer.from(
    JSON.stringify({
      id: event.id,
      type: event.type,
      occurredAt: (event.occurredAt ?? at).toISOString(),
      data: event.data,
    }),
    'utf8',
  );
  const timestampSeconds = Math.floor(at.getTime() / 1000);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      [DEVELOPMENT_TIMESTAMP_HEADER]: String(timestampSeconds),
      [DEVELOPMENT_SIGNATURE_HEADER]: provider.sign(body, timestampSeconds),
    },
  };
}

export interface DevelopmentEventInput {
  readonly id: string;
  readonly type: NormalizedBillingEventType;
  readonly occurredAt?: Date;
  readonly data: Record<string, unknown>;
}

/** Convenience for the hosted page: the payload shape a paid checkout produces. */
export function paidCheckoutEvent(input: {
  readonly eventId: string;
  readonly checkoutSessionId: string;
  readonly providerSessionId: string;
  readonly providerCustomerId: string;
  readonly amount: Money;
  readonly occurredAt?: Date;
  readonly providerPaymentId?: string;
}): DevelopmentEventInput {
  return {
    id: input.eventId,
    type: 'checkout.completed',
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    data: {
      checkoutSessionId: input.checkoutSessionId,
      providerSessionId: input.providerSessionId,
      providerCustomerId: input.providerCustomerId,
      providerPaymentId: input.providerPaymentId ?? stableId('pay', input.checkoutSessionId),
      // The amount the PROVIDER says moved. Reconciliation compares it against
      // our own row and refuses a mismatch (§37).
      amountMinor: input.amount.minorUnits.toString(),
      currency: input.amount.currency,
    },
  };
}
