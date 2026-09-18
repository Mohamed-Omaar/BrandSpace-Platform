import { ConfigurationService } from '@brandspace/config';
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
  type CommercePolicy,
  type PaymentProviderAdapter,
  type ProviderRegistry,
} from '@brandspace/billing';
import { CreditLedgerService, readPlanCatalogue, type PlanDetail } from '@brandspace/entitlements';
import { onboardingPolicyFrom, type OnboardingPolicy } from '@brandspace/onboarding';
import { getPlatformClient } from '@brandspace/database/platform';
import { currentEnvironment } from './phase7-context';

/**
 * The shared plumbing every Phase 9 route needs.
 *
 * ONE PROVIDER REGISTRY FOR THE PROCESS, and exactly one adapter in it: the
 * DEVELOPMENT one. D-204 leaves the production provider to the owner, so
 * registering a real one here would be the decision that decision withheld. The
 * registry is a map rather than a constant precisely so adding one later is a
 * registration, not a rewrite — every route below already speaks only the
 * adapter contract.
 *
 * THE SIGNING SECRET COMES FROM THE ENVIRONMENT AND IS REQUIRED. A deployment
 * that forgot it fails closed here rather than signing loopback events with a
 * value anybody can read in this file.
 *
 * WHICH IDENTITY DOES WHAT. Reading the commercial catalogue and receiving a
 * webhook are PLATFORM operations: the catalogue is platform-owned, and an event
 * arrives before anyone knows whose it is. Everything that touches tenant data
 * on a customer's request runs under `withWorkspace` on the tenant pool, where
 * RLS constrains it — the same seam every phase since Phase 5 has used (F-07).
 */

let cachedProviders: ProviderRegistry | null = null;

export function providerRegistry(): ProviderRegistry {
  if (cachedProviders) return cachedProviders;

  const secret = process.env['BILLING_DEV_WEBHOOK_SECRET'];
  if (!secret) {
    throw new Error(
      'BILLING_DEV_WEBHOOK_SECRET is required to sign and verify development billing events. ' +
        'It is NOT a payment credential — no production provider is configured (D-204).',
    );
  }
  const base = process.env['PUBLIC_API_BASE_URL'];
  if (!base) {
    throw new Error(
      'PUBLIC_API_BASE_URL is required to build the hosted checkout URL. ' +
        'Set it per environment; it is never hard-coded.',
    );
  }

  const adapters = new Map<string, PaymentProviderAdapter>();
  adapters.set(
    DEVELOPMENT_PROVIDER_KEY,
    new DevelopmentPaymentProvider({ webhookSecret: secret, hostedBaseUrl: base }),
  );
  cachedProviders = adapters;
  return cachedProviders;
}

export function providerFor(key: string): PaymentProviderAdapter | null {
  return providerRegistry().get(key) ?? null;
}

let cachedConfiguration: ConfigurationService | null = null;

function configuration(): ConfigurationService {
  cachedConfiguration ??= new ConfigurationService({ prisma: getPlatformClient() });
  return cachedConfiguration;
}

/**
 * The activated commercial catalogue.
 *
 * READ PER REQUEST, not cached. An owner activating a new price must take effect
 * on the next checkout, and a cache with no invalidation is how a customer gets
 * charged yesterday's number.
 */
export async function commercePolicy(): Promise<CommercePolicy> {
  const document = await configuration().get('commerce', currentEnvironment());
  return commercePolicyFrom(document as Record<string, unknown>);
}

export async function onboardingPolicy(): Promise<OnboardingPolicy> {
  const document = await configuration().get('onboarding', currentEnvironment());
  return onboardingPolicyFrom(document as Record<string, unknown>);
}

export interface PlanCatalogue {
  readonly plans: readonly PlanDetail[];
  /** Which activated `plans` version the prices came from, pinned on purchase. */
  readonly versionId: string | null;
}

export async function planCatalogue(): Promise<PlanCatalogue> {
  const environment = currentEnvironment();
  const document = await configuration().get('plans', environment);
  const versionId = await configuration().activeVersionId('plans', environment);
  return {
    plans: readPlanCatalogue(document as Record<string, unknown>),
    versionId,
  };
}

export function checkoutService(): CheckoutService {
  return new CheckoutService({ providers: providerRegistry() });
}

export function invoiceService(): InvoiceService {
  return new InvoiceService();
}

export function creditNoteService(): CreditNoteService {
  return new CreditNoteService();
}

export function subscriptionLifecycle(): SubscriptionLifecycleService {
  return new SubscriptionLifecycleService();
}

/**
 * The reconciler, holding the ONE narrow door into the credit ledger.
 *
 * The ledger runs on the platform client here because reconciliation does:
 * the inbox is platform-owned and invoice numbering is refused to the tenant
 * role. Nothing about the accounting changes — the same rows, the same
 * idempotency keys, the same invariants.
 */
export function reconciler(): BillingReconciler {
  return new BillingReconciler({
    providers: providerRegistry(),
    credits: creditLedgerPort(new CreditLedgerService({ prisma: getPlatformClient() })),
  });
}

/** Test seam: forget the process-wide registry. */
export function resetPhase9Context(): void {
  cachedProviders = null;
  cachedConfiguration = null;
}
