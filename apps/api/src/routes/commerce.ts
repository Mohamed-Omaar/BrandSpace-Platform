import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  activeMarkets,
  currenciesForCountry,
  findCurrency,
  packOffers,
  planAvailability,
  taxPolicyFor,
  type CommercePolicy,
  type PlanAvailability,
} from '@brandspace/billing';
import { findPlan } from '@brandspace/entitlements';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { AppError, type Money } from '@brandspace/shared';
import { route } from '../route-contract';
import { fail, resolveCaller } from './phase7-context';
import {
  checkoutService,
  commercePolicy,
  creditNoteService,
  invoiceService,
  planCatalogue,
  providerFor,
  subscriptionLifecycle,
} from './phase9-context';

/**
 * The customer's commercial surface — plans, checkout, invoices, packs.
 *
 * WHY IT IS HERE AND NOT IN THE DASHBOARD. Opening a checkout reads the
 * PLATFORM-owned commercial catalogue and calls a payment adapter; F-07 keeps
 * both out of tenant-facing apps. The same seam Brand Brain chat and the social
 * connectors already crossed.
 *
 * THE BROWSER NEVER SENDS AN AMOUNT. Every request below names a plan key, an
 * interval or a pack key. There is no field for a price anywhere in these
 * schemas, so a customer editing a form changes what they are BUYING and never
 * what they PAY — the amount is resolved from the activated catalogue,
 * server-side, and written down before the provider is called (§37).
 *
 * AND THE BROWSER NEVER CONFIRMS A PAYMENT. There is no route here that marks
 * anything paid. The success redirect lands on a status endpoint that reports
 * what reconciliation has actually established, which for a moment is
 * legitimately "we are waiting" — and saying so is the honest answer (§22).
 */

const READ = 'billing.read';
const MANAGE = 'billing.manage';

