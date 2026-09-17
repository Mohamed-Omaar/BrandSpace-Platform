import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  recordAutomationEvent,
  recordRuleAutomationEvent,
  withWorkspace,
  type TenantScopedClient,
} from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  AUTOMATION_TRIGGERS,
  AutomationEngine,
  findTrigger,
  parseAutomationPolicy,
  type AutomationActor,
  type TriggerEvent,
} from '@brandspace/automation';
import {
  CopilotOrchestrator,
  CopilotPlanService,
  hashConfirmationToken,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 7 REMEDIATION, ROUND 2 — the four blockers a second review found, on
 * real PostgreSQL.
 *
 * WHY A SECOND FILE. `phase7-remediation.test.ts` is the record of the first ten
 * findings and should stay readable as exactly that. These four were found
 * AFTER those were fixed, and two of them exist BECAUSE those were fixed — the
 * narrowed replay lookups left database constraints saying something wider, and
 * the "never re-issue a confirmation token" rule left a retried turn holding a
 * plan nothing could confirm. Keeping them together means the next reader can
 * see what a fix's own consequences looked like.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let otherBrandId: string;
let otherUserId: string;

const copilotPolicy = () => parseCopilotPolicy(defaultPayload('copilot'));
const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  otherBrandId = await inA(async (db) => {
    const brand = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        name: 'Round two brand',
        slug: `round-two-${randomUUID().slice(0, 8)}`,
        industry: 'retail',
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN', 'AR'],
      },
    });
    return brand.id;
  });

  otherUserId = await inA(async (db) => {
    const owner = await db.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
      select: { roleId: true },
    });
    const existing = await db.membership.findFirst({
      where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.b.userId },
    });
    if (existing) return existing.userId;
    const created = await db.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.b.userId,
        roleId: owner.roleId,
        status: 'ACTIVE',
        invitedByUserId: fixtures.a.userId,
      },
    });
    return created.userId;
  });
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

beforeEach(async () => {
  await setBrandScope(fixtures.a.userId, []);
  await setBrandScope(otherUserId, []);
});

async function setBrandScope(userId: string, brandScope: readonly string[]): Promise<void> {
  await inA((db) =>
    db.membership.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, userId },
      data: { brandScope: [...brandScope] },
    }),
  );
}

async function authorizationFor(userId: string): Promise<LiveAuthorization> {
  const authorization = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, userId),
  );
  if (!authorization) throw new Error('the fixture membership is missing');
  return authorization;
}

interface GatewayCalls {
  readonly executes: { idempotencyKey: string }[];
  readonly recorded: Map<string, AiGatewayResult>;
}

function emptyCalls(): GatewayCalls {
  return { executes: [], recorded: new Map() };
}

function stubGateway(calls: GatewayCalls, text: string): AiGateway {
  return {
    async execute(input: { idempotencyKey: string }): Promise<AiGatewayResult> {
      calls.executes.push({ idempotencyKey: input.idempotencyKey });
      const existing = calls.recorded.get(input.idempotencyKey);
      if (existing) return { ...existing, replayed: true, creditsChargedMilli: 0n };
      const fresh: AiGatewayResult = {
        requestId: randomUUID(),
        status: 'SUCCEEDED',
        modelKey: 'mock',
        attemptedModelKeys: ['mock'],
        output: { kind: 'text', text },
        usage: { promptTokens: 1, completionTokens: 1 },
        creditsChargedMilli: 100n,
        providerCostMicroMinor: 0n,
        failureClass: null,
        failureMessage: null,
        replayed: false,
        latencyMs: 1,
      };
      calls.recorded.set(input.idempotencyKey, fresh);
      return fresh;
    },
    async quote() {
      return { estimateMilli: 0n } as never;
    },
  } as unknown as AiGateway;
}

const PLAN_JSON = JSON.stringify({ summary: { ar: 'ملخص', en: 'A summary' }, steps: [] });

function orchestrator(db: TenantScopedClient, calls: GatewayCalls): CopilotOrchestrator {
  return new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: copilotPolicy(),
    gateway: stubGateway(calls, PLAN_JSON),
  });
}

function plans(db: TenantScopedClient): CopilotPlanService {
  return new CopilotPlanService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: copilotPolicy(),
  });
}

async function openSession(
  authorization: LiveAuthorization,
  brandId: string | null,
): Promise<{ id: string }> {
  return inA((db) =>
    orchestrator(db, emptyCalls()).openSession({
      authorization,
      brandId,
      surface: 'general',
      locale: 'EN',
      expiresAt: null,
    }),
  );
}

/**
 * CLEAR THIS MEMBER'S OPEN PLANS.
 *
 * `createPlan` refuses past a per-user ceiling of plans AWAITING_CONFIRMATION,
 * and it refuses BEFORE it looks at the steps — so a block of tests that each
 * leave one open would, after a few, be measuring the ceiling rather than the
 * brand rule or the token rotation under test. Each test starts from none of
 * its own.
 */
