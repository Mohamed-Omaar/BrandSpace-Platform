import { describe, expect, it } from 'vitest';
import { Money, type Clock } from '@brandspace/shared';
import {
  DEVELOPMENT_PROVIDER_KEY,
  DEVELOPMENT_SIGNATURE_HEADER,
  DEVELOPMENT_TIMESTAMP_HEADER,
  DevelopmentPaymentProvider,
  assessTax,
  commercePolicyFrom,
  nextDunningStep,
  normaliseFailureCode,
  paidCheckoutEvent,
  signedDelivery,
  taxIdRequired,
  taxPolicyFor,
} from '@brandspace/billing';
import { CATALOGUE } from '../support/commerce-fixture';

/**
 * The payment provider CONTRACT, proven against the only adapter Phase 9 ships.
 *
 * NO PRODUCTION PROVIDER IS NAMED HERE, and none is needed: the properties under
 * test — a signature over the raw body, a timestamp inside the signed string, an
 * event that must be delivered before anything is paid — are the ones every real
 * provider will have to satisfy when the owner chooses one (D-204).
 *
 * THE SECRET BELOW IS A TEST STRING. It is not a credential, it authenticates
 * nothing outside this file, and no real key exists anywhere in this repository.
 */

const POLICY = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);

const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
const clockAt = (at: Date): Clock => ({ now: () => at });

function provider(at: Date = FIXED_NOW): DevelopmentPaymentProvider {
  return new DevelopmentPaymentProvider({
    webhookSecret: 'fixture-signing-secret-not-a-credential',
    hostedBaseUrl: 'https://example.test/api',
    clock: clockAt(at),
  });
}

describe('the development provider refuses to be a stub', () => {
  it('will not start without a signing secret long enough to be one', () => {
    expect(
      () =>
        new DevelopmentPaymentProvider({ webhookSecret: 'short', hostedBaseUrl: 'https://x.test' }),
    ).toThrow(/signing secret/i);
  });

  it('exposes hosted checkout and nothing that could accept a card', () => {
    const adapter = provider();
    expect(adapter.key).toBe(DEVELOPMENT_PROVIDER_KEY);
    expect(adapter.capabilities().hostedCheckout).toBe(true);
    // The contract has no method taking a PAN, a CVC or an instrument token.
    // This asserts the absence, which is the whole PCI argument (§3).
    for (const forbidden of ['chargeCard', 'createPayment', 'tokenizeCard', 'capture']) {
      expect(forbidden in adapter).toBe(false);
    }
  });

  it('returns a URL the customer is sent to, carrying no amount', async () => {
    const session = await provider().createCheckoutSession({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      providerCustomerId: 'cus_fixture',
      checkoutSessionId: '22222222-2222-4222-8222-222222222222',
      purpose: 'SUBSCRIPTION',
      amount: Money.ofMinor('SAR', 9900, 2),
      tax: Money.ofMinor('SAR', 1485, 2),
      description: 'Fixture plan',
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
      expiresAt: new Date('2026-06-01T12:30:00.000Z'),
    });
    const url = new URL(session.url);
    expect(url.searchParams.get('session')).toBe('22222222-2222-4222-8222-222222222222');
    // NO AMOUNT IN THE URL. The hosted page reads the total from our own row, so
    // a customer editing the address bar changes nothing they are charged (§37).
    expect(url.search).not.toMatch(/amount|total|price|minor/i);
  });

  it('derives one provider customer per workspace, however often onboarding reruns', async () => {
    const adapter = provider();
    const first = await adapter.ensureCustomer({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      billingEmail: 'finance@example.test',
      legalName: null,
      country: 'SA',
      existingProviderCustomerId: null,
    });
    const second = await adapter.ensureCustomer({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      billingEmail: 'finance@example.test',
      legalName: null,
      country: 'SA',
      existingProviderCustomerId: null,
    });
    const other = await adapter.ensureCustomer({
      workspaceId: '33333333-3333-4333-8333-333333333333',
      billingEmail: 'finance@example.test',
      legalName: null,
      country: 'SA',
      existingProviderCustomerId: null,
    });
    expect(second.providerCustomerId).toBe(first.providerCustomerId);
    expect(other.providerCustomerId).not.toBe(first.providerCustomerId);
  });

  it('returns the same refund id for a retried refund', async () => {
    const adapter = provider();
    const amount = Money.ofMinor('SAR', 9900, 2);
    const a = await adapter.refund({
      providerPaymentId: 'pay_1',
      amount,
      reason: 'duplicate charge',
      idempotencyKey: 'refund-key-1',
    });
    const b = await adapter.refund({
      providerPaymentId: 'pay_1',
      amount,
      reason: 'duplicate charge',
      idempotencyKey: 'refund-key-1',
    });
    expect(b.providerRefundId).toBe(a.providerRefundId);
  });
});