const openSubscriptionSchema = z.object({
  planKey: z.string().min(1).max(64),
  billingInterval: z.enum(['MONTH', 'YEAR']),
  /** The caller's own key, so a double-submitted form opens ONE session. */
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const openPackSchema = z.object({
  packKey: z.string().min(1).max(64),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const planChangeSchema = z.object({
  planKey: z.string().min(1).max(64),
  billingInterval: z.enum(['MONTH', 'YEAR']).default('MONTH'),
});

const cancelSchema = z.object({
  reason: z.string().min(4).max(500),
  /** CLAUDE.md §2.5: a high-impact action needs an explicit confirmation. */
  confirm: z.literal(true),
});

const idParamSchema = z.object({ id: z.string().uuid() });

/** Money on the wire: the amount, its currency AND its own scale. */
function money(value: Money): {
  minorUnits: string;
  currency: string;
  scale: number;
  display: string;
} {
  return {
    // A STRING. `bigint` has no JSON representation, and a number would
    // reintroduce the inexactness `Money` exists to remove.
    minorUnits: value.minorUnits.toString(),
    currency: value.currency,
    scale: value.scale,
    display: value.toDecimalString(),
  };
}

function availabilityJson(availability: PlanAvailability) {
  return {
    planKey: availability.planKey,
    available: availability.available,
    reason: availability.reason,
    monthly: availability.monthly ? money(availability.monthly) : null,
    annual: availability.annual ? money(availability.annual) : null,
  };
}

/** The workspace's own country and currency — never a request parameter. */
async function commercialContext(
  workspaceId: string,
): Promise<{ country: string; currency: string }> {
  const row = await withWorkspace(
    workspaceId,
    async (db) =>
      db.workspace.findUnique({
        where: { id: workspaceId },
        select: { country: true, currency: true },
      }),
    { prisma: getPrisma() },
  );
  if (!row) throw new AppError('NOT_FOUND', 'Workspace not found.');
  const profile = await withWorkspace(
    workspaceId,
    async (db) =>
      db.billingProfile.findFirst({ where: { workspaceId }, select: { country: true } }),
    { prisma: getPrisma() },
  );
  // The BILLING country decides tax and market; the workspace country is where
  // they operate. They are usually the same and are allowed not to be.
  return { country: profile?.country ?? row.country, currency: row.currency.toUpperCase() };
}

function scaleOf(policy: CommercePolicy, currency: string): number {
  return findCurrency(policy, currency)?.minorUnitDigits ?? 2;
}

export function registerCommerceRoutes(app: FastifyInstance): void {
  /**
   * The plans this workspace can actually buy, priced in its own currency.
   *
   * AN UNAVAILABLE PLAN IS RETURNED WITH ITS REASON rather than omitted. "We do
   * not sell this plan in your country" and "this plan has no price in your
   * currency" are different facts, and hiding both behind an empty list leaves
   * the customer unable to act on either (§21).
   */
  route(
    app,
    'GET',
    '/v1/commerce/plans',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      try {
        const [policy, catalogue, context] = await Promise.all([
          commercePolicy(),
          planCatalogue(),
          commercialContext(caller.workspaceId),
        ]);
        const taxPolicy = taxPolicyFor(policy, context.country);
        return await reply.send({
          country: context.country,
          currency: context.currency,
          tax: taxPolicy
            ? {
                key: taxPolicy.key,
                name: taxPolicy.name,
                mode: taxPolicy.mode,
                rateBasisPoints: taxPolicy.rateBasisPoints,
                taxIdLabel: taxPolicy.taxIdLabel,
                taxIdRequired: taxPolicy.taxIdRequired,
              }
            : null,
          plans: catalogue.plans.map((plan) => ({
            key: plan.key,
            name: { ar: plan.nameAr, en: plan.nameEn },
            description: { ar: plan.descriptionAr, en: plan.descriptionEn },
            tier: plan.tier,
            monthlyCredits: plan.monthlyCredits,
            trialDays: plan.trialDays,
            ...availabilityJson(planAvailability(policy, plan, context.country, context.currency)),
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.plans', error);
      }
    },
  );

  /** The prepaid packs on sale here, priced. Never an overage settlement (D-196). */
  route(
    app,
    'GET',
    '/v1/commerce/packs',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      try {
        const [policy, context] = await Promise.all([
          commercePolicy(),
          commercialContext(caller.workspaceId),
        ]);
        return await reply.send({
          currency: context.currency,
          packs: packOffers(policy, context.country, context.currency).map((offer) => ({
            key: offer.pack.key,
            name: offer.pack.name,
            description: offer.pack.description,
            credits: offer.pack.credits,
            expiryDays: offer.pack.expiryDays,
            price: money(offer.price),
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.packs', error);
      }
    },
  );

  /**
   * Open a hosted checkout for a plan.
   *
   * HIGH-IMPACT: it is the start of a payment, so it declares a confirmation
   * policy and writes an audit event (CLAUDE.md §2.5). It does not, and cannot,
   * complete one.
   */
  route(
    app,
    'POST',
    '/v1/commerce/checkout/subscription',
    { scope: 'workspace', permission: MANAGE, confirmation: 'required', idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      const parsed = openSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      try {
        const [policy, catalogue] = await Promise.all([commercePolicy(), planCatalogue()]);
        const plan = findPlan(catalogue.plans, parsed.data.planKey);
        if (!plan) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

        const view = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            checkoutService().openSubscription(db, {
              workspaceId: caller.workspaceId,
              policy,
              plan,
              billingInterval: parsed.data.billingInterval,
              planVersionId: catalogue.versionId,
              idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
              successUrl: returnUrl('success'),
              cancelUrl: returnUrl('cancelled'),
              actorUserId: caller.userId,
            }),
          { prisma: getPrisma() },
        );
        return await reply.send(checkoutJson(view));
      } catch (error: unknown) {
        return fail(reply, 'commerce.checkout.subscription', error);
      }
    },
  );

  /** Open a hosted checkout for a prepaid pack. */
  route(
    app,
    'POST',
    '/v1/commerce/checkout/pack',
    { scope: 'workspace', permission: MANAGE, confirmation: 'required', idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      const parsed = openPackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      try {
        const policy = await commercePolicy();
        const view = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            checkoutService().openCreditPack(db, {
              workspaceId: caller.workspaceId,
              policy,
              packKey: parsed.data.packKey,
              idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
              successUrl: returnUrl('success'),
              cancelUrl: returnUrl('cancelled'),
              actorUserId: caller.userId,
            }),
          { prisma: getPrisma() },
        );
        return await reply.send(checkoutJson(view));
      } catch (error: unknown) {
        return fail(reply, 'commerce.checkout.pack', error);
      }
    },
  );

  /**
   * What has actually happened to a checkout.
   *
   * THE SUCCESS REDIRECT LANDS HERE, and this reports `PENDING` until a verified
   * provider event says otherwise. That is not a gap in the implementation; it
   * is the only honest thing to say, and the UI shows a "confirming your
   * payment" state rather than a receipt (§22).
   */
  route(
    app,
    'GET',
    '/v1/commerce/checkout/:id',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      try {
        const view = await withWorkspace(
          caller.workspaceId,
          async (db) => checkoutService().get(db, caller.workspaceId, params.data.id),
          { prisma: getPrisma() },
        );
        // A checkout belonging to another workspace is a 404, shaped exactly
        // like an id that never existed (CLAUDE.md §2.1).
        if (!view) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        return await reply.send(checkoutJson(view));
      } catch (error: unknown) {
        return fail(reply, 'commerce.checkout.status', error);
      }
    },
  );

  /** The workspace's invoices — its own, and only ever its own. */
  route(
    app,
    'GET',
    '/v1/commerce/invoices',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      try {
        const rows = await withWorkspace(
          caller.workspaceId,
          async (db) => invoiceService().list(db, caller.workspaceId, { take: 50 }),
          { prisma: getPrisma() },
        );
        return await reply.send({
          invoices: rows.map((invoice) => ({
            id: invoice.id,
            number: invoice.number,
            status: invoice.status,
            issuedAt: invoice.issuedAt,
            paidAt: invoice.paidAt,
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            subtotal: money(invoice.subtotal),
            tax: money(invoice.tax),
            total: money(invoice.total),
            credited: money(invoice.credited),
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.invoices', error);
      }
    },
  );

  /** One invoice with its lines, in both languages, exactly as issued. */
  route(
    app,
    'GET',
    '/v1/commerce/invoices/:id',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      try {
        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const invoice = await invoiceService().get(db, caller.workspaceId, params.data.id);
            if (!invoice) return null;
            const notes = await creditNoteService().list(db, caller.workspaceId, params.data.id);
            return { ...invoice, notes };
          },
          { prisma: getPrisma() },
        );
        if (!result) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        return await reply.send({
          invoice: {
            id: result.invoice.id,
            number: result.invoice.number,
            status: result.invoice.status,
            issuedAt: result.invoice.issuedAt,
            paidAt: result.invoice.paidAt,
            taxMode: result.invoice.taxMode,
            taxRateBasisPoints: result.invoice.taxRateBasisPoints,
            subtotal: money(result.invoice.subtotal),
            discount: money(result.invoice.discount),
            tax: money(result.invoice.tax),
            total: money(result.invoice.total),
            credited: money(result.invoice.credited),
          },
          lines: result.lines.map((line) => ({
            id: line.id,
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unitAmount: money(line.unitAmount),
            amount: money(line.amount),
            tax: money(line.tax),
          })),
          creditNotes: result.notes.map((note) => ({
            id: note.id,
            number: note.number,
            status: note.status,
            reason: note.reason,
            issuedAt: note.issuedAt,
            total: money(note.total),
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.invoice', error);
      }
    },
  );

  /** The current subscription, its dunning state and any scheduled change. */
  route(
    app,
    'GET',
    '/v1/commerce/subscription',
    { scope: 'workspace', permission: READ },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, READ);
      if (!caller) return;
      try {
        const [policy, context] = await Promise.all([
          commercePolicy(),
          commercialContext(caller.workspaceId),
        ]);
        const view = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            subscriptionLifecycle().get(db, caller.workspaceId, scaleOf(policy, context.currency)),
          { prisma: getPrisma() },
        );
        if (!view) return await reply.send({ subscription: null });
        return await reply.send({
          subscription: {
            planKey: view.planKey,
            status: view.status,
            billingInterval: view.billingInterval,
            currency: view.currency,
            monthly: money(view.monthly),
            annual: money(view.annual),
            currentPeriodStart: view.currentPeriodStart,
            currentPeriodEnd: view.currentPeriodEnd,
            trialEndsAt: view.trialEndsAt,
            pendingPlanKey: view.pendingPlanKey,
            pendingPlanEffectiveAt: view.pendingPlanEffectiveAt,
            cancelAtPeriodEnd: view.cancelAtPeriodEnd,
            pastDueSince: view.pastDueSince,
            graceEndsAt: view.graceEndsAt,
            suspendedAt: view.suspendedAt,
          },
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription', error);
      }
    },
  );

  /**
   * What a plan change would do — BEFORE it happens.
   *
   * §26: a commercial action a customer cannot predict is not consent, whatever
   * they clicked. This states the direction, the effective date and the amount
   * due now, in their own currency.
   */
  route(
    app,
    'POST',
    '/v1/commerce/subscription/preview',
    { scope: 'workspace', permission: MANAGE, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      const parsed = planChangeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const [policy, catalogue, context] = await Promise.all([
          commercePolicy(),
          planCatalogue(),
          commercialContext(caller.workspaceId),
        ]);
        const target = findPlan(catalogue.plans, parsed.data.planKey);
        if (!target) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });

        const preview = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const current = await db.workspaceSubscription.findUnique({
              where: { workspaceId: caller.workspaceId },
              select: { planKey: true },
            });
            const currentPlan = findPlan(catalogue.plans, current?.planKey ?? null);
            if (!currentPlan) throw new AppError('NOT_FOUND', 'This workspace has no plan.');
            return subscriptionLifecycle().previewChange(db, {
              workspaceId: caller.workspaceId,
              policy,
              current: currentPlan,
              target,
              billingInterval: parsed.data.billingInterval,
              country: context.country,
              currency: context.currency,
            });
          },
          { prisma: getPrisma() },
        );

        return await reply.send({
          fromPlanKey: preview.fromPlanKey,
          toPlanKey: preview.toPlanKey,
          direction: preview.direction,
          effectiveAt: preview.effectiveAt,
          requiresPayment: preview.requiresPayment,
          amountDueNow: preview.amountDueNow ? money(preview.amountDueNow) : null,
        });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription.preview', error);
      }
    },
  );

  /**
   * Schedule a downgrade for the end of the paid period.
   *
   * NOTHING IS REMOVED NOW. The customer keeps everything until the period they
   * paid for ends, and can withdraw the change until then (D-12, §38).
   */
  route(
    app,
    'POST',
    '/v1/commerce/subscription/downgrade',
    { scope: 'workspace', permission: MANAGE, confirmation: 'required', idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      const parsed = planChangeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const catalogue = await planCatalogue();
        if (!findPlan(catalogue.plans, parsed.data.planKey)) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        }
        await withWorkspace(
          caller.workspaceId,
          async (db) =>
            subscriptionLifecycle().scheduleDowngrade(db, {
              workspaceId: caller.workspaceId,
              targetPlanKey: parsed.data.planKey,
              actorUserId: caller.userId,
            }),
          { prisma: getPrisma() },
        );
        return await reply.send({ scheduled: true });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription.downgrade', error);
      }
    },
  );

  /** Withdraw a scheduled downgrade. */
  route(
    app,
    'POST',
    '/v1/commerce/subscription/downgrade/cancel',
    { scope: 'workspace', permission: MANAGE, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      try {
        await withWorkspace(
          caller.workspaceId,
          async (db) =>
            subscriptionLifecycle().clearPendingChange(db, caller.workspaceId, caller.userId),
          { prisma: getPrisma() },
        );
        return await reply.send({ cleared: true });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription.downgrade.cancel', error);
      }
    },
  );

  /**
   * Cancel at period end.
   *
   * CANCELLING IS NOT DELETING (§38). Access runs to the end of the paid period,
   * the workspace's data stays, and export remains available. The confirmation
   * is explicit because the action is high-impact (CLAUDE.md §2.5).
   */
  route(
    app,
    'POST',
    '/v1/commerce/subscription/cancel',
    { scope: 'workspace', permission: MANAGE, confirmation: 'required', idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      try {
        const endsAt = await withWorkspace(
          caller.workspaceId,
          async (db) =>
            subscriptionLifecycle().cancelAtPeriodEnd(db, {
              workspaceId: caller.workspaceId,
              actorUserId: caller.userId,
              reason: parsed.data.reason,
            }),
          { prisma: getPrisma() },
        );
        return await reply.send({ cancelAtPeriodEnd: true, endsAt, dataRetained: true });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription.cancel', error);
      }
    },
  );

  /** Change their mind, any time before the period ends. */
  route(
    app,
    'POST',
    '/v1/commerce/subscription/resume',
    { scope: 'workspace', permission: MANAGE, idempotent: true },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, MANAGE);
      if (!caller) return;
      try {
        await withWorkspace(
          caller.workspaceId,
          async (db) => subscriptionLifecycle().resume(db, caller.workspaceId, caller.userId),
          { prisma: getPrisma() },
        );
        return await reply.send({ resumed: true });
      } catch (error: unknown) {
        return fail(reply, 'commerce.subscription.resume', error);
      }
    },
  );

  /** Every country and currency combination the platform is configured to sell. */
  route(app, 'GET', '/v1/commerce/markets', { scope: 'public' }, async (_req, reply) => {
    try {
      const policy = await commercePolicy();
      return await reply.send({
        // NO DEFAULT AND NO SUGGESTION (D-194). A list, in the owner's order,
        // for the customer to choose from.
        markets: activeMarkets(policy).map((market) => ({
          country: market.country,
          name: market.name,
          currencies: currenciesForCountry(policy, market.country).map((currency) => ({
            code: currency.code,
            name: currency.name,
            minorUnitDigits: currency.minorUnitDigits,
          })),
        })),
      });
    } catch (error: unknown) {
      return fail(reply, 'commerce.markets', error);
    }
  });
}

function checkoutJson(view: {
  id: string;
  status: string;
  purpose: string;
  planKey: string | null;
  packKey: string | null;
  amount: Money;
  tax: Money;
  total: Money;
  redirectUrl: string | null;
  expiresAt: Date;
}) {
  return {
    id: view.id,
    status: view.status,
    purpose: view.purpose,
    planKey: view.planKey,
    packKey: view.packKey,
    amount: money(view.amount),
    tax: money(view.tax),
    total: money(view.total),
    redirectUrl: view.redirectUrl,
    expiresAt: view.expiresAt,
  };
}

/**
 * Where the provider sends the browser back.
 *
 * NAVIGATION ONLY, and it carries no claim about the outcome — the landing page
 * asks the status endpoint, which answers from reconciled state. Built from the
 * environment so a new deployment is a variable rather than a code change.
 */
function returnUrl(outcome: 'success' | 'cancelled'): string {
  const base = process.env['PUBLIC_DASHBOARD_BASE_URL'];
  if (!base) {
    throw new AppError(
      'INTERNAL',
      'PUBLIC_DASHBOARD_BASE_URL is required to build a checkout return URL.',
    );
  }
  return `${base.replace(/\/+$/, '')}/billing/checkout/${outcome}`;
}

/** Exposed so the hosted development page can resolve its own adapter. */
export { providerFor };