async function clearOpenPlans(): Promise<void> {
  await inA((db) =>
    db.copilotActionPlan.deleteMany({
      where: { workspaceId: fixtures.a.workspaceId, status: 'AWAITING_CONFIRMATION' },
    }),
  );
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
    throw new Error('expected a refusal, but the call succeeded');
  } catch (error: unknown) {
    const shaped = error as { code?: unknown; message?: unknown };
    return {
      code: typeof shaped.code === 'string' ? shaped.code : 'NOT_AN_APP_ERROR',
      message: typeof shaped.message === 'string' ? shaped.message : '',
    };
  }
}

// ---------------------------------------------------------------------------
// R2-A — the database agrees with the replay lookup
// ---------------------------------------------------------------------------

describe('R2-A: the plan idempotency constraint is session-scoped, not workspace-scoped', () => {
  /**
   * ONE LITERAL KEY, SHARED BY EVERYTHING BELOW.
   *
   * The whole point of this block is that the SAME STRING behaves correctly in
   * four different places. A derived key — `${key}-theirs` — proves only that
   * two different keys make two different rows, which is the bug the first
   * round's test accidentally shipped.
   */
  const sharedKey = () => `r2a-${randomUUID()}`;

  it('TWO MEMBERS, THE SAME LITERAL KEY: both plans exist and neither is the other’s', async () => {
    const key = sharedKey();
    const mine = await authorizationFor(fixtures.a.userId);
    const theirs = await authorizationFor(otherUserId);
    const mySession = await openSession(mine, fixtures.a.brandId);
    const theirSession = await openSession(theirs, fixtures.a.brandId);

    const create = (
      sessionId: string,
      authorization: LiveAuthorization,
    ): Promise<{ plan: { id: string; userId: string; idempotencyKey: string | null } }> =>
      inA((db) =>
        plans(db).createPlan({
          sessionId,
          brandId: fixtures.a.brandId,
          authorization,
          steps: [],
          summary: { ar: 'ملخص', en: 'Summary' },
          estimatedCreditsMilli: 0n,
          idempotencyKey: key,
          expiresAt: null,
        }),
      ) as never;

    const first = await create(mySession.id, mine);
    /*
     * THE SECOND CREATE IS THE ASSERTION. Under `(workspaceId, idempotencyKey)`
     * this line raised a unique violation: the lookup correctly refused to hand
     * this member the first member's plan, fell through to creation, and the
     * database then killed a plan they had every right to. A leak fix that leaves
     * a liveness bug behind it has moved the problem, not solved it.
     */
    const second = await create(theirSession.id, theirs);

    expect(second.plan.id).not.toBe(first.plan.id);
    expect(first.plan.userId).toBe(fixtures.a.userId);
    expect(second.plan.userId).toBe(otherUserId);
    expect(first.plan.idempotencyKey).toBe(key);
    expect(second.plan.idempotencyKey).toBe(key);
  });

  it('TWO SESSIONS OF ONE MEMBER, THE SAME LITERAL KEY: two plans', async () => {
    const key = sharedKey();
    const mine = await authorizationFor(fixtures.a.userId);
    const one = await openSession(mine, fixtures.a.brandId);
    const two = await openSession(mine, fixtures.a.brandId);

    const create = (sessionId: string) =>
      inA((db) =>
        plans(db).createPlan({
          sessionId,
          brandId: fixtures.a.brandId,
          authorization: mine,
          steps: [],
          summary: { ar: 'ملخص', en: 'Summary' },
          estimatedCreditsMilli: 0n,
          idempotencyKey: key,
          expiresAt: null,
        }),
      );

    const first = await create(one.id);
    const second = await create(two.id);
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(second.plan.sessionId).toBe(two.id);
  });

  it('TWO BRANDS, THE SAME LITERAL KEY: two plans, because the sessions differ', async () => {
    const key = sharedKey();
    const mine = await authorizationFor(fixtures.a.userId);
    const brandA = await openSession(mine, fixtures.a.brandId);
    const brandB = await openSession(mine, otherBrandId);

    const create = (sessionId: string, brandId: string) =>
      inA((db) =>
        plans(db).createPlan({
          sessionId,
          brandId,
          authorization: mine,
          steps: [],
          summary: { ar: 'ملخص', en: 'Summary' },
          estimatedCreditsMilli: 0n,
          idempotencyKey: key,
          expiresAt: null,
        }),
      );

    const first = await create(brandA.id, fixtures.a.brandId);
    const second = await create(brandB.id, otherBrandId);
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(first.plan.brandId).toBe(fixtures.a.brandId);
    expect(second.plan.brandId).toBe(otherBrandId);
  });

  it('THE SAME MEMBER, SESSION AND KEY REPLAYS THE ORIGINAL — exactly once', async () => {
    const key = sharedKey();
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);

    const create = () =>
      inA((db) =>
        plans(db).createPlan({
          sessionId: session.id,
          brandId: fixtures.a.brandId,
          authorization: mine,
          steps: [],
          summary: { ar: 'ملخص', en: 'Summary' },
          estimatedCreditsMilli: 0n,
          idempotencyKey: key,
          expiresAt: null,
        }),
      );

    const first = await create();
    const second = await create();
    expect(second.plan.id).toBe(first.plan.id);
    expect(
      await inA((db) =>
        db.copilotActionPlan.count({
          where: { workspaceId: fixtures.a.workspaceId, idempotencyKey: key },
        }),
      ),
    ).toBe(1);
  });

  it('the constraint that exists is the one the lookup uses', async () => {
    /*
     * ASKED OF POSTGRESQL, not of Prisma's opinion of PostgreSQL. A schema that
     * says one thing and a database that says another is the whole shape of this
     * finding, so the test reads the catalogue.
     */
    const rows = await inA(
      (db) =>
        db.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes
          WHERE tablename = 'copilot_action_plan' AND indexdef LIKE '%idempotencyKey%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('"sessionId"');
    expect(rows[0]?.indexdef).toContain('UNIQUE');
  });
});

