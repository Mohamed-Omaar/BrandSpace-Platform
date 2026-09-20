import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  BillingReconciler,
  CheckoutService,
  CreditNoteService,
  DEVELOPMENT_PROVIDER_KEY,
  DevelopmentPaymentProvider,
  InvoiceService,
  SubscriptionLifecycleService,
  commercePolicyFrom,
  creditLedgerPort,
  paidCheckoutEvent,
  signedDelivery,
  type CommercePolicy,
  type DevelopmentEventInput,
  type PaymentProviderAdapter,
} from '@brandspace/billing';
import { CreditLedgerService, findPlan, readPlanCatalogue } from '@brandspace/entitlements';
import { WorkspaceOnboardingService } from '@brandspace/onboarding';
import { Money } from '@brandspace/shared';
import { appRoleClient, createIsolationFixtures, platformRoleClient } from './fixtures';
import { CATALOGUE } from '../support/commerce-fixture';
import { PLANS_FIXTURE } from '../support/plans-fixture';

/**
 * The Phase 9 commercial lifecycle, end to end, against REAL PostgreSQL.
 *
 * WHAT THIS SUITE IS FOR. `commerce-tenancy` proves one workspace cannot see
 * another's commercial rows. This proves the MACHINERY: that a redirect does not
 * pay for anything, that a signed event does, that a replay does nothing, that a
 * stale event is refused, that a forged one leaves no trace, and that a wrong
 * amount is a failure rather than a payment.
 *
 * IT DRIVES THE PRODUCTION CODE PATHS, not a rehearsal of them. The same
 * `CheckoutService` the API route calls, the same `BillingReconciler` the webhook
 * calls, the same `InvoiceService` numbering through the same PostgreSQL
 * function. The only thing standing in for production is the payment provider —
 * which is the whole point of D-204.
 *
 * THE SECRET AND EVERY PRICE BELOW ARE FIXTURES. No real credential exists in
 * this repository, and no number here is approved commercial data.
 */

const FIXTURE_SECRET = 'isolation-fixture-billing-webhook-secret-000000';

let app: PrismaClient;
let platform: PrismaClient;
let provider: DevelopmentPaymentProvider;
let providers: ReadonlyMap<string, PaymentProviderAdapter>;
let policy: CommercePolicy;
let reconciler: BillingReconciler;
let ownerUserId: string;
let run: string;

const plans = readPlanCatalogue(PLANS_FIXTURE as unknown as Record<string, unknown>);

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  await createIsolationFixtures(app);

  run = crypto.randomUUID().slice(0, 8);
  provider = new DevelopmentPaymentProvider({
    webhookSecret: FIXTURE_SECRET,
    hostedBaseUrl: 'https://example.test/api',
  });
  providers = new Map<string, PaymentProviderAdapter>([[DEVELOPMENT_PROVIDER_KEY, provider]]);
  policy = commercePolicyFrom(CATALOGUE as unknown as Record<string, unknown>);
  reconciler = new BillingReconciler({
    providers,
    credits: creditLedgerPort(new CreditLedgerService({ prisma: platform })),
  });

  const owner = await platform.user.create({
    data: {
      email: `p9-owner-${run}@example.local`,
      name: 'Phase 9 Owner',
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
    },
  });
  ownerUserId = owner.id;
}, 120_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

// ---------------------------------------------------------------------------