describe('webhook signatures are verified over the raw body', () => {
  const event = paidCheckoutEvent({
    eventId: 'evt_fixture_1',
    checkoutSessionId: '22222222-2222-4222-8222-222222222222',
    providerSessionId: 'cs_fixture',
    providerCustomerId: 'cus_fixture',
    amount: Money.ofMinor('SAR', 11385, 2),
    occurredAt: FIXED_NOW,
  });

  it('accepts a correctly signed delivery', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    expect(adapter.verifyWebhook(delivery.body, delivery.headers)).toEqual({
      valid: true,
      reason: null,
    });
  });

  it('refuses a body that was altered after signing', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    const tampered = Buffer.from(delivery.body.toString('utf8').replace('11385', '1'), 'utf8');
    expect(adapter.verifyWebhook(tampered, delivery.headers).valid).toBe(false);
  });

  it('refuses a delivery with no signature at all', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    expect(adapter.verifyWebhook(delivery.body, {}).reason).toBe('missing_signature');
    expect(
      adapter.verifyWebhook(delivery.body, {
        [DEVELOPMENT_TIMESTAMP_HEADER]: delivery.headers[DEVELOPMENT_TIMESTAMP_HEADER]!,
      }).reason,
    ).toBe('missing_signature');
  });

  it('refuses a captured delivery replayed hours later', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    // The signature is still cryptographically valid — the TIMESTAMP inside the
    // signed string is what expires it. Idempotency makes a replay a no-op; this
    // makes an old one not arrive at all.
    const later = provider(new Date(FIXED_NOW.getTime() + 3_600_000));
    expect(later.verifyWebhook(delivery.body, delivery.headers).reason).toBe('stale_signature');
  });

  it('refuses a signature signed with a different secret', () => {
    const attacker = new DevelopmentPaymentProvider({
      webhookSecret: 'a-different-fixture-secret-value',
      hostedBaseUrl: 'https://example.test/api',
      clock: clockAt(FIXED_NOW),
    });
    const forged = signedDelivery(attacker, event, FIXED_NOW);
    expect(provider().verifyWebhook(forged.body, forged.headers).reason).toBe('signature_mismatch');
  });

  it('refuses a timestamp that is not a number', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    expect(
      adapter.verifyWebhook(delivery.body, {
        ...delivery.headers,
        [DEVELOPMENT_TIMESTAMP_HEADER]: 'yesterday',
      }).reason,
    ).toBe('bad_timestamp');
  });

  it('never returns the signature, the secret or the body in its reason', () => {
    const adapter = provider();
    const delivery = signedDelivery(adapter, event, FIXED_NOW);
    const reason = adapter.verifyWebhook(delivery.body, {
      ...delivery.headers,
      [DEVELOPMENT_SIGNATURE_HEADER]: 'f'.repeat(64),
    }).reason;
    expect(reason).toBe('signature_mismatch');
    expect(reason).not.toContain(delivery.headers[DEVELOPMENT_SIGNATURE_HEADER]);
  });
});

