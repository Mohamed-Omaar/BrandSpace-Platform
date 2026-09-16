import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { CampaignService, ContentCalendarService, parseContentPolicy } from '@brandspace/content';
import {
  COPILOT_TOOLS,
  CopilotPlanService,
  CopilotUndoService,
  availableTools,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type CopilotPolicy,
  type ExecutorContext,
  type LiveAuthorization,
} from '@brandspace/copilot';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 7 — the Copilot's SECURITY contract, exercised end to end on real
 * PostgreSQL.
 *
 * WHAT THIS SUITE IS FOR. Everything else about the assistant is a convenience;
 * this is the part that decides whether a sentence a customer typed can become a
 * mutation nobody authorized. The adversary it models is not a hacker with a
 * debugger — it is a MODEL THAT PROPOSES SOMETHING IT SHOULD NOT, and a person
 * who clicks confirm, and a retry that arrives twice. All three are ordinary.
 *
 * THE SIX PROPERTIES PROVEN HERE, each with the defect it prevents:
 *
 *   1. A tool call is authorized by DETERMINISTIC SERVER CODE at EXECUTION, not
 *      by the plan. Defect: a role narrowed after the preview still executes.
 *   2. A confirmation is SINGLE-USE. Defect: a replayed token runs a plan twice.
 *   3. A confirmation is BOUND TO ONE PLAN HASH. Defect: the plan changes after
 *      the person agreed to it, and the confirmation still fits.
 *   4. An EXTERNAL_OR_DESTRUCTIVE step cannot run unconfirmed, ever.
 *   5. A tool runs AT MOST ONCE. Defect: a retried execution publishes twice.
 *   6. An out-of-scope or foreign id is refused the way a fabricated one is.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: CopilotPolicy;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseCopilotPolicy(defaultPayload('copilot'));
}, 60_000);

beforeEach(async () => {
  await clearOpenPlans();
});

afterAll(async () => {
  await app?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

/**
 * The plan service, wired exactly as `apps/api` wires it — INCLUDING the denial
 * sink.
 *
 * THE SINK IS NOT A TEST CONVENIENCE, it is the thing under test in one of the
 * assertions below. Every caller reaches this service inside `withWorkspace`,
 * which is one transaction; a refusal throws and the transaction rolls back,
 * taking an audit row written just before the throw with it. So the refusal
 * audit is written on a SEPARATE connection, and a suite that omitted the sink
 * would be testing a configuration production never runs.
 */
function plans(db: TenantScopedClient, workspaceId: string): CopilotPlanService {
  return new CopilotPlanService({
    db,
    workspaceId,
    policy,
    denialSink: async (event) => {
      await withWorkspace(workspaceId, async (fresh) =>
        writeDeniedAudit(fresh, workspaceId, {
          action: event.action,
          actorType: 'USER',
          actorId: event.userId,
          resourceType: 'CopilotActionPlan',
          resourceId: event.planId,
          ...(event.brandId ? { brandId: event.brandId } : {}),
          reason: event.reason,
        }),
      );
    },
  });
}

/**
 * Clear plans left AWAITING_CONFIRMATION by a previous test.
 *
 * `maxOpenPlansPerUser` is a real product limit and it is doing its job — one
 * person may not accumulate confirmation credentials. A test file that ignored
 * it would exhaust it on its fifth plan and then fail every assertion after
 * that for a reason unrelated to what it is checking, so each test starts from
 * a clean slate, the way a person who answered their earlier prompts would.
 */
async function clearOpenPlans(): Promise<void> {
  await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      await db.copilotActionPlan.updateMany({
        where: { workspaceId: fixtures.a.workspaceId, status: 'AWAITING_CONFIRMATION' },
        data: {
          status: 'EXPIRED',
          confirmationTokenHash: null,
          confirmationExpiresAt: null,
        },
      });
    },
    { prisma: app },
  );
}

