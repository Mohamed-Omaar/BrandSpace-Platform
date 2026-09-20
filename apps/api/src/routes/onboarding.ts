import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CustomerAuthService } from '@brandspace/auth';
import { WorkspaceOnboardingService, onboardingStateFor } from '@brandspace/onboarding';
import { findPlan } from '@brandspace/entitlements';
import { DEFAULT_BILLING_CURRENCY, isIsoCountryCode } from '@brandspace/shared';
import { getPrisma, withWorkspace } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { route } from '../route-contract';
import { fail, resolveCaller, sessionTokenFrom } from './phase7-context';
import { commercePolicy, onboardingPolicy, planCatalogue } from './phase9-context';

/**
 * Creating the first workspace, and reporting where the customer has got to.
 *
 * Country, interface locale and timezone are explicit customer answers. Country
 * is validated against the complete ISO inventory rather than the subset with a
 * payment route. Billing currency is deliberately not a customer-facing answer
 * at launch: the API assigns the platform default (USD) so every entry surface
 * behaves the same way.
 *
 * THE PROGRESS ENDPOINT DERIVES, IT DOES NOT REMEMBER. There is no stored step
 * counter to drift from reality — see packages/onboarding/src/state.ts for why
 * that matters more than it sounds.
 */

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(3).max(50),
  type: z.enum(['STARTUP', 'SME', 'ENTERPRISE', 'CREATOR', 'AGENCY']).optional(),
  /** ISO 3166-1 alpha-2, chosen from the complete country inventory. */
  country: z.string().trim().toUpperCase().refine(isIsoCountryCode, 'Choose a valid country.'),
  defaultLocale: z.enum(['AR', 'EN']),
  timezone: z.string().min(1).max(64),
  // Billing currency is a platform launch default, not a customer-facing choice.
  billingEmail: z.string().min(3).max(320),
  legalName: z.string().max(200).optional(),
});

export function registerOnboardingRoutes(app: FastifyInstance): void {
  /**
   * Create the first workspace.
   *
   * ON THE PLATFORM CONNECTION, because `workspace` carries FORCE ROW LEVEL
   * SECURITY and the row being inserted IS the tenant that would authorise it.
   * The CALLER is still an authenticated customer, and the service refuses any
   * owner whose email is unverified — every invoice and every recovery path is
   * addressed to it.
   */
  route(
    app,
    'POST',
    '/v1/onboarding/workspace',
    { scope: 'public', idempotent: false },
    async (req, reply) => {
      const token = sessionTokenFrom(req);
      if (!token) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      const auth = new CustomerAuthService({ prisma: getPrisma() });
      const customer = await auth.resolve(token).catch(() => null);
      if (!customer) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });

      const parsed = createWorkspaceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: {
            code: 'VALIDATION_FAILED',
            details: {
              fields: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
            },
          },
        });
      }

      try {
        const [commerce, catalogue] = await Promise.all([commercePolicy(), planCatalogue()]);

        /*
         * WHICH PLAN OFFERS THE TRIAL IS A CONFIGURATION FACT. The lowest-tier
         * active plan with a trial. The service only starts it when that plan
         * has a price in the platform default currency; otherwise the workspace
         * is created without a
         * trial rather than with an invented one.
         */
        const trialPlan =
          [...catalogue.plans]
            .filter((plan) => plan.status === 'active' && plan.trialDays > 0)
            .sort((a, b) => a.tier - b.tier)[0] ?? null;

        const created = await new WorkspaceOnboardingService().create(
          getPlatformClient() as never,
          {
            ownerUserId: customer.userId,
            name: parsed.data.name,
            slug: parsed.data.slug,
            ...(parsed.data.type ? { type: parsed.data.type } : {}),
            country: parsed.data.country,
            defaultLocale: parsed.data.defaultLocale,
            timezone: parsed.data.timezone,
            currency: DEFAULT_BILLING_CURRENCY,
            billingEmail: parsed.data.billingEmail,
            legalName: parsed.data.legalName ?? null,
            ip: req.ip || undefined,
            userAgent: userAgentOf(req),
          },
          commerce,
          trialPlan,
          catalogue.versionId,
        );

        // Put the new workspace in scope for this session, so the customer lands
        // inside it rather than on a selector with one entry.
        await auth.switchWorkspace(token, created.workspaceId).catch(() => null);

        return await reply.send({
          workspaceId: created.workspaceId,
          slug: created.slug,
          trialPlanKey: created.trialPlanKey,
          trialEndsAt: created.trialEndsAt,
          trialCredits: created.trialCredits,
        });
      } catch (error: unknown) {
        return fail(reply, 'onboarding.workspace', error);
      }
    },
  );

  /**
   * Where this workspace has got to.
   *
   * EVERY STEP IS A QUESTION ASKED OF THE DATA, so closing the tab, signing in
   * elsewhere or doing a step outside the wizard all produce the right answer.
   */
  route(
    app,
    'GET',
    '/v1/onboarding/state',
    { scope: 'workspace', permission: 'workspace.read' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, 'workspace.read');
      if (!caller) return;
      try {
        const policy = await onboardingPolicy();
        const state = await withWorkspace(
          caller.workspaceId,
          async (db) => onboardingStateFor(db, caller.workspaceId, policy),
          { prisma: getPrisma() },
        );
        return await reply.send(state);
      } catch (error: unknown) {
        return fail(reply, 'onboarding.state', error);
      }
    },
  );

  /**
   * The trial's terms, stated plainly before it starts (§14).
   *
   * WHAT HAPPENS WHEN IT ENDS is part of the offer, not a surprise: the trial
   * expires, access to paid features stops, and nothing is deleted.
   */
  route(app, 'GET', '/v1/onboarding/trial', { scope: 'public' }, async (_req, reply) => {
    try {
      const catalogue = await planCatalogue();
      const trialPlan =
        [...catalogue.plans]
          .filter((plan) => plan.status === 'active' && plan.trialDays > 0)
          .sort((a, b) => a.tier - b.tier)[0] ?? null;
      if (!trialPlan) return await reply.send({ offered: false });
      return await reply.send({
        offered: true,
        planKey: trialPlan.key,
        name: { ar: trialPlan.nameAr, en: trialPlan.nameEn },
        days: trialPlan.trialDays,
        credits: trialPlan.trialCredits,
        // D-09: no card up front. Stated rather than implied.
        requiresCard: trialPlan.trialRequiresCard,
        endsWith: 'expires_without_deletion',
      });
    } catch (error: unknown) {
      return fail(reply, 'onboarding.trial', error);
    }
  });

  /** A plan by key, for the onboarding plan step. Availability included. */
  route(
    app,
    'GET',
    '/v1/onboarding/plan/:planKey',
    { scope: 'workspace', permission: 'billing.read' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, 'billing.read');
      if (!caller) return;
      const params = z.object({ planKey: z.string().min(1).max(64) }).safeParse(req.params);
      if (!params.success) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      try {
        const catalogue = await planCatalogue();
        const plan = findPlan(catalogue.plans, params.data.planKey);
        if (!plan) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
        return await reply.send({
          key: plan.key,
          name: { ar: plan.nameAr, en: plan.nameEn },
          tier: plan.tier,
          monthlyCredits: plan.monthlyCredits,
        });
      } catch (error: unknown) {
        return fail(reply, 'onboarding.plan', error);
      }
    },
  );
}

function userAgentOf(req: FastifyRequest): string | undefined {
  const value = req.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 512) : undefined;
}