describe('parsing a verified body', () => {
  it('normalizes a paid checkout into our own vocabulary', () => {
    const adapter = provider();
    const delivery = signedDelivery(
      adapter,
      paidCheckoutEvent({
        eventId: 'evt_fixture_2',
        checkoutSessionId: '22222222-2222-4222-8222-222222222222',
        providerSessionId: 'cs_fixture',
        providerCustomerId: 'cus_fixture',
        amount: Money.ofMinor('KWD', 9900, 3),
        occurredAt: FIXED_NOW,
      }),
      FIXED_NOW,
    );
    const [normalized] = adapter.parseWebhook(delivery.body);
    expect(normalized?.type).toBe('checkout.completed');
    expect(normalized?.providerCustomerId).toBe('cus_fixture');
    // THE AMOUNT SURVIVES AS AN INTEGER. A three-digit currency read through a
    // float would already be wrong by here.
    expect(normalized?.amountMinor).toBe(9900n);
    expect(normalized?.currency).toBe('KWD');
    // AND THERE IS NO WORKSPACE ON IT. Nothing downstream can trust one,
    // because there is nothing to trust (§28).
    expect(normalized && 'workspaceId' in normalized).toBe(false);
  });

  it('throws on an event type it does not recognise rather than dropping it', () => {
    const adapter = provider();
    const body = Buffer.from(
      JSON.stringify({ id: 'evt_x', type: 'account.updated', occurredAt: FIXED_NOW.toISOString() }),
      'utf8',
    );
    expect(() => adapter.parseWebhook(body)).toThrow(/Unrecognised billing event/i);
  });

  it('throws on an event with no usable timestamp, because ordering depends on it', () => {
    const adapter = provider();
    const body = Buffer.from(
      JSON.stringify({ id: 'evt_x', type: 'invoice.paid', occurredAt: 'not-a-date' }),
      'utf8',
    );
    expect(() => adapter.parseWebhook(body)).toThrow(/valid timestamp/i);
  });

  it('throws on a body that is not JSON', () => {
    expect(() => provider().parseWebhook(Buffer.from('<html>', 'utf8'))).toThrow(/not JSON/i);
  });
});

describe('tax is applied from the market policy, never from a rule in code', () => {
  it('adds exclusive tax on top of the advertised price', () => {
    const assessment = assessTax(Money.ofMinor('SAR', 10_000, 2), taxPolicyFor(POLICY, 'SA'));
    expect(assessment.mode).toBe('EXCLUSIVE');
    expect(assessment.subtotal.toDecimalString()).toBe('100.00');
    expect(assessment.tax.toDecimalString()).toBe('15.00');
    expect(assessment.total.toDecimalString()).toBe('115.00');
  });

  it('charges nothing where the market has a zero-rate policy', () => {
    const assessment = assessTax(Money.ofMinor('KWD', 9_900, 3), taxPolicyFor(POLICY, 'KW'));
    expect(assessment.mode).toBe('NONE');
    expect(assessment.tax.isZero).toBe(true);
    expect(assessment.total.toDecimalString()).toBe('9.900');
  });

  it('charges nothing where the market has no policy at all', () => {
    const assessment = assessTax(Money.ofMinor('BHD', 9_800, 3), taxPolicyFor(POLICY, 'BH'));
    expect(assessment.mode).toBe('NONE');
    expect(assessment.total.toDecimalString()).toBe('9.800');
  });

  it('derives the net backwards for an inclusive market, and the parts still add up', () => {
    const inclusive = {
      key: 'inclusive-fixture',
      name: { ar: 'شامل', en: 'Inclusive' },
      mode: 'inclusive' as const,
      rateBasisPoints: 1500,
      taxIdLabel: null,
      taxIdRequired: false,
      invoiceNote: null,
    };
    const assessment = assessTax(Money.ofMinor('SAR', 11_500, 2), inclusive);
    expect(assessment.mode).toBe('INCLUSIVE');
    // The customer was SHOWN 115.00 and pays 115.00.
    expect(assessment.total.toDecimalString()).toBe('115.00');
    expect(assessment.subtotal.toDecimalString()).toBe('100.00');
    // The tax is the REMAINDER, so subtotal + tax is exactly the total — which
    // the invoice CHECK constraint requires and a second rounding would break.
    expect(assessment.subtotal.plus(assessment.tax).equals(assessment.total)).toBe(true);
  });

  it('keeps inclusive arithmetic exact on an amount that does not divide evenly', () => {
    const inclusive = {
      key: 'inclusive-fixture',
      name: { ar: 'شامل', en: 'Inclusive' },
      mode: 'inclusive' as const,
      rateBasisPoints: 1500,
      taxIdLabel: null,
      taxIdRequired: false,
      invoiceNote: null,
    };
    for (const gross of [1n, 7n, 9_999n, 123_457n]) {
      const assessment = assessTax(Money.ofMinor('SAR', gross, 2), inclusive);
      expect(assessment.subtotal.plus(assessment.tax).equals(assessment.total)).toBe(true);
      expect(assessment.tax.isNegative).toBe(false);
    }
  });

  it('asks the policy whether a tax id is required, and never a country list', () => {
    expect(taxIdRequired(taxPolicyFor(POLICY, 'SA'))).toBe(false);
    expect(taxIdRequired(null)).toBe(false);
  });
});