/** The collaborators a tool may reach, assembled exactly as `apps/api` does. */
function executorContext(
  db: TenantScopedClient,
  authorization: LiveAuthorization,
  correlationId: string,
): ExecutorContext {
  const contentPolicy = parseContentPolicy(defaultPayload('content'));
  return {
    db,
    workspaceId: fixtures.a.workspaceId,
    authorization,
    planKey: null,
    clock: { now: () => new Date() },
    correlationId,
    idempotencyKey: 'placeholder',
    analytics: new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: parseAnalyticsPolicy(defaultPayload('analytics')),
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    }),
    campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
    calendar: new ContentCalendarService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy,
      timezone: 'UTC',
      quota: { limit: async () => null, consume: async () => true, refund: async () => undefined },
    }),
    retention: { subscriptionActive: true },
    // NO `externalActions` PORT. This surface cannot publish at all — the F-07
    // pattern applied to the assistant, and the reason a publish step here
    // fails rather than reaching a platform.
  };
}

async function authorizationFor(userId: string): Promise<LiveAuthorization> {
  const resolved = await inA((db) => resolveLiveAuthorization(db, fixtures.a.workspaceId, userId));
  if (!resolved) throw new Error('fixture user has no live membership');
  return resolved;
}

describe('the tool registry itself is a closed, typed, permissioned set', () => {
  it('every tool declares a permission, an action class and a message key', () => {
    for (const tool of COPILOT_TOOLS) {
      expect(tool.permission, `${tool.key} permission`).toBeTruthy();
      expect(tool.actionClass, `${tool.key} actionClass`).toBeTruthy();
      expect(tool.messageKey, `${tool.key} messageKey`).toBeTruthy();
      expect(typeof tool.input.parse, `${tool.key} schema`).toBe('function');
    }
  });

  it('there is no tool that publishes, pays, deletes a workspace or disconnects an account', () => {
    /*
     * THE ABSENCE IS THE CONTROL. A capability the assistant does not have is a
     * capability no prompt can talk it into, so the registry is asserted by what
     * is NOT in it as much as by what is.
     */
    const keys = COPILOT_TOOLS.map((tool) => tool.key);
    for (const forbidden of [
      'billing.pay',
      'billing.refund',
      'workspace.delete',
      'social.disconnect',
      'video.generate',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('the only EXTERNAL_OR_DESTRUCTIVE tool requires confirmation and claims no undo', () => {
    const external = COPILOT_TOOLS.filter((t) => t.actionClass === 'EXTERNAL_OR_DESTRUCTIVE');
    expect(external.map((t) => t.key)).toEqual(['publishing.publish_now']);
    for (const tool of external) {
      // A POST THAT REACHED A PLATFORM IS ON THAT PLATFORM. Claiming an undo
      // here would be the one promise this design must never make.
      expect(tool.undoable, `${tool.key} must not claim an undo`).toBe(false);
    }
  });

  it('a caller holding no permissions is offered no tools at all', async () => {
    // EXACTLY what `client_viewer` holds and nothing else — D-62, D-130.
    const offered = availableTools(['workspace.read']);
    expect(offered).toHaveLength(0);
  });
});

describe('a plan refuses what its author may not do', () => {
  it("a plan naming a brand outside the author's scope is refused as a 404-shaped miss", async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    const narrowed: LiveAuthorization = { ...authorization, brandScope: [randomUUID()] };

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization: narrowed,
          steps: [
            {
              toolKey: 'campaign.create',
              arguments: {
                brandId: fixtures.a.brandId,
                name: 'Refused',
                objective: 'AWARENESS',
              },
            },
          ],
          summary: { ar: 'اختبار', en: 'Probe' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("a plan naming ANOTHER TENANT's brand is refused identically — no distinguishable signal", async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    const scoped: LiveAuthorization = { ...authorization, brandScope: [fixtures.a.brandId] };

    const foreign = inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.b.brandId,
        authorization: scoped,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: { brandId: fixtures.b.brandId, name: 'Foreign', objective: 'AWARENESS' },
          },
        ],
        summary: { ar: 'اختبار', en: 'Probe' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );
    const invented = inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: null,
        authorization: scoped,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: { brandId: randomUUID(), name: 'Invented', objective: 'AWARENESS' },
          },
        ],
        summary: { ar: 'اختبار', en: 'Probe' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );

    await expect(foreign).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(invented).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an argument the tool never declared is rejected at the boundary, not passed on', async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization,
          steps: [
            {
              toolKey: 'campaign.create',
              arguments: { brandId: fixtures.a.brandId, name: '', objective: 'NOT_AN_OBJECTIVE' },
            },
          ],
          summary: { ar: 'اختبار', en: 'Probe' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it('an unknown tool key is refused', async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization,
          steps: [{ toolKey: 'database.query', arguments: {} }],
          summary: { ar: 'اختبار', en: 'Probe' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('the confirmation contract', () => {
  async function newPlan(name = `Plan ${randomUUID().slice(0, 6)}`) {
    const authorization = await authorizationFor(fixtures.a.userId);
    return inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: { brandId: fixtures.a.brandId, name, objective: 'AWARENESS' },
          },
        ],
        summary: { ar: 'إنشاء حملة', en: 'Create a campaign' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );
  }

  it('the raw token is returned exactly once and never stored', async () => {
    const created = await newPlan();
    expect(created.confirmationToken).toBeTruthy();

    const stored = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({
        where: { id: created.plan.id },
        select: { confirmationTokenHash: true },
      }),
    );
    // ONLY THE HASH IS ON DISK, so a database read cannot be replayed as a
    // confirmation — the D-141 discipline, applied to the assistant.
    expect(stored.confirmationTokenHash).not.toBe(created.confirmationToken);
    expect(stored.confirmationTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a correct token and hash confirm the plan once, and a replay is refused', async () => {
    const created = await newPlan();
    const token = created.confirmationToken as string;

    const confirmed = await inA((db) =>
      plans(db, fixtures.a.workspaceId).confirm({
        planId: created.plan.id,
        planHash: created.plan.planHash,
        token,
        userId: fixtures.a.userId,
      }),
    );
    expect(confirmed.status).toBe('CONFIRMED');

    // THE REPLAY. Same token, same hash, seconds later.
    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token,
          userId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a refused confirmation is AUDITED, because repeated refusals are a signal', async () => {
    const created = await newPlan();
    const before = await inA((db) =>
      db.auditEvent.count({ where: { action: 'copilot.confirmation_refused' } }),
    );

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token: 'not-the-token',
          userId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow();

    const after = await inA((db) =>
      db.auditEvent.findMany({
        where: { action: 'copilot.confirmation_refused' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      }),
    );
    expect(
      await inA((db) => db.auditEvent.count({ where: { action: 'copilot.confirmation_refused' } })),
    ).toBe(before + 1);
    // AND THE TOKEN IS NOT IN IT. An audit record that carried the credential
    // would be the credential, in a table built to be read.
    expect(JSON.stringify(after[0])).not.toContain('not-the-token');
  });

  it('a confirmation issued for one plan does not fit a DIFFERENT plan hash', async () => {
    const created = await newPlan();
    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: created.plan.id,
          // THE PLAN THE CUSTOMER WAS SHOWN IS NOT THE PLAN BEING CONFIRMED.
          planHash: 'a'.repeat(64),
          token: created.confirmationToken as string,
          userId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow();

    const still = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({
        where: { id: created.plan.id },
        select: { status: true },
      }),
    );
    expect(still.status).toBe('AWAITING_CONFIRMATION');
  });

  it('a DIFFERENT user cannot confirm somebody else\u2019s plan', async () => {
    /*
     * A COPILOT CONVERSATION IS ONE PERSON'S, not the workspace's. It carries
     * what they asked and what they were shown, so the `userId` predicate is in
     * the WHERE of the confirming update — another identity holding the plan id,
     * the hash AND the token still affects zero rows, and learns nothing about
     * whether the plan exists.
     */
    const created = await newPlan();
    const otherUser = fixtures.b.userId;

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token: created.confirmationToken as string,
          userId: otherUser,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a cancelled plan surrenders its token, so the refusal survives the customer saying no', async () => {
    const created = await newPlan();
    await inA((db) =>
      plans(db, fixtures.a.workspaceId).cancel({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        reason: 'customer_declined',
      }),
    );

    const stored = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({
        where: { id: created.plan.id },
        select: { status: true, confirmationTokenHash: true },
      }),
    );
    expect(stored.status).toBe('CANCELLED');
    expect(stored.confirmationTokenHash).toBeNull();

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token: created.confirmationToken as string,
          userId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a plan belonging to ANOTHER WORKSPACE cannot be confirmed from this one', async () => {
    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).confirm({
          planId: fixtures.b.copilotPlanId,
          planHash: fixtures.b.copilotPlanHash,
          token: 'anything',
          userId: fixtures.a.userId,
        }),
      ),
    ).rejects.toThrow();

    const untouched = await inB((db) =>
      db.copilotActionPlan.findFirstOrThrow({
        where: { id: fixtures.b.copilotPlanId },
        select: { status: true },
      }),
    );
    expect(untouched.status).toBe('AWAITING_CONFIRMATION');
  });
});

describe('execution re-checks authority and runs each tool at most once', () => {
  async function confirmedPlan(name: string) {
    const authorization = await authorizationFor(fixtures.a.userId);
    const created = await inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: { brandId: fixtures.a.brandId, name, objective: 'AWARENESS' },
          },
        ],
        summary: { ar: 'إنشاء حملة', en: 'Create a campaign' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );
    await inA((db) =>
      plans(db, fixtures.a.workspaceId).confirm({
        planId: created.plan.id,
        planHash: created.plan.planHash,
        token: created.confirmationToken as string,
        userId: fixtures.a.userId,
      }),
    );
    return created;
  }

  it('a confirmed plan executes, and the campaign it created really exists', async () => {
    const name = `Executed ${randomUUID().slice(0, 6)}`;
    const created = await confirmedPlan(name);

    const result = await inA((db) =>
      plans(db, fixtures.a.workspaceId).execute({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        context: (authorization, plan) => executorContext(db, authorization, plan.correlationId),
      }),
    );
    expect(result.plan.status).toBe('COMPLETED');
    expect(result.toolCalls.map((c) => c.status)).toEqual(['SUCCEEDED']);

    const campaign = await inA((db) => db.campaign.findFirst({ where: { name } }));
    expect(campaign?.workspaceId).toBe(fixtures.a.workspaceId);
    expect(campaign?.brandId).toBe(fixtures.a.brandId);
  });

  it('a second execution of the same plan is refused rather than repeated', async () => {
    const created = await confirmedPlan(`Once ${randomUUID().slice(0, 6)}`);
    await inA((db) =>
      plans(db, fixtures.a.workspaceId).execute({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        context: (authorization, plan) => executorContext(db, authorization, plan.correlationId),
      }),
    );

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).execute({
          planId: created.plan.id,
          userId: fixtures.a.userId,
          context: (authorization, plan) => executorContext(db, authorization, plan.correlationId),
        }),
      ),
    ).rejects.toThrow();
  });

  it('two concurrent executions of one plan produce exactly one run', async () => {
    /*
     * PRESSING "RUN" TWICE IS AN ORDINARY THING FOR A PERSON TO DO, and the
     * conditional claim is what makes it harmless. One side wins; the other
     * finds the status already moved and affects zero rows.
     */
    const name = `Concurrent ${randomUUID().slice(0, 6)}`;
    const created = await confirmedPlan(name);

    const attempts = await Promise.allSettled([
      inA((db) =>
        plans(db, fixtures.a.workspaceId).execute({
          planId: created.plan.id,
          userId: fixtures.a.userId,
          context: (authorization, plan) => executorContext(db, authorization, plan.correlationId),
        }),
      ),
      inA((db) =>
        plans(db, fixtures.a.workspaceId).execute({
          planId: created.plan.id,
          userId: fixtures.a.userId,
          context: (authorization, plan) => executorContext(db, authorization, plan.correlationId),
        }),
      ),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);

    const campaigns = await inA((db) => db.campaign.findMany({ where: { name } }));
    expect(campaigns).toHaveLength(1);
  });

  it('an UNCONFIRMED plan refuses to execute', async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    const created = await inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: {
              brandId: fixtures.a.brandId,
              name: `Unconfirmed ${randomUUID().slice(0, 6)}`,
              objective: 'AWARENESS',
            },
          },
        ],
        summary: { ar: 'اختبار', en: 'Probe' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );

    await expect(
      inA((db) =>
        plans(db, fixtures.a.workspaceId).execute({
          planId: created.plan.id,
          userId: fixtures.a.userId,
          context: (auth, plan) => executorContext(db, auth, plan.correlationId),
        }),
      ),
    ).rejects.toThrow();
  });

  it('a membership revoked between confirmation and execution stops the plan', async () => {
    /*
     * "A PREVIEW IS NEVER AUTHORIZATION." The plan was built and confirmed by a
     * member in good standing; by the time it runs they are not one. The live
     * read is the whole point of this test.
     */
    const created = await confirmedPlan(`Revoked ${randomUUID().slice(0, 6)}`);

    await inA((db) =>
      db.membership.updateMany({
        where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
        data: { status: 'SUSPENDED' },
      }),
    );
    try {
      await expect(
        inA((db) =>
          plans(db, fixtures.a.workspaceId).execute({
            planId: created.plan.id,
            userId: fixtures.a.userId,
            context: (auth, plan) => executorContext(db, auth, plan.correlationId),
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await inA((db) =>
        db.membership.updateMany({
          where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
          data: { status: 'ACTIVE' },
        }),
      );
    }
  });
});

describe('undo is a compensation contract, not a reversed command', () => {
  it('an executed plan can be undone once, and the campaign is archived rather than erased', async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    const name = `Undoable ${randomUUID().slice(0, 6)}`;
    const created = await inA((db) =>
      plans(db, fixtures.a.workspaceId).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'campaign.create',
            arguments: { brandId: fixtures.a.brandId, name, objective: 'AWARENESS' },
          },
        ],
        summary: { ar: 'إنشاء حملة', en: 'Create a campaign' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );
    await inA((db) =>
      plans(db, fixtures.a.workspaceId).confirm({
        planId: created.plan.id,
        planHash: created.plan.planHash,
        token: created.confirmationToken as string,
        userId: fixtures.a.userId,
      }),
    );
    await inA((db) =>
      plans(db, fixtures.a.workspaceId).execute({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        context: (auth, plan) => executorContext(db, auth, plan.correlationId),
      }),
    );

    const undone = await inA((db) =>
      new CopilotUndoService({ db, workspaceId: fixtures.a.workspaceId }).undo({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        collaborators: {
          campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
          calendar: new ContentCalendarService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: parseContentPolicy(defaultPayload('content')),
            timezone: 'UTC',
            quota: {
              limit: async () => null,
              consume: async () => true,
              refund: async () => undefined,
            },
          }),
        },
      }),
    );
    expect(undone.undone.map((s) => s.toolKey)).toEqual(['campaign.create']);
    expect(undone.plan.undoStatus).toBe('UNDONE');

    const campaign = await inA((db) => db.campaign.findFirst({ where: { name } }));
    // ARCHIVED, NOT DELETED. An undo that erased the row would also erase the
    // evidence that the assistant ever acted.
    expect(campaign).not.toBeNull();
    expect(campaign?.status).toBe('ARCHIVED');
  });

  it('a plan belonging to ANOTHER WORKSPACE cannot be undone from this one', async () => {
    await expect(
      inA((db) =>
        new CopilotUndoService({ db, workspaceId: fixtures.a.workspaceId }).undo({
          planId: fixtures.b.copilotPlanId,
          userId: fixtures.a.userId,
          collaborators: {
            campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
            calendar: new ContentCalendarService({
              db,
              workspaceId: fixtures.a.workspaceId,
              policy: parseContentPolicy(defaultPayload('content')),
              timezone: 'UTC',
              quota: {
                limit: async () => null,
                consume: async () => true,
                refund: async () => undefined,
              },
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