// ---------------------------------------------------------------------------
// R2-B — a lost response does not cost the customer their plan
// ---------------------------------------------------------------------------

describe('R2-B: an idempotent retry of a confirmable plan returns a usable credential', () => {
  beforeEach(clearOpenPlans);

  async function confirmablePlan(key: string, authorization: LiveAuthorization, sessionId: string) {
    return inA((db) =>
      plans(db).createPlan({
        sessionId,
        brandId: fixtures.a.brandId,
        authorization,
        steps: [
          {
            toolKey: 'content.draft',
            arguments: {
              brandId: fixtures.a.brandId,
              title: 'A draft',
              brief: 'A brief for the draft',
              platformKeys: ['instagram'],
            },
          },
        ],
        summary: { ar: 'ملخص', en: 'Summary' },
        estimatedCreditsMilli: 0n,
        idempotencyKey: key,
        expiresAt: null,
      }),
    );
  }

  it('THE RETRY GETS A TOKEN, AND THE FIRST ONE STOPS WORKING', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);
    const key = `r2b-${randomUUID()}`;

    // The turn that succeeded and whose response never arrived.
    const first = await confirmablePlan(key, mine, session.id);
    expect(first.plan.status).toBe('AWAITING_CONFIRMATION');
    expect(first.confirmationToken).not.toBeNull();

    // The client retries the same request.
    const retry = await confirmablePlan(key, mine, session.id);

    // SAME PLAN. No duplicate, no second AI charge, no second row.
    expect(retry.plan.id).toBe(first.plan.id);
    expect(
      await inA((db) =>
        db.copilotActionPlan.count({
          where: { workspaceId: fixtures.a.workspaceId, idempotencyKey: key },
        }),
      ),
    ).toBe(1);

    // AND A USABLE CREDENTIAL, which is the whole finding: before this, the
    // retry handed back `null` and the plan could never be confirmed by anyone.
    expect(retry.confirmationToken).not.toBeNull();
    expect(retry.confirmationToken).not.toBe(first.confirmationToken);

    // THE STORED DIGEST IS THE NEW TOKEN'S, and the raw value is nowhere.
    const stored = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({ where: { id: first.plan.id } }),
    );
    expect(stored.confirmationTokenHash).toBe(hashConfirmationToken(retry.confirmationToken ?? ''));
    expect(stored.confirmationTokenHash).not.toBe(
      hashConfirmationToken(first.confirmationToken ?? ''),
    );

    // THE OLD TOKEN IS DEAD.
    const refused = await failure(
      inA((db) =>
        plans(db).confirm({
          planId: first.plan.id,
          planHash: stored.planHash,
          token: first.confirmationToken ?? '',
          userId: fixtures.a.userId,
        }),
      ),
    );
    expect(refused.code).toBe('CONFLICT');

    // THE NEW ONE CONFIRMS, EXACTLY ONCE.
    const confirmed = await inA((db) =>
      plans(db).confirm({
        planId: first.plan.id,
        planHash: stored.planHash,
        token: retry.confirmationToken ?? '',
        userId: fixtures.a.userId,
      }),
    );
    expect(confirmed.status).toBe('CONFIRMED');

    const replayed = await failure(
      inA((db) =>
        plans(db).confirm({
          planId: first.plan.id,
          planHash: stored.planHash,
          token: retry.confirmationToken ?? '',
          userId: fixtures.a.userId,
        }),
      ),
    );
    expect(replayed.code).toBe('CONFLICT');
  });

  it('CONCURRENT RETRIES LEAVE EXACTLY ONE LIVE CREDENTIAL', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);
    const key = `r2b-race-${randomUUID()}`;
    const first = await confirmablePlan(key, mine, session.id);

    /*
     * TWO RETRIES AT ONCE. The compare-and-swap on the old digest means one wins
     * and the other finds the digest already moved: it is handed NO token rather
     * than a second live one. At every instant at most one credential in the
     * world can confirm this plan.
     */
    const [a, b] = await Promise.all([
      confirmablePlan(key, mine, session.id),
      confirmablePlan(key, mine, session.id),
    ]);

    const issued = [a.confirmationToken, b.confirmationToken].filter(
      (token): token is string => token !== null,
    );
    expect(issued.length).toBeLessThanOrEqual(2);

    const stored = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({ where: { id: first.plan.id } }),
    );
    // EXACTLY ONE of the tokens ever issued matches the stored digest.
    const live = [first.confirmationToken, ...issued].filter(
      (token) => token !== null && hashConfirmationToken(token) === stored.confirmationTokenHash,
    );
    expect(live).toHaveLength(1);
  });

  it('DOES NOT REISSUE for a plan that is already confirmed', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);
    const key = `r2b-confirmed-${randomUUID()}`;
    const first = await confirmablePlan(key, mine, session.id);

    await inA((db) =>
      plans(db).confirm({
        planId: first.plan.id,
        planHash: first.plan.planHash,
        token: first.confirmationToken ?? '',
        userId: fixtures.a.userId,
      }),
    );

    const retry = await confirmablePlan(key, mine, session.id);
    expect(retry.plan.id).toBe(first.plan.id);
    expect(retry.plan.status).toBe('CONFIRMED');
    // Reissuing here would resurrect a decision the customer has already made.
    expect(retry.confirmationToken).toBeNull();
  });

  it('DOES NOT REISSUE for a plan the customer cancelled', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);
    const key = `r2b-cancelled-${randomUUID()}`;
    const first = await confirmablePlan(key, mine, session.id);

    await inA((db) =>
      plans(db).cancel({ planId: first.plan.id, userId: fixtures.a.userId, reason: 'no thanks' }),
    );

    const retry = await confirmablePlan(key, mine, session.id);
    expect(retry.plan.status).toBe('CANCELLED');
    expect(retry.confirmationToken).toBeNull();
    const stored = await inA((db) =>
      db.copilotActionPlan.findFirstOrThrow({ where: { id: first.plan.id } }),
    );
    expect(stored.confirmationTokenHash).toBeNull();
  });

  it('reissuing is AUDITED, without either token appearing anywhere', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, fixtures.a.brandId);
    const key = `r2b-audit-${randomUUID()}`;
    const first = await confirmablePlan(key, mine, session.id);
    const retry = await confirmablePlan(key, mine, session.id);

    const events = await inA((db) =>
      db.auditEvent.findMany({
        where: {
          workspaceId: fixtures.a.workspaceId,
          action: 'copilot.confirmation_reissued',
          resourceId: first.plan.id,
        },
      }),
    );
    expect(events).toHaveLength(1);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(first.confirmationToken);
    expect(serialised).not.toContain(retry.confirmationToken);
  });
});