describe('dunning is a schedule, not a mood', () => {
  const policy = { retryOffsetDays: [1, 3, 5], graceDays: 7, cancelAfterSuspendedDays: 30 };
  const firstFailedAt = new Date('2026-06-01T00:00:00.000Z');

  it('schedules each retry from the FIRST failure, not the last attempt', () => {
    const first = nextDunningStep({ policy, firstFailedAt, attemptsMade: 1, now: firstFailedAt });
    const second = nextDunningStep({ policy, firstFailedAt, attemptsMade: 2, now: firstFailedAt });
    expect(first).toMatchObject({ kind: 'retry', attemptNumber: 2 });
    expect(first.kind === 'retry' && first.at.toISOString()).toBe('2026-06-02T00:00:00.000Z');
    expect(second.kind === 'retry' && second.at.toISOString()).toBe('2026-06-04T00:00:00.000Z');
  });

  it('is idempotent: running the same decision twice gives the same answer', () => {
    const a = nextDunningStep({ policy, firstFailedAt, attemptsMade: 2, now: firstFailedAt });
    const b = nextDunningStep({
      policy,
      firstFailedAt,
      attemptsMade: 2,
      now: new Date(firstFailedAt.getTime() + 60_000),
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('holds access through the grace period once retries are exhausted', () => {
    const step = nextDunningStep({
      policy,
      firstFailedAt,
      attemptsMade: 4,
      now: new Date('2026-06-05T00:00:00.000Z'),
    });
    expect(step.kind).toBe('grace');
  });

  it('suspends only after the grace period, and says when cancellation follows', () => {
    const step = nextDunningStep({
      policy,
      firstFailedAt,
      attemptsMade: 4,
      now: new Date('2026-06-09T00:00:00.000Z'),
    });
    expect(step.kind).toBe('suspend');
    expect(step.kind === 'suspend' && step.cancelAfterAt.toISOString()).toBe(
      '2026-07-08T00:00:00.000Z',
    );
  });

  it('never lets a provider message through as a failure reason', () => {
    expect(normaliseFailureCode('card_declined')).toBe('card_declined');
    expect(normaliseFailureCode('Declined: card 4242 belonging to A. Customer')).toBe(
      'payment_failed',
    );
    expect(normaliseFailureCode(null)).toBe('payment_failed');
  });
});