/** Create a workspace through the REAL onboarding path, with explicit answers. */
async function createWorkspace(input: {
  country: string;
  currency: string;
  slug?: string;
}): Promise<string> {
  const created = await new WorkspaceOnboardingService().create(
    platform as unknown as TenantScopedClient,
    {
      ownerUserId,
      name: `Phase 9 ${input.currency}`,
      slug: input.slug ?? `p9-${input.currency.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
      country: input.country,
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: input.currency,
      billingEmail: `billing-${crypto.randomUUID().slice(0, 8)}@example.local`,
    },
    policy,
    findPlan(plans, 'fixture-starter'),
    null,
  );
  return created.workspaceId;
}

async function inTenant<T>(
  workspaceId: string,
  fn: (db: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return withWorkspace(workspaceId, fn, { prisma: app });
}

async function openSubscriptionCheckout(workspaceId: string, planKey = 'fixture-starter') {
  const plan = findPlan(plans, planKey);
  if (!plan) throw new Error('fixture plan missing');
  return inTenant(workspaceId, (db) =>
    new CheckoutService({ providers }).openSubscription(db, {
      workspaceId,
      policy,
      plan,
      billingInterval: 'MONTH',
      idempotencyKey: `checkout-${crypto.randomUUID()}`,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
      actorUserId: ownerUserId,
    }),
  );
}

async function deliver(event: DevelopmentEventInput, at = new Date()) {
  const signed = signedDelivery(provider, event, at);
  return reconciler.receive(platform, {
    providerKey: DEVELOPMENT_PROVIDER_KEY,
    raw: signed.body,
    headers: signed.headers,
    policy,
    plans,
    planVersionId: null,
  });
}

async function providerCustomerOf(workspaceId: string): Promise<string> {
  const profile = await platform.billingProfile.findFirstOrThrow({
    where: { workspaceId },
    select: { providerCustomerId: true },
  });
  return profile.providerCustomerId ?? '';
}

// ---------------------------------------------------------------------------

describe('a redirect is not a payment; a signed event is', () => {
  it('opens a PENDING checkout priced from configuration, and marks nothing paid', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);

    // 99.00 SAR + 15% exclusive VAT from the market's configured policy.
    expect(checkout.amount.toDecimalString()).toBe('99.00');
    expect(checkout.tax.toDecimalString()).toBe('14.85');
    expect(checkout.total.toDecimalString()).toBe('113.85');
    expect(checkout.status).toBe('PENDING');
    expect(checkout.redirectUrl).toContain('/billing/checkout/');

    // NOTHING IS PAID. No invoice exists, and the subscription is still the
    // trial the workspace was created with.
    const invoices = await inTenant(workspaceId, (db) =>
      db.invoice.count({ where: { workspaceId } }),
    );
    expect(invoices).toBe(0);
    const subscription = await platform.workspaceSubscription.findUnique({
      where: { workspaceId },
    });
    expect(subscription?.status).toBe('TRIALING');
  });

  it('completes the checkout, issues a NUMBERED invoice and activates the plan', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);

    const result = await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: await providerCustomerOf(workspaceId),
        amount: checkout.total,
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.accepted && result.results[0]?.outcome).toBe('PROCESSED');

    const invoice = await platform.invoice.findFirstOrThrow({ where: { workspaceId } });
    expect(invoice.status).toBe('PAID');
    // AN ISSUED INVOICE HAS A NUMBER, from the seller's own gapless series.
    expect(invoice.number).toMatch(/^BS-\d{4}-\d{6}$/);
    expect(invoice.totalMinor).toBe(11385n);
    expect(invoice.taxMinor).toBe(1485n);
    expect(invoice.amountPaidMinor).toBe(11385n);

    const lines = await platform.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    expect(lines).toHaveLength(1);
    // BOTH LANGUAGES, written at issue time.
    expect(lines[0]?.description).toMatchObject({ ar: expect.any(String), en: expect.any(String) });

    const subscription = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.planKey).toBe('fixture-starter');
    // THE PRICE IS PINNED, not read live (AC-04.7).
    expect(subscription.pinnedMonthlyMinor).toBe(9900);
  });

  it('prices a three-digit currency at three digits, all the way to the invoice', async () => {
    const workspaceId = await createWorkspace({ country: 'KW', currency: 'KWD' });
    const checkout = await openSubscriptionCheckout(workspaceId);

    // 7.900 KWD, and Kuwait's configured policy charges no tax.
    expect(checkout.amount.toDecimalString()).toBe('7.900');
    expect(checkout.tax.toDecimalString()).toBe('0.000');

    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: await providerCustomerOf(workspaceId),
        amount: checkout.total,
      }),
    );

    const invoice = await platform.invoice.findFirstOrThrow({ where: { workspaceId } });
    // THE SCALE IS STORED WITH THE AMOUNT. 7900 minor units is 7.900 KWD here
    // and would be 79.00 SAR elsewhere — the row says which.
    expect(invoice.currencyScale).toBe(3);
    expect(invoice.totalMinor).toBe(7900n);
    expect(
      Money.ofMinor(invoice.currency, invoice.totalMinor, invoice.currencyScale).toDecimalString(),
    ).toBe('7.900');
  });
});

describe('the reconciler refuses what it should refuse', () => {
  it('writes NOTHING at all for a forged signature', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);
    const before = await platform.billingEvent.count();

    const attacker = new DevelopmentPaymentProvider({
      webhookSecret: 'a-completely-different-fixture-secret',
      hostedBaseUrl: 'https://example.test/api',
    });
    const forged = signedDelivery(
      attacker,
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: await providerCustomerOf(workspaceId),
        amount: checkout.total,
      }),
    );

    const result = await reconciler.receive(platform, {
      providerKey: DEVELOPMENT_PROVIDER_KEY,
      raw: forged.body,
      headers: forged.headers,
      policy,
      plans,
      planVersionId: null,
    });

    expect(result.accepted).toBe(false);
    // NOT A ROW. An unauthenticated caller cannot make us store anything.
    expect(await platform.billingEvent.count()).toBe(before);
    const session = await platform.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(session.status).toBe('PENDING');
  });

  it('records a REPLAY as a duplicate and changes nothing', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);
    const event = paidCheckoutEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      checkoutSessionId: checkout.id,
      providerSessionId: checkout.providerSessionId ?? '',
      providerCustomerId: await providerCustomerOf(workspaceId),
      amount: checkout.total,
    });

    const first = await deliver(event);
    expect(first.accepted && first.results[0]?.outcome).toBe('PROCESSED');

    const second = await deliver(event);
    expect(second.accepted && second.results[0]?.outcome).toBe('DUPLICATE');

    // ONE invoice, one payment attempt. Not two of either.
    expect(await platform.invoice.count({ where: { workspaceId } })).toBe(1);
    expect(await platform.paymentAttempt.count({ where: { workspaceId } })).toBe(1);
    // And the inbox kept the ORIGINAL outcome rather than overwriting it.
    const row = await platform.billingEvent.findFirstOrThrow({
      where: { externalEventId: event.id },
    });
    expect(row.status).toBe('PROCESSED');
  });

  it('refuses an amount that is not the amount we priced, and audits it', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);

    const result = await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: await providerCustomerOf(workspaceId),
        // A customer who edited a form would look exactly like this.
        amount: Money.ofMinor('SAR', 1n, 2),
      }),
    );

    expect(result.accepted && result.results[0]?.outcome).toBe('FAILED');
    // The session is UNTOUCHED and no invoice exists.
    const session = await platform.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(session.status).toBe('PENDING');
    expect(await platform.invoice.count({ where: { workspaceId } })).toBe(0);

    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId, action: 'billing.reconcile.amount-mismatch' },
    });
    expect(audit?.severity).toBe('CRITICAL');
  });

  it('keeps an event it cannot tie to a workspace as UNRESOLVED, and guesses nothing', async () => {
    const result = await deliver({
      id: `evt_${crypto.randomUUID()}`,
      type: 'invoice.paid',
      data: {
        providerCustomerId: 'cus_nobody_has_this',
        providerInvoiceId: 'in_nobody_has_this',
        amountMinor: '11385',
        currency: 'SAR',
      },
    });
    expect(result.accepted && result.results[0]?.outcome).toBe('UNRESOLVED');
    expect(result.accepted && result.results[0]?.workspaceId).toBeNull();
  });

  it('refuses an event OLDER than the state it describes', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);
    const customer = await providerCustomerOf(workspaceId);

    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: customer,
        amount: checkout.total,
        occurredAt: new Date('2026-06-01T12:00:00.000Z'),
      }),
      new Date(),
    );

    // An UPDATE the provider says happened BEFORE the activation we already
    // applied. Applying it would wind the subscription backwards.
    const stale = await deliver({
      id: `evt_${crypto.randomUUID()}`,
      type: 'subscription.updated',
      occurredAt: new Date('2026-05-01T12:00:00.000Z'),
      data: { providerCustomerId: customer, cancelAtPeriodEnd: true },
    });

    expect(stale.accepted && stale.results[0]?.outcome).toBe('STALE');
    const subscription = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(subscription.cancelAtPeriodEnd).toBe(false);
  });
});

describe('prepaid credit packs — paid once, granted once (D-196)', () => {
  it('grants exactly the pack credits, once, however many events arrive', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const before = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });

    const checkout = await inTenant(workspaceId, (db) =>
      new CheckoutService({ providers }).openCreditPack(db, {
        workspaceId,
        policy,
        packKey: 'fixture-pack-small',
        idempotencyKey: `pack-${crypto.randomUUID()}`,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
        actorUserId: ownerUserId,
      }),
    );

    const customer = await providerCustomerOf(workspaceId);
    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: customer,
        amount: checkout.total,
      }),
    );

    const purchase = await platform.creditPackPurchase.findFirstOrThrow({ where: { workspaceId } });
    expect(purchase.status).toBe('COMPLETED');
    // THE CHECK CONSTRAINT MAKES THIS A DATABASE FACT: a COMPLETED purchase
    // cannot exist without naming the one grant it produced.
    expect(purchase.creditGrantId).not.toBeNull();

    const after = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(after.balanceMilliCredits - before.balanceMilliCredits).toBe(500_000n);

    // A SECOND, DIFFERENT event about the same checkout. The grant key is the
    // CHECKOUT, so nothing is granted twice.
    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: customer,
        amount: checkout.total,
      }),
    );
    const settled = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(settled.balanceMilliCredits).toBe(after.balanceMilliCredits);
    expect(await platform.creditPackPurchase.count({ where: { workspaceId } })).toBe(1);
  });
});

describe('invoices are corrected, never edited', () => {
  it('refuses a credit note larger than its invoice, and accepts one that fits', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);
    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: await providerCustomerOf(workspaceId),
        amount: checkout.total,
      }),
    );
    const invoice = await platform.invoice.findFirstOrThrow({ where: { workspaceId } });

    const notes = new CreditNoteService();
    const tooMuch = notes.issue(platform as unknown as TenantScopedClient, {
      workspaceId,
      invoiceId: invoice.id,
      policy,
      reason: 'Refund the whole thing twice over',
      idempotencyKey: `cn-${crypto.randomUUID()}`,
      lines: [
        {
          description: { ar: 'استرداد', en: 'Refund' },
          quantity: 1,
          amount: Money.ofMinor('SAR', invoice.totalMinor * 2n, 2),
          tax: Money.zero('SAR', 2),
        },
      ],
    });
    await expect(tooMuch).rejects.toThrow(/cannot exceed the invoice/i);

    const key = `cn-${crypto.randomUUID()}`;
    const note = await notes.issue(platform as unknown as TenantScopedClient, {
      workspaceId,
      invoiceId: invoice.id,
      policy,
      reason: 'Goodwill credit for the fixture',
      idempotencyKey: key,
      lines: [
        {
          description: { ar: 'إشعار دائن', en: 'Credit note' },
          quantity: 1,
          amount: Money.ofMinor('SAR', 1000n, 2),
          tax: Money.zero('SAR', 2),
        },
      ],
    });
    expect(note.status).toBe('ISSUED');
    expect(note.number).toMatch(/^BSCN-\d{4}-\d{6}$/);

    const updated = await platform.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updated.creditedMinor).toBe(1000n);
    // THE INVOICE ITSELF IS UNCHANGED. A correction is a second document.
    expect(updated.totalMinor).toBe(invoice.totalMinor);
    expect(updated.status).toBe('PAID');

    // A retried request with the same key returns the SAME note, not a second.
    const replay = await notes.issue(platform as unknown as TenantScopedClient, {
      workspaceId,
      invoiceId: invoice.id,
      policy,
      reason: 'Goodwill credit for the fixture',
      idempotencyKey: key,
      lines: [
        {
          description: { ar: 'إشعار دائن', en: 'Credit note' },
          quantity: 1,
          amount: Money.ofMinor('SAR', 1000n, 2),
          tax: Money.zero('SAR', 2),
        },
      ],
    });
    expect(replay.id).toBe(note.id);
    expect(await platform.creditNote.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });
});

describe('dunning starts one clock and does not restart it', () => {
  it('moves to PAST_DUE on the first failure and keeps the same start on the second', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openSubscriptionCheckout(workspaceId);
    const customer = await providerCustomerOf(workspaceId);
    await deliver(
      paidCheckoutEvent({
        eventId: `evt_${crypto.randomUUID()}`,
        checkoutSessionId: checkout.id,
        providerSessionId: checkout.providerSessionId ?? '',
        providerCustomerId: customer,
        amount: checkout.total,
      }),
    );

    const firstFailure = new Date('2026-07-01T00:00:00.000Z');
    await deliver({
      id: `evt_${crypto.randomUUID()}`,
      type: 'invoice.payment_failed',
      occurredAt: firstFailure,
      data: { providerCustomerId: customer, failureCode: 'card_declined' },
    });

    const afterFirst = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(afterFirst.status).toBe('PAST_DUE');
    expect(afterFirst.pastDueSince?.toISOString()).toBe(firstFailure.toISOString());

    await deliver({
      id: `evt_${crypto.randomUUID()}`,
      type: 'invoice.payment_failed',
      occurredAt: new Date('2026-07-03T00:00:00.000Z'),
      data: { providerCustomerId: customer, failureCode: 'insufficient_funds' },
    });

    const afterSecond = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    // THE CLOCK DID NOT RESTART. A later failure in the same episode cannot
    // extend the customer's grace period, nor shorten it.
    expect(afterSecond.pastDueSince?.toISOString()).toBe(firstFailure.toISOString());
    expect(await platform.paymentAttempt.count({ where: { workspaceId, status: 'FAILED' } })).toBe(
      2,
    );

    // A PROVIDER MESSAGE NEVER REACHES OUR ROWS as a failure reason.
    const attempts = await platform.paymentAttempt.findMany({
      where: { workspaceId, status: 'FAILED' },
      select: { failureCode: true },
    });
    for (const attempt of attempts) {
      expect(['card_declined', 'insufficient_funds', 'payment_failed']).toContain(
        attempt.failureCode,
      );
    }
  });

  it('cancels at period end without deleting anything', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const lifecycle = new SubscriptionLifecycleService();

    const endsAt = await lifecycle.cancelAtPeriodEnd(platform as unknown as TenantScopedClient, {
      workspaceId,
      actorUserId: ownerUserId,
      reason: 'Fixture cancellation',
    });
    expect(endsAt).toBeInstanceOf(Date);

    const subscription = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    // THE WORKSPACE AND ITS DATA ARE UNTOUCHED.
    expect(await platform.workspace.count({ where: { id: workspaceId } })).toBe(1);
    expect(await platform.creditWallet.count({ where: { workspaceId } })).toBe(1);

    await lifecycle.resume(platform as unknown as TenantScopedClient, workspaceId, ownerUserId);
    const resumed = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(resumed.cancelAtPeriodEnd).toBe(false);
  });
});

describe('workspace creation is independent from checkout availability', () => {
  it('creates a workspace in a country that has no configured commerce market', async () => {
    const workspaceId = await createWorkspace({ country: 'DE', currency: 'USD' });
    const workspace = await platform.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { country: true, currency: true },
    });
    expect(workspace).toMatchObject({ country: 'DE', currency: 'USD' });
  });

  it('creates before any payment-provider route exists', async () => {
    const noProviderPolicy = { ...policy, providerRouting: [] } as CommercePolicy;
    const created = await new WorkspaceOnboardingService().create(
      platform as unknown as TenantScopedClient,
      {
        ownerUserId,
        name: 'Pre-payment workspace',
        slug: `p9-no-provider-${crypto.randomUUID().slice(0, 8)}`,
        country: 'SA',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
        billingEmail: `billing-${crypto.randomUUID().slice(0, 8)}@example.local`,
      },
      noProviderPolicy,
      findPlan(plans, 'fixture-starter'),
      null,
    );
    expect(created.workspaceId).toBeTruthy();
  });

  it('still refuses an invalid timezone', async () => {
    await expect(
      new WorkspaceOnboardingService().create(
        platform as unknown as TenantScopedClient,
        {
          ownerUserId,
          name: 'Bad timezone',
          slug: `p9-bad-zone-${crypto.randomUUID().slice(0, 8)}`,
          country: 'SA',
          defaultLocale: 'EN',
          timezone: 'Not/A_Timezone',
          currency: 'USD',
          billingEmail: 'timezone@example.local',
        },
        policy,
        findPlan(plans, 'fixture-starter'),
        null,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      publicDetails: { field: 'timezone' },
    });
  });

  it('grants the trial and its credits exactly once, in the same transaction', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const subscription = await platform.workspaceSubscription.findUniqueOrThrow({
      where: { workspaceId },
    });
    expect(subscription.status).toBe('TRIALING');
    expect(subscription.trialStartedAt).not.toBeNull();

    const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(wallet.balanceMilliCredits).toBe(200_000n);

    const grants = await platform.creditGrant.findMany({
      where: { workspaceId, source: 'TRIAL_GRANT' },
    });
    expect(grants).toHaveLength(1);

    // THE IDEMPOTENCY KEY IS THE WORKSPACE, and it is unique in the database —
    // so a second trial grant is refused by PostgreSQL, not only by a check.
    await expect(
      platform.creditTransaction.create({
        data: {
          workspaceId,
          walletId: wallet.id,
          type: 'TRIAL_GRANT',
          amountMilliCredits: 200_000n,
          balanceAfterMilliCredits: 400_000n,
          idempotencyKey: `trial:${workspaceId}`,
          actorType: 'SYSTEM',
          reason: 'A second trial',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses an owner whose email is not verified', async () => {
    const unverified = await platform.user.create({
      data: {
        email: `p9-unverified-${crypto.randomUUID().slice(0, 8)}@example.local`,
        name: 'Unverified',
        status: 'ACTIVE',
        locale: 'EN',
        timezone: 'UTC',
      },
    });
    await expect(
      new WorkspaceOnboardingService().create(
        platform as unknown as TenantScopedClient,
        {
          ownerUserId: unverified.id,
          name: 'Unverified workspace',
          slug: `p9-unverified-${crypto.randomUUID().slice(0, 8)}`,
          country: 'SA',
          defaultLocale: 'EN',
          timezone: 'UTC',
          currency: 'SAR',
          billingEmail: 'nobody@example.local',
        },
        policy,
        findPlan(plans, 'fixture-starter'),
        null,
      ),
    ).rejects.toThrow(/Verify your email/i);
  });
});

describe('a plan with no price in this currency is unavailable, and says so', () => {
  it('refuses to open a checkout for it rather than converting one', async () => {
    const workspaceId = await createWorkspace({ country: 'KW', currency: 'KWD' });
    // `fixture-growth` deliberately has no KWD row.
    await expect(openSubscriptionCheckout(workspaceId, 'fixture-growth')).rejects.toThrow(
      /cannot be bought here/i,
    );
    expect(await platform.checkoutSession.count({ where: { workspaceId } })).toBe(0);
  });
});

describe('the invoice number series is gapless under concurrency', () => {
  it('gives twenty simultaneous issues twenty distinct numbers', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const invoices = new InvoiceService();

    const drafts = await Promise.all(
      Array.from({ length: 20 }, async () =>
        invoices.draft(platform as unknown as TenantScopedClient, {
          workspaceId,
          assessment: {
            mode: 'NONE',
            rateBasisPoints: 0,
            policyKey: null,
            subtotal: Money.ofMinor('SAR', 1000n, 2),
            tax: Money.zero('SAR', 2),
            total: Money.ofMinor('SAR', 1000n, 2),
          },
          lines: [
            {
              kind: 'SUBSCRIPTION',
              description: { ar: 'بند', en: 'Line' },
              quantity: 1,
              unitAmount: Money.ofMinor('SAR', 1000n, 2),
              amount: Money.ofMinor('SAR', 1000n, 2),
              tax: Money.zero('SAR', 2),
            },
          ],
          commercialSnapshot: {},
        }),
      ),
    );

    const issued = await Promise.all(
      drafts.map((draft) =>
        invoices.issue(platform as unknown as TenantScopedClient, {
          workspaceId,
          invoiceId: draft.id,
          policy,
        }),
      ),
    );

    const numbers = issued.map((invoice) => invoice.number);
    expect(new Set(numbers).size).toBe(20);
    for (const number of numbers) expect(number).toMatch(/^BS-\d{4}-\d{6}$/);
  }, 60_000);
});

/**
 * P0 — THE SETTLEMENT IS ATOMIC, AND AN UNSETTLED EVENT IS RETRYABLE.
 *
 * THE DEFECT. `BillingReconciler` opened no transaction. The webhook route
 * handed it a top-level client through `getPlatformClient() as never`, against
 * a parameter typed `TenantScopedClient` — a type whose entire meaning is "you
 * are already inside one" — and `creditLedgerPort` passed that straight to
 * `grantWithin`, the ledger method that assumes a caller-owned transaction. So
 * the checkout completion, the invoice, the purchase row, the credit
 * transaction, the grant bucket and the wallet update each autocommitted
 * separately, while two comments in the file asserted they committed together.
 *
 * A failure part-way left the customer charged and invoiced with NO credits, or
 * the ledger holding a transaction row whose bucket was never written. And it
 * was self-concealing: the inbox row was already written, so the provider's
 * redelivery answered DUPLICATE and nothing ever retried.
 *
 * These tests inject a failure in the middle of a real settlement, against a
 * real PostgreSQL, and assert both halves of the fix — nothing partial
 * survives, and the redelivery that follows settles cleanly.
 */
describe('settlement is atomic and recoverable (P0)', () => {
  /** A reconciler whose credit grant throws, to fail mid-settlement. */
  function failingReconciler(fail: () => boolean): BillingReconciler {
    const real = creditLedgerPort(new CreditLedgerService({ prisma: platform }));
    return new BillingReconciler({
      providers,
      credits: {
        async grantPackCredits(db, input) {
          // The invoice and the purchase row are already written by this point,
          // which is exactly the window that used to leave money without
          // entitlement.
          if (fail()) throw new Error('injected failure mid-settlement');
          return real.grantPackCredits(db, input);
        },
      },
    });
  }

  async function openPack(workspaceId: string) {
    return inTenant(workspaceId, (db) =>
      new CheckoutService({ providers }).openCreditPack(db, {
        workspaceId,
        policy,
        packKey: 'fixture-pack-small',
        idempotencyKey: `pack-${crypto.randomUUID()}`,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
        actorUserId: ownerUserId,
      }),
    );
  }

  it('a failure mid-settlement leaves no invoice, no purchase and no credits', async () => {
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const before = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    // A new workspace already carries its trial grant, so the question is the
    // DELTA across the failed settlement rather than an absolute count.
    const ledgerBefore = await platform.creditTransaction.count({ where: { workspaceId } });
    const checkout = await openPack(workspaceId);
    const customer = await providerCustomerOf(workspaceId);

    const event = paidCheckoutEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      checkoutSessionId: checkout.id,
      providerSessionId: checkout.providerSessionId ?? '',
      providerCustomerId: customer,
      amount: checkout.total,
    });
    const signed = signedDelivery(provider, event, new Date());

    const result = await failingReconciler(() => true).receive(platform, {
      providerKey: DEVELOPMENT_PROVIDER_KEY,
      raw: signed.body,
      headers: signed.headers,
      policy,
      plans,
      planVersionId: null,
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('unreachable');
    expect(result.results[0]?.outcome).toBe('FAILED');

    // NOTHING PARTIAL SURVIVED — the four things that used to.
    expect(await platform.invoice.count({ where: { workspaceId } })).toBe(0);
    expect(await platform.creditPackPurchase.count({ where: { workspaceId } })).toBe(0);
    expect(await platform.creditTransaction.count({ where: { workspaceId } })).toBe(ledgerBefore);

    const after = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(after.balanceMilliCredits).toBe(before.balanceMilliCredits);

    // And the checkout is still PENDING, so the purchase remains completable.
    const session = await platform.checkoutSession.findUniqueOrThrow({
      where: { id: checkout.id },
    });
    expect(session.status).toBe('PENDING');
  });

  it('the provider redelivery settles cleanly after a failed attempt', async () => {
    /*
     * THE HALF OF THE FIX THAT IS NOT ABOUT TRANSACTIONS. A `FAILED` or
     * `RECEIVED` inbox row means a delivery did not finish and nothing was
     * applied. Answering DUPLICATE to its redelivery, which is what this code
     * used to do, is how a half-settled purchase became permanent: charged,
     * nothing granted, and no retry anywhere in the system.
     */
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const before = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    const checkout = await openPack(workspaceId);
    const customer = await providerCustomerOf(workspaceId);

    const event = paidCheckoutEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      checkoutSessionId: checkout.id,
      providerSessionId: checkout.providerSessionId ?? '',
      providerCustomerId: customer,
      amount: checkout.total,
    });
    const signed = signedDelivery(provider, event, new Date());
    const delivery = {
      providerKey: DEVELOPMENT_PROVIDER_KEY,
      raw: signed.body,
      headers: signed.headers,
      policy,
      plans,
      planVersionId: null,
    };

    // First attempt fails mid-settlement.
    let shouldFail = true;
    const flaky = failingReconciler(() => shouldFail);
    const first = await flaky.receive(platform, delivery);
    expect(first.accepted && first.results[0]?.outcome).toBe('FAILED');

    // The SAME provider event, redelivered, with the injected fault cleared.
    shouldFail = false;
    const second = await flaky.receive(platform, delivery);
    expect(second.accepted && second.results[0]?.outcome).toBe('PROCESSED');

    // Settled exactly once.
    const purchase = await platform.creditPackPurchase.findFirstOrThrow({ where: { workspaceId } });
    expect(purchase.status).toBe('COMPLETED');
    expect(purchase.creditGrantId).not.toBeNull();

    const after = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(after.balanceMilliCredits - before.balanceMilliCredits).toBe(500_000n);
    expect(await platform.invoice.count({ where: { workspaceId } })).toBe(1);
  });

  it('a settled event is still answered DUPLICATE, and grants nothing further', async () => {
    // The retry semantics must not have cost the replay guard. A PROCESSED row
    // is proof of settlement; only RECEIVED and FAILED are not.
    const workspaceId = await createWorkspace({ country: 'SA', currency: 'SAR' });
    const checkout = await openPack(workspaceId);
    const customer = await providerCustomerOf(workspaceId);
    const event = paidCheckoutEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      checkoutSessionId: checkout.id,
      providerSessionId: checkout.providerSessionId ?? '',
      providerCustomerId: customer,
      amount: checkout.total,
    });

    const first = await deliver(event);
    expect(first.accepted && first.results[0]?.outcome).toBe('PROCESSED');

    const wallet = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });

    const replay = await deliver(event);
    expect(replay.accepted && replay.results[0]?.outcome).toBe('DUPLICATE');

    const after = await platform.creditWallet.findUniqueOrThrow({ where: { workspaceId } });
    expect(after.balanceMilliCredits).toBe(wallet.balanceMilliCredits);
    expect(await platform.creditPackPurchase.count({ where: { workspaceId } })).toBe(1);
    expect(await platform.invoice.count({ where: { workspaceId } })).toBe(1);
  });
});