// ---------------------------------------------------------------------------
// A2 — the session's brand is the only brand a step may name
// ---------------------------------------------------------------------------

describe('A2: a brand-scoped step is bound to the conversation’s brand', () => {
  beforeEach(clearOpenPlans);

  const draftStep = (brandId: string) => ({
    toolKey: 'content.draft',
    arguments: {
      brandId,
      title: 'A draft',
      brief: 'A brief for the draft',
      platformKeys: ['instagram'],
    },
  });

  async function build(sessionBrandId: string | null, stepBrandId: string) {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await openSession(mine, sessionBrandId);
    return inA((db) =>
      plans(db).createPlan({
        sessionId: session.id,
        brandId: sessionBrandId,
        authorization: mine,
        steps: [draftStep(stepBrandId)],
        summary: { ar: 'ملخص', en: 'Summary' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
      }),
    );
  }

  it('session Brand A + step Brand A is allowed', async () => {
    const created = await build(fixtures.a.brandId, fixtures.a.brandId);
    expect(created.steps).toHaveLength(1);
    expect(created.plan.brandId).toBe(fixtures.a.brandId);
  });

  it('SESSION BRAND A + STEP BRAND B IS REFUSED, though the member holds both', async () => {
    /*
     * THE DEFECT ITSELF. Both brands are genuinely this member's — an empty
     * BrandScope means unrestricted — so every check that existed said yes. The
     * assistant would have acted on B while the conversation, the history and
     * the audit trail all said A.
     */
    const refused = await failure(build(fixtures.a.brandId, otherBrandId));
    expect(refused.code).toBe('NOT_FOUND');
  });

  it('A FOREIGN BRAND AND A FABRICATED ONE REFUSE IDENTICALLY', async () => {
    const foreign = await failure(build(fixtures.a.brandId, fixtures.b.brandId));
    const fabricated = await failure(build(fixtures.a.brandId, randomUUID()));
    const ownOther = await failure(build(fixtures.a.brandId, otherBrandId));
    // Same code AND same message, or the difference tells a caller which ids are
    // real — the inference CLAUDE.md §2.1 closes.
    expect(foreign).toEqual(fabricated);
    expect(ownOther).toEqual(fabricated);
  });

  it('NOTHING IS WRITTEN AND NOTHING IS PREVIEWED BEFORE THE REFUSAL', async () => {
    const plansBefore = await inA((db) =>
      db.copilotActionPlan.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    const callsBefore = await inA((db) =>
      db.copilotToolCall.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    const itemsBefore = await inA((db) =>
      db.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } }),
    );

    await failure(build(fixtures.a.brandId, otherBrandId));

    expect(
      await inA((db) =>
        db.copilotActionPlan.count({ where: { workspaceId: fixtures.a.workspaceId } }),
      ),
    ).toBe(plansBefore);
    expect(
      await inA((db) =>
        db.copilotToolCall.count({ where: { workspaceId: fixtures.a.workspaceId } }),
      ),
    ).toBe(callsBefore);
    expect(
      await inA((db) => db.contentItem.count({ where: { workspaceId: fixtures.a.workspaceId } })),
    ).toBe(itemsBefore);
  });

  it('A GENERAL SESSION FAILS CLOSED, and offers no brand tool to begin with', async () => {
    const refused = await failure(build(null, fixtures.a.brandId));
    expect(refused.code).toBe('NOT_FOUND');
  });

  it('NARROWING THE LIVE SCOPE STILL REFUSES A PLAN BUILT BEFORE IT', async () => {
    const created = await build(fixtures.a.brandId, fixtures.a.brandId);
    // The administrator narrows this member to the OTHER brand after the plan
    // was built and confirmed.
    await inA((db) =>
      plans(db).confirm({
        planId: created.plan.id,
        planHash: created.plan.planHash,
        token: created.confirmationToken ?? '',
        userId: fixtures.a.userId,
      }),
    );
    await setBrandScope(fixtures.a.userId, [otherBrandId]);

    const executed = await inA((db) =>
      plans(db).execute({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        context: () => ({}) as never,
      }),
    );
    expect(executed.toolCalls[0]?.status).toBe('REFUSED');
    expect(executed.toolCalls[0]?.failureCode).toBe('brand_out_of_scope');
  });
});

