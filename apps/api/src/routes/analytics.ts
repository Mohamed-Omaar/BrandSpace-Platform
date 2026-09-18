import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AnalyticsInsightService,
  AnalyticsQueryService,
  TenantAnalyticsPolicySource,
  createAnalyticsRegistry,
} from '@brandspace/analytics';
import { LearningWriteBackService, StrategyService } from '@brandspace/intelligence';
import { BrandKnowledgeService } from '@brandspace/brand-brain';
import { resolveContentExpiry, resolveContentPolicy } from '@brandspace/content';
import { withWorkspace, getPrisma } from '@brandspace/database';
import { brandInScope, systemClock } from '@brandspace/shared';
import { route } from '../route-contract';
import {
  currentEnvironment,
  configurationService,
  fail,
  gateway,
  insightDenialSink,
  periodFromDays,
  previousPeriod,
  resolveCaller,
  workspaceFacts,
  type Caller,
} from './phase7-context';

/**
 * GROUNDED AI INSIGHTS AND STRATEGY — the customer-initiated surface.
 *
 * WHY IT LIVES HERE AND NOT IN THE DASHBOARD: the same seam Brand Brain chat and
 * the Content Studio already cross. Each of these routes calls the AI Gateway,
 * which reads platform-owned `ai.*` configuration and settles credits in its own
 * transactions — so it needs the PLATFORM identity, and F-07 forbids the
 * customer dashboard from holding it.
 *
 * WHAT IS *NOT* HERE, deliberately: reading analytics. Charts, totals, series,
 * top posts and the export all run in the dashboard on the TENANT identity,
 * because none of them touches the gateway. Routing a read through this service
 * would move tenant queries onto a process that also holds the platform pool for
 * no reason at all.
 */

const EXPLAIN_PERMISSION = 'analytics.explain';
const STRATEGY_READ = 'strategy.read';
const STRATEGY_MANAGE = 'strategy.manage';

