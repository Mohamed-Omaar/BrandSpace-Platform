import 'server-only';
import {
  InvoiceService,
  SubscriptionLifecycleService,
  TenantCommercePolicySource,
  findCurrency,
  packOffers,
  planAvailability,
  taxPolicyFor,
  type CommercePolicy,
  type CreditNoteView,
  type InvoiceView,
  type PackOffer,
  type PlanAvailability,
  type TaxPolicyDetail,
} from '@brandspace/billing';
import { CreditNoteService } from '@brandspace/billing';
import {
  TenantCatalogueSource,
  readPlanCatalogue,
  type PlanDetail,
} from '@brandspace/entitlements';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { currentEnvironment, inWorkspace } from './customer-context';
import {
  TenantOnboardingPolicySource,
  onboardingStateFor,
  type OnboardingPolicy,
  type OnboardingState,
} from '@brandspace/onboarding';

/**
 * The commercial facts a customer screen needs, read on the TENANT identity.
 *
 * EVERYTHING HERE COMES THROUGH THE PROJECTION, never `configuration_version`.
 * That table is platform-owned and the tenant role has no privilege on it; the
 * `entitlement_catalogue_snapshot` rows the Configuration Service writes on
 * activation are what the customer application reads. Two sources for one answer
 * is how a price appears one way on this screen and another way at checkout.
 *
 * AND NOTHING HERE OPENS A CHECKOUT. Opening one calls a payment adapter, which
 * F-07 keeps out of this app entirely — the browser posts to `apps/api` through
 * the proxy, and this file only ever reads.
 */

export interface CommerceSnapshot {
  readonly policy: CommercePolicy;
  readonly plans: readonly PlanDetail[];
  readonly country: string;
  readonly currency: string;
  readonly currencyScale: number;
  readonly tax: TaxPolicyDetail | null;
  readonly availability: readonly PlanAvailability[];
  readonly packs: readonly PackOffer[];
}

/** The workspace's own commercial answers — never a query parameter. */
export async function commerceSnapshotFor(workspaceId: string): Promise<CommerceSnapshot> {
  return inWorkspace(workspaceId, async ({ db }) => {
    const scoped = db as unknown as PrismaClient;
    const [workspace, profile] = await Promise.all([
      db.workspace.findUnique({
        where: { id: workspaceId },
        select: { country: true, currency: true },
      }),
      db.billingProfile.findFirst({ where: { workspaceId }, select: { country: true } }),
    ]);

    const policy = await new TenantCommercePolicySource(db, currentEnvironment()).load();
    const catalogue = await new TenantCatalogueSource(scoped, currentEnvironment()).load('plans');
    const plans = readPlanCatalogue(catalogue);

    // The BILLING country decides the market and the tax rule; the workspace
    // country is where the customer operates. They usually match, and are
    // allowed not to.
    const country = profile?.country ?? workspace?.country ?? '';
    const currency = (workspace?.currency ?? '').toUpperCase();

    return {
      policy,
      plans,
      country,
      currency,
      currencyScale: findCurrency(policy, currency)?.minorUnitDigits ?? 2,
      tax: taxPolicyFor(policy, country),
      availability: plans.map((plan) => planAvailability(policy, plan, country, currency)),
      packs: packOffers(policy, country, currency),
    };
  });
}

export interface BillingOverview {
  readonly subscription: Awaited<ReturnType<SubscriptionLifecycleService['get']>>;
  readonly invoices: readonly InvoiceView[];
  readonly creditNotes: readonly CreditNoteView[];
}

export async function billingOverviewFor(
  workspaceId: string,
  currencyScale: number,
): Promise<BillingOverview> {
  return inWorkspace(workspaceId, async ({ db }) => ({
    subscription: await new SubscriptionLifecycleService().get(db, workspaceId, currencyScale),
    invoices: await new InvoiceService().list(db, workspaceId, { take: 25 }),
    creditNotes: await new CreditNoteService().list(db, workspaceId),
  }));
}

export async function invoiceDetailFor(workspaceId: string, invoiceId: string) {
  return inWorkspace(workspaceId, async ({ db }) => {
    const detail = await new InvoiceService().get(db, workspaceId, invoiceId);
    if (!detail) return null;
    const notes = await new CreditNoteService().list(db, workspaceId, invoiceId);
    return { ...detail, creditNotes: notes };
  });
}

/** One checkout's reconciled state — what the landing page reports (§22). */
export async function checkoutStateFor(workspaceId: string, checkoutSessionId: string) {
  return inWorkspace(workspaceId, async ({ db }: { db: TenantScopedClient }) =>
    db.checkoutSession.findFirst({
      where: { workspaceId, id: checkoutSessionId },
      select: {
        id: true,
        status: true,
        purpose: true,
        planKey: true,
        packKey: true,
        currency: true,
        currencyScale: true,
        totalMinor: true,
        expiresAt: true,
      },
    }),
  );
}

export async function onboardingFor(
  workspaceId: string,
): Promise<{ policy: OnboardingPolicy; state: OnboardingState }> {
  return inWorkspace(workspaceId, async ({ db }) => {
    const policy = await new TenantOnboardingPolicySource(db, currentEnvironment()).load();
    return { policy, state: await onboardingStateFor(db, workspaceId, policy) };
  });
}