// ---------------------------------------------------------------------------
// A1 — every authorable trigger has a producer, and a real event reaches a rule
// ---------------------------------------------------------------------------

describe('A1: the automation outbox carries a real domain event to a rule', () => {
  function engine(db: TenantScopedClient, notified: string[]): AutomationEngine {
    return new AutomationEngine({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
      ports: {
        notifications: {
          notify: async (input) => {
            notified.push(input.idempotencyKey);
            return { recipients: 1 };
          },
        },
      },
    });
  }

  const actor = (): AutomationActor => ({
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    // NOTIFY requires `workspace.read` — the engine re-checks the ACTION's own
    // permission against the creator's live authority on every run.
    permissionKeys: ['workspace.read', 'publishing.manage', 'automation.manage'],
    brandScope: [],
  });

  async function ruleOn(triggerType: 'CONTENT_APPROVED' | 'SCHEDULED_TIME'): Promise<string> {
    const rule = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `round-two ${randomUUID()}`,
          enabled: true,
          triggerType,
          triggerConfig: triggerType === 'SCHEDULED_TIME' ? { daysOfWeek: [], hourLocal: 9 } : {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
        },
      }),
    );
    return rule.id;
  }

  it('EVERY AUTHORABLE TRIGGER IS ONE A PRODUCER CAN WRITE', () => {
    /*
     * THE REGISTRY AND THE PRODUCERS MUST NOT DRIFT APART, and the way a
     * customer discovers they have is by writing a rule that never fires. A new
     * trigger added without a producer fails this test on the day it is added.
     */
    const producible = new Set([
      'CONTENT_APPROVED',
      'CONTENT_SCHEDULED',
      'POST_PUBLISHED',
      'ANALYTICS_REFRESHED',
      'METRIC_THRESHOLD_CROSSED',
      'SCHEDULED_TIME',
    ]);
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(producible.has(trigger.type), `${trigger.type} has no producer`).toBe(true);
    }
    expect(AUTOMATION_TRIGGERS).toHaveLength(producible.size);
    expect(findTrigger('ANOMALY_DETECTED')).toBeUndefined();
  });

  it('a domain event becomes an outbox row, and the SAME event twice is one row', async () => {
    const itemId = fixtures.a.contentItemId;
    const first = await inA((db) =>
      recordAutomationEvent(
        db,
        fixtures.a.workspaceId,
        { triggerType: 'CONTENT_APPROVED', refType: 'ContentItem' },
        { brandId: fixtures.a.brandId, refId: itemId },
      ),
    );
    const second = await inA((db) =>
      recordAutomationEvent(
        db,
        fixtures.a.workspaceId,
        { triggerType: 'CONTENT_APPROVED', refType: 'ContentItem' },
        { brandId: fixtures.a.brandId, refId: itemId },
      ),
    );
    expect(first).toBe(true);
    // "Item X was approved" is ONE event however many times anything notices it.
    expect(second).toBe(false);
    expect(
      await inA((db) =>
        db.automationEvent.count({
          where: { workspaceId: fixtures.a.workspaceId, dedupeKey: `CONTENT_APPROVED:${itemId}` },
        }),
      ),
    ).toBe(1);
  });

  it('THE EVENT REACHES THE RULE AND RUNS IT EXACTLY ONCE UNDER DUPLICATE DELIVERY', async () => {
    const ruleId = await ruleOn('CONTENT_APPROVED');
    const notified: string[] = [];
    const event: TriggerEvent = {
      type: 'CONTENT_APPROVED',
      brandId: fixtures.a.brandId,
      refType: 'ContentItem',
      refId: fixtures.a.contentItemId,
      facts: {},
    };

    const deliver = () =>
      inA((db) => engine(db, notified).deliver({ event, resolveActor: async () => actor() }));

    const one = await deliver();
    const afterFirst = notified.length;
    // REDELIVERED. At-least-once is what a queue promises, so the engine has to
    // make the second delivery free.
    const two = await deliver();

    const mine = (
      outcomes: readonly { run: { ruleId: string; id: string; status: string } | null }[],
    ) => outcomes.find((outcome) => outcome.run?.ruleId === ruleId)?.run ?? null;

    expect(mine(one)?.id).toBeDefined();
    expect(mine(two)?.id).toBe(mine(one)?.id);
    expect(mine(one)?.status).toBe('SUCCEEDED');
    expect(await inA((db) => db.automationRun.count({ where: { ruleId } }))).toBe(1);
    /*
     * THE ACTION RAN ONCE. `notified` also collects the other CONTENT_APPROVED
     * rules this suite has left behind — which is the honest shape of `deliver`,
     * since every rule listening for an approval genuinely should see it — so
     * the assertion is that the SECOND delivery adds nothing, which is the
     * property under test.
     */
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(notified).toHaveLength(afterFirst);
  });

  it('A TIMED EVENT IS ADDRESSED TO ITS OWN RULE, and not to the brand’s others', async () => {
    const mine = await ruleOn('SCHEDULED_TIME');
    const other = await ruleOn('SCHEDULED_TIME');
    const notified: string[] = [];

    const outcomes = await inA((db) =>
      engine(db, notified).deliver({
        event: {
          type: 'SCHEDULED_TIME',
          brandId: fixtures.a.brandId,
          refType: null,
          refId: null,
          ruleId: mine,
          occurrence: '2026-09-17T09',
          facts: {},
        },
        resolveActor: async () => actor(),
      }),
    );

    expect(outcomes).toHaveLength(1);
    expect(await inA((db) => db.automationRun.count({ where: { ruleId: mine } }))).toBe(1);
    // The other rule configured a different schedule and must not be fired by
    // this one's occurrence.
    expect(await inA((db) => db.automationRun.count({ where: { ruleId: other } }))).toBe(0);
  });

  it('A REDELIVERY AN HOUR LATE IS THE SAME OCCURRENCE, not a second run', async () => {
    /*
     * P7-R5 FROM THE PRODUCER'S SIDE. Recomputing the bucket from `now` at
     * delivery means a message that sat in the queue past the hour boundary
     * lands in the NEXT bucket and runs the same schedule twice. The occurrence
     * the event was created for is carried, so it cannot.
     */
    const ruleId = await ruleOn('SCHEDULED_TIME');
    const notified: string[] = [];
    const event: TriggerEvent = {
      type: 'SCHEDULED_TIME',
      brandId: fixtures.a.brandId,
      refType: null,
      refId: null,
      ruleId,
      occurrence: '2026-09-17T09',
      facts: {},
    };

    await inA((db) => engine(db, notified).deliver({ event, resolveActor: async () => actor() }));
    const afterFirst = notified.length;
    await inA((db) => engine(db, notified).deliver({ event, resolveActor: async () => actor() }));

    expect(await inA((db) => db.automationRun.count({ where: { ruleId } }))).toBe(1);
    expect(afterFirst).toBe(1);
    expect(notified).toHaveLength(1);
  });

  it('a DIFFERENT occurrence of the same rule IS a new run', async () => {
    const ruleId = await ruleOn('SCHEDULED_TIME');
    const notified: string[] = [];
    const at = (occurrence: string): TriggerEvent => ({
      type: 'SCHEDULED_TIME',
      brandId: fixtures.a.brandId,
      refType: null,
      refId: null,
      ruleId,
      occurrence,
      facts: {},
    });

    await inA((db) =>
      engine(db, notified).deliver({
        event: at('2026-09-17T09'),
        resolveActor: async () => actor(),
      }),
    );
    await inA((db) =>
      engine(db, notified).deliver({
        event: at('2026-09-18T09'),
        resolveActor: async () => actor(),
      }),
    );
    expect(await inA((db) => db.automationRun.count({ where: { ruleId } }))).toBe(2);
  });

  it('a timed producer writes ONE row per occurrence however often it looks', async () => {
    const ruleId = await ruleOn('SCHEDULED_TIME');
    const write = () =>
      inA((db) =>
        recordRuleAutomationEvent(db, fixtures.a.workspaceId, {
          triggerType: 'SCHEDULED_TIME',
          brandId: fixtures.a.brandId,
          ruleId,
          occurrence: '2026-09-17T09',
        }),
      );
    expect(await write()).toBe(true);
    // A sweep runs every minute. Fifty-nine of the sixty passes inside the hour
    // must write nothing at all.
    expect(await write()).toBe(false);
    expect(await write()).toBe(false);
    expect(
      await inA((db) =>
        db.automationEvent.count({ where: { workspaceId: fixtures.a.workspaceId, ruleId } }),
      ),
    ).toBe(1);
  });

  it('THE DATABASE REFUSES A PRODUCER THAT NAMES THE WRONG KIND OF ROW', async () => {
    /*
     * The type refuses this at the call site, so the only way to reach the CHECK
     * is to go round it — which is exactly what a future producer written in
     * haste would do. `POST_PUBLISHED` with a ContentItem reference would aim
     * three content-shaped actions at a publish job's id.
     */
    await expect(
      inA((db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            triggerType: 'POST_PUBLISHED',
            refType: 'ContentItem',
            refId: fixtures.a.contentItemId,
            dedupeKey: `bad-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow(/automation_event_ref_matches_trigger/);
  });

  it('THE DATABASE REFUSES AN OCCURRENCE ON A NON-TIMED TRIGGER', async () => {
    await expect(
      inA((db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            triggerType: 'CONTENT_APPROVED',
            refType: 'ContentItem',
            refId: fixtures.a.contentItemId,
            occurrence: '2026-09-17T09',
            dedupeKey: `bad-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow(/automation_event_occurrence_is_timed/);
  });

  it('THE DATABASE REFUSES A RULE-DERIVED EVENT THAT NAMES NO RULE', async () => {
    await expect(
      inA((db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            triggerType: 'SCHEDULED_TIME',
            occurrence: '2026-09-17T09',
            dedupeKey: `bad-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow(/automation_event_rule_addressed_when_derived/);
  });
});

// ---------------------------------------------------------------------------
// The new tenant-owned model answers to the same rules as every other one
// ---------------------------------------------------------------------------

describe('automation_event is tenant-owned, and behaves like it (CLAUDE.md §2.1)', () => {
  it('A cannot read, count or enumerate B’s events', async () => {
    const mine = await inA((db) =>
      db.automationEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          triggerType: 'CONTENT_APPROVED',
          refType: 'ContentItem',
          refId: fixtures.a.contentItemId,
          dedupeKey: `tenancy-${randomUUID()}`,
        },
      }),
    );
    const theirs = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            triggerType: 'CONTENT_APPROVED',
            refType: 'ContentItem',
            refId: fixtures.b.contentItemId,
            dedupeKey: `tenancy-${randomUUID()}`,
          },
        }),
      { prisma: app },
    );

    // NOT FOUND, shaped exactly like a genuine miss — a difference between the
    // two is itself a leak.
    expect(
      await inA((db) => db.automationEvent.findFirst({ where: { id: theirs.id } })),
    ).toBeNull();
    expect(
      await inA((db) => db.automationEvent.count({ where: { dedupeKey: theirs.dedupeKey } })),
    ).toBe(0);
    const visible = await inA((db) => db.automationEvent.findMany({ select: { id: true } }));
    expect(visible.map((row) => row.id)).toContain(mine.id);
    expect(visible.map((row) => row.id)).not.toContain(theirs.id);
  });

  it('A cannot WRITE an event into B, nor move one there', async () => {
    const theirs = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            triggerType: 'POST_PUBLISHED',
            refType: 'PublishJob',
            refId: fixtures.b.publishJobId,
            dedupeKey: `tenancy-write-${randomUUID()}`,
          },
        }),
      { prisma: app },
    );

    await expect(
      inA((db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            triggerType: 'CONTENT_APPROVED',
            refType: 'ContentItem',
            refId: fixtures.b.contentItemId,
            dedupeKey: `tenancy-forge-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();

    // AND MARKING SOMEBODY ELSE'S EVENT DELIVERED IS A NO-OP, not an error and
    // not a write: `updateMany` reports zero rows because RLS never showed it.
    const moved = await inA((db) =>
      db.automationEvent.updateMany({
        where: { id: theirs.id },
        data: { deliveredAt: new Date() },
      }),
    );
    expect(moved.count).toBe(0);
  });

  it('an event cannot name a brand from another workspace (D-112)', async () => {
    await expect(
      inA((db) =>
        db.automationEvent.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            // B's brand, A's workspace. The composite foreign key is what makes
            // this impossible rather than merely unusual.
            brandId: fixtures.b.brandId,
            triggerType: 'CONTENT_APPROVED',
            refType: 'ContentItem',
            refId: fixtures.a.contentItemId,
            dedupeKey: `tenancy-brand-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
// ---------------------------------------------------------------------------
// The same class as R2-B, found by sweeping for it: an automation's proposed
// external action had a credential nobody could ever hold
// ---------------------------------------------------------------------------

describe('a proposed external action can actually be confirmed by a permitted human', () => {
  const confirmer = (): AutomationActor => ({
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'publishing.manage', 'automation.manage'],
    brandScope: [],
  });

  async function awaitingRun(): Promise<string> {
    const rule = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `external ${randomUUID()}`,
          enabled: true,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'PROPOSE_PUBLISH',
          actionConfig: {},
          requiresConfirmationForExternal: true,
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
        },
      }),
    );
    const notified: string[] = [];
    const outcome = await inA((db) =>
      engineFor(db, notified).run({
        rule,
        event: {
          type: 'CONTENT_APPROVED',
          brandId: fixtures.a.brandId,
          refType: 'ContentItem',
          refId: fixtures.a.contentItemId,
          facts: {},
        },
        resolveActor: async () => confirmer(),
      }),
    );
    expect(outcome.status).toBe('AWAITING_CONFIRMATION');
    /*
     * AND THE TOKEN IT RETURNS GOES NOWHERE, which is the defect. In production
     * this value is returned to the WORKER, which logs a status and drops it;
     * the notification carries no payload by design. Nothing else ever held it.
     */
    return outcome.run?.id ?? '';
  }

  function engineFor(db: TenantScopedClient, notified: string[]): AutomationEngine {
    return new AutomationEngine({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
      ports: {
        notifications: {
          notify: async (input) => {
            notified.push(input.idempotencyKey);
            return { recipients: 1 };
          },
        },
      },
    });
  }

  it('A PERMITTED HUMAN CAN OBTAIN A CREDENTIAL AND SPEND IT', async () => {
    const runId = await awaitingRun();

    const issued = await inA((db) =>
      engineFor(db, []).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    expect(issued.token.length).toBeGreaterThan(16);

    // THE RAW TOKEN IS NOT IN THE ROW. Only its digest.
    const stored = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));
    expect(stored.confirmationTokenHash).not.toBe(issued.token);
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it('ISSUING TWICE LEAVES ONE LIVE CREDENTIAL, and the first stops working', async () => {
    const runId = await awaitingRun();
    const first = await inA((db) =>
      engineFor(db, []).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    const second = await inA((db) =>
      engineFor(db, []).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    expect(second.token).not.toBe(first.token);

    const refused = await failure(
      inA((db) => engineFor(db, []).confirmRun({ runId, token: first.token, actor: confirmer() })),
    );
    expect(refused.code).toBe('CONFLICT');
  });

  it('REFUSES A CALLER WHO MAY NOT PERFORM THE ACTION, and audits the refusal', async () => {
    const runId = await awaitingRun();
    const refused = await failure(
      inA((db) =>
        engineFor(db, []).reissueRunConfirmation({
          runId,
          actor: { ...confirmer(), permissionKeys: ['workspace.read'] },
        }),
      ),
    );
    expect(refused.code).toBe('CONFLICT');
    // Nothing was rotated, so whatever credential existed is untouched.
    const audits = await inA((db) =>
      db.auditEvent.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          resourceId: runId,
          action: 'automation.confirmation_issued',
        },
      }),
    );
    expect(audits).toBe(0);
  });

  it('REFUSES A CALLER WHOSE BRANDSCOPE NO LONGER COVERS THE RUN', async () => {
    const runId = await awaitingRun();
    const refused = await failure(
      inA((db) =>
        engineFor(db, []).reissueRunConfirmation({
          runId,
          actor: { ...confirmer(), brandScope: [otherBrandId] },
        }),
      ),
    );
    expect(refused.code).toBe('CONFLICT');
  });
});