const explainSchema = z.object({
  brandId: z.string().uuid(),
  periodDays: z.number().int().min(1).max(400).default(28),
  compareToPrevious: z.boolean().default(true),
  campaignId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

const strategySchema = z.object({
  brandId: z.string().uuid(),
  objective: z.string().min(1).max(400),
  periodDays: z.number().int().min(1).max(400).default(90),
  idempotencyKey: z.string().min(8).max(200),
});

const reviewSchema = z.object({
  insightId: z.string().uuid(),
  decision: z.enum(['accept', 'dismiss', 'seen']),
  reason: z.string().max(400).optional(),
});

const writeBackSchema = z.object({ insightId: z.string().uuid() });

/** A brand outside the caller's scope, or absent: the same 404. */
async function brandIsVisible(caller: Caller, brandId: string): Promise<boolean> {
  // BEFORE the query. A scoped-out brand must be indistinguishable from one that
  // does not exist, and a read that happens first is a read that happened (F-74).
  if (!brandInScope(caller.brandScope, brandId)) return false;
  return withWorkspace(
    caller.workspaceId,
    async (db) =>
      (await db.brand.findFirst({
        where: { id: brandId, deletedAt: null },
        select: { id: true },
      })) !== null,
    { prisma: getPrisma() },
  );
}

export function registerAnalyticsRoutes(app: FastifyInstance): void {
  /**
   * `analytics.explain` — a grounded explanation of real, stored metrics.
   *
   * IT SPENDS CREDITS, so it needs its own permission rather than riding on
   * `analytics.read`: every other analytics capability is free and this one moves
   * money, which is the distinction the content permissions were split on.
   *
   * A REFUSAL FOR LACK OF EVIDENCE IS A 200, not an error. "There is not enough
   * data yet" is an ANSWER — the honest one — and the response says so with the
   * counts, so the screen can explain rather than showing a failure.
   */
  route(
    app,
    'POST',
    '/v1/analytics/explain',
    {
      scope: 'workspace',
      permission: EXPLAIN_PERMISSION,
      rateLimit: 'ai.generate',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, EXPLAIN_PERMISSION);
      if (!caller) return;

      const parsed = explainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      const body = parsed.data;
      if (!(await brandIsVisible(caller, body.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      try {
        const facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const now = systemClock.now();
        const period = periodFromDays(body.periodDays, now);

        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const insights = new AnalyticsInsightService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              gateway: gateway(),
              // AN UNGROUNDED GENERATION MUST OUTLIVE THE TRANSACTION THAT
              // REFUSED IT. See `insightDenialSink`.
              denialSink: insightDenialSink(caller.workspaceId),
            });
            return insights.explain({
              brandId: body.brandId,
              scope: {
                brandId: body.brandId,
                ...(body.campaignId ? { campaignId: body.campaignId } : {}),
              },
              period,
              ...(body.compareToPrevious ? { comparison: previousPeriod(period) } : {}),
              idempotencyKey: body.idempotencyKey,
              actorUserId: caller.userId,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
              // D-116 / D-117: resolved by the SAME function the Content Studio
              // uses, so an insight and a draft made on the same day are kept for
              // the same length of time.
              expiresAt: resolveContentExpiry(contentPolicy, facts, systemClock),
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          insightId: result.insight?.id ?? null,
          insufficientData: result.insufficientData,
          evidenceCount: result.evidence.length,
          anomalyCount: result.anomalies.length,
          // THE BODY IS NOT RETURNED HERE. The screen reads the insight and its
          // evidence through the dashboard, under the same scope predicate, so
          // there is exactly one path by which an explanation reaches a person.
          creditsChargedMilli: result.creditsChargedMilli.toString(),
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        return fail(reply, 'analytics explain', error);
      }
    },
  );

  /**
   * `strategy.generate` — a proposal, grounded in Brand Brain and evidence.
   *
   * THE RESULT IS A PROPOSAL. It is written with status `NEW` and nothing in the
   * platform acts on it until a permitted human accepts it through the review
   * route below.
   */
  route(
    app,
    'POST',
    '/v1/strategy/generate',
    {
      scope: 'workspace',
      permission: STRATEGY_MANAGE,
      rateLimit: 'ai.generate',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, STRATEGY_MANAGE);
      if (!caller) return;

      const parsed = strategySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      const body = parsed.data;
      if (!(await brandIsVisible(caller, body.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      try {
        const facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const now = systemClock.now();
        const period = periodFromDays(body.periodDays, now);

        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const strategy = new StrategyService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              gateway: gateway(),
              denialSink: insightDenialSink(caller.workspaceId),
            });
            return strategy.generate({
              brandId: body.brandId,
              period,
              objective: body.objective,
              idempotencyKey: body.idempotencyKey,
              actorUserId: caller.userId,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
              expiresAt: resolveContentExpiry(contentPolicy, facts, systemClock),
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          insightId: result.insight?.id ?? null,
          insufficientGrounding: result.insufficientGrounding,
          evidenceCount: result.evidence.length,
          creditsChargedMilli: result.creditsChargedMilli.toString(),
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        return fail(reply, 'strategy generate', error);
      }
    },
  );

  /**
   * MARKETING INTELLIGENCE — content-gap analysis (AC-30.1).
   *
   * THE SAME SHAPE AS `strategy.generate` AND A DIFFERENT QUESTION. Strategy
   * asks what this brand should do; this asks what it SAID IT WOULD DO AND HAS
   * NOT — pillars it declared and has not published against, platforms it is
   * connected to and has not posted on, a cadence it set and has not kept.
   * Every one of those is a fact about rows that are not there, checkable
   * against this workspace's own data.
   *
   * IT IS NOT A TRENDS FEED, and the separate route is part of saying so: the
   * product has no external market source (D-18, D-19 approved none), the
   * insight records its basis as `BRAND_CONTEXT` or `CONTENT_HISTORY`, and the
   * screen states it. A single "intelligence" endpoint that sometimes returned
   * a strategy would blur the one distinction a customer needs.
   *
   * `strategy.manage` RATHER THAN `strategy.read`, because it spends credits —
   * the same rule every generating route in this file follows.
   */
  route(
    app,
    'POST',
    '/v1/intelligence/content-gap',
    {
      scope: 'workspace',
      permission: STRATEGY_MANAGE,
      rateLimit: 'ai.generate',
      idempotent: true,
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, STRATEGY_MANAGE);
      if (!caller) return;

      const parsed = strategySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      const body = parsed.data;
      if (!(await brandIsVisible(caller, body.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      try {
        const facts = await workspaceFacts(caller.workspaceId);
        const contentPolicy = await resolveContentPolicy(
          configurationService(),
          currentEnvironment(),
        );
        const now = systemClock.now();
        const period = periodFromDays(body.periodDays, now);

        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const strategy = new StrategyService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              gateway: gateway(),
              denialSink: insightDenialSink(caller.workspaceId),
            });
            return strategy.analyseContentGaps({
              brandId: body.brandId,
              period,
              objective: body.objective,
              idempotencyKey: body.idempotencyKey,
              actorUserId: caller.userId,
              planKey: facts.planKey,
              actorBrandScope: caller.brandScope,
              expiresAt: resolveContentExpiry(contentPolicy, facts, systemClock),
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          insightId: result.insight?.id ?? null,
          insufficientGrounding: result.insufficientGrounding,
          evidenceCount: result.evidence.length,
          creditsChargedMilli: result.creditsChargedMilli.toString(),
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        return fail(reply, 'content gap', error);
      }
    },
  );

  /**
   * Accept or dismiss a proposal.
   *
   * THE ONLY PATH TO `ACCEPTED`, and it takes `strategy.manage` rather than
   * `strategy.read`: accepting is what turns a machine proposal into something
   * the rest of the product will build campaigns from.
   *
   * A HIGH-IMPACT ACTION BY THE ROUTE CONTRACT'S OWN DEFINITION, so it declares a
   * confirmation policy — the customer's own click on "accept" is the
   * confirmation, and the audit event records who.
   */
  route(
    app,
    'POST',
    '/v1/insights/review',
    {
      scope: 'workspace',
      permission: STRATEGY_MANAGE,
      confirmation: 'required',
      rateLimit: 'workspace.write',
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, STRATEGY_MANAGE);
      if (!caller) return;

      const parsed = reviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }
      const body = parsed.data;

      try {
        const insight = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const insights = new AnalyticsInsightService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              gateway: gateway(),
            });
            return insights.review({
              insightId: body.insightId,
              decision: body.decision,
              ...(body.reason ? { reason: body.reason } : {}),
              actorUserId: caller.userId,
              brandScope: caller.brandScope,
            });
          },
          { prisma: getPrisma() },
        );
        return reply.send({ insightId: insight.id, status: insight.status });
      } catch (error: unknown) {
        return fail(reply, 'insight review', error);
      }
    },
  );

  /**
   * PROPOSE LEARNINGS FROM AN INSIGHT — D-64's return path, closed.
   *
   * IT WRITES CANDIDATES, NOT KNOWLEDGE. Everything it produces lands in the same
   * PENDING review queue a document candidate lands in, judged by the same
   * `brand_brain.review` permission. That is why this route requires
   * `brand_brain.review` rather than `strategy.manage`: the person asking for the
   * inference to be drawn is the person who will have to judge it.
   *
   * IT SPENDS NO CREDITS. The derivation is arithmetic over stored observations,
   * which is also what makes it reproducible.
   */
  route(
    app,
    'POST',
    '/v1/insights/learnings',
    {
      scope: 'workspace',
      permission: 'brand_brain.review',
      rateLimit: 'workspace.write',
    },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, 'brand_brain.review');
      if (!caller) return;

      const parsed = writeBackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'VALIDATION_FAILED' } });
      }

      try {
        const result = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const learning = new LearningWriteBackService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              knowledge: new BrandKnowledgeService({ db, workspaceId: caller.workspaceId }),
            });
            return learning.proposeFromInsight({
              insightId: parsed.data.insightId,
              actorBrandScope: caller.brandScope,
            });
          },
          { prisma: getPrisma() },
        );

        return reply.send({
          proposed: result.proposed.length,
          created: result.proposed.filter((entry) => entry.created).length,
          skipped: result.skipped.length,
        });
      } catch (error: unknown) {
        return fail(reply, 'learning write-back', error);
      }
    },
  );

  /**
   * Read the brand's insights. A read, and `strategy.read` is enough.
   *
   * The dashboard reads insights directly on the tenant identity; this exists for
   * the surfaces that are already talking to the API and would otherwise need a
   * second round trip through a different process.
   */
  route(
    app,
    'GET',
    '/v1/insights',
    { scope: 'workspace', permission: STRATEGY_READ, rateLimit: 'workspace.read' },
    async (req, reply) => {
      const caller = await resolveCaller(req, reply, STRATEGY_READ);
      if (!caller) return;

      const query = (req.query ?? {}) as { brandId?: string };
      if (query.brandId && !(await brandIsVisible(caller, query.brandId))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
      }

      try {
        const insights = await withWorkspace(
          caller.workspaceId,
          async (db) => {
            const policy = await new TenantAnalyticsPolicySource(db, currentEnvironment()).load();
            const queries = new AnalyticsQueryService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
            });
            const service = new AnalyticsInsightService({
              db,
              workspaceId: caller.workspaceId,
              policy,
              queries,
              gateway: gateway(),
            });
            return service.list({
              ...(query.brandId ? { brandId: query.brandId } : {}),
              brandScope: caller.brandScope,
            });
          },
          { prisma: getPrisma() },
        );
        return reply.send({
          insights: insights.map((insight) => ({
            id: insight.id,
            type: insight.type,
            status: insight.status,
            basis: insight.basis,
            periodStart: insight.periodStart.toISOString(),
            periodEnd: insight.periodEnd.toISOString(),
            createdAt: insight.createdAt.toISOString(),
          })),
        });
      } catch (error: unknown) {
        return fail(reply, 'insight list', error);
      }
    },
  );
}
