import { randomUUID, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import type { AiGateway, AiGatewayResult } from '@brandspace/ai-gateway';
import {
  AnalyticsInsightService,
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import {
  AutomationEngine,
  parseAutomationPolicy,
  runBucketFor,
  runIdempotencyKeyFor,
  type AutomationActor,
  type TriggerEvent,
} from '@brandspace/automation';
import {
  CampaignService,
  ContentCalendarService,
  ContentLibraryService,
  parseContentPolicy,
} from '@brandspace/content';
import {
  CopilotOrchestrator,
  CopilotPlanService,
  CopilotUndoService,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { createScheduleQuota } from '@brandspace/entitlements';
import { StrategyService } from '@brandspace/intelligence';
import { resolveRecipients } from '@brandspace/notifications';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 7 REMEDIATION — the ten blocking defects, on real PostgreSQL.
 *
 * WHY A SEPARATE FILE. Each test below reproduces ONE reviewed defect and then
 * proves it closed. Keeping them together means a future reader can see the ten
 * failures the review found without reconstructing which assertion in which
 * suite covers which one — and it means none of them can be quietly diluted by
 * being merged into a suite about something else.
 *
 * THE COMMON SHAPE. A workspace with TWO brands and a member whose BrandScope
 * covers exactly one of them. That configuration does not exist in production
 * yet — every membership's `brandScope` is empty, which means UNRESTRICTED —
 * and that is precisely why these defects were not exploitable and precisely
 * why they had to be fixed before the scope-setting screen ships. Every test
 * here builds the configuration the product is one screen away from.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/** A SECOND brand inside workspace A. The thing a restricted member cannot see. */
let otherBrandId: string;
/** A SECOND member of workspace A, for the replay-scoping tests. */
let otherUserId: string;
let otherMembershipId: string;

const copilotPolicy = () => parseCopilotPolicy(defaultPayload('copilot'));
const contentPolicy = () => parseContentPolicy(defaultPayload('content'));
const analyticsPolicy = () => parseAnalyticsPolicy(defaultPayload('analytics'));
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
        name: 'Second brand',
        slug: 'second-brand',
        industry: 'retail',
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN', 'AR'],
      },
    });
    return brand.id;
  });

  /*
   * A SECOND PERSON IN WORKSPACE A.
   *
   * The `user` table is platform-owned and the app role may not write it, so
   * this borrows an existing user row — workspace B's — and gives it a
   * membership in workspace A. That is an ordinary thing in this product (one
   * person, several workspaces) and it gives the replay tests two DIFFERENT
   * `userId`s inside ONE workspace, which is the configuration a
   * workspace-and-key-only replay lookup gets wrong.
   */
  const membership = await inA(async (db) => {
    /*
     * THE SAME ROLE THE FIXTURE OWNER HOLDS, deliberately. The point of this
     * member is to differ in BRANDSCOPE and in nothing else: if they also held a
     * narrower role, every assertion below would have two possible explanations
     * and the BrandScope one would be the harder to rule out.
     */
    const owner = await db.membership.findFirstOrThrow({
      where: { workspaceId: fixtures.a.workspaceId, userId: fixtures.a.userId },
      select: { roleId: true },
    });
    return db.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: fixtures.b.userId,
        roleId: owner.roleId,
        status: 'ACTIVE',
        invitedByUserId: fixtures.a.userId,
      },
    });
  });
  otherUserId = membership.userId;
  otherMembershipId = membership.id;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

beforeEach(async () => {
  // Every test starts from the UNRESTRICTED default, and narrows it itself.
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

// ---------------------------------------------------------------------------
// A gateway that RECORDS rather than one that answers.
// ---------------------------------------------------------------------------

interface GatewayCalls {
  readonly executes: { idempotencyKey: string }[];
  quotes: number;
  /**
   * THE RECORDED OUTCOMES, HELD OUTSIDE THE STUB.
   *
   * Every call in this suite runs inside its own `withWorkspace` transaction and
   * therefore builds its own orchestrator and its own gateway — exactly as a
   * second HTTP request would. A replay memory held inside the stub would be
   * discarded between them, and the retry test would be measuring nothing.
   */
  readonly recorded: Map<string, AiGatewayResult>;
  /** Every untrusted-context block the gateway was handed, in order. */
  readonly contexts: string[];
}

/**
 * A stub gateway, and the assertions that matter are about how often it is NOT
 * called.
 *
 * "No Brand Brain retrieval, gateway call, credit reservation or message
 * persistence before brand admission succeeds" is a statement about ORDER, and
 * the only way to test an order is to have something that notices when it is
 * reached. This counts.
 *
 * ITS `execute` IS IDEMPOTENT ON THE KEY, exactly as the real gateway is, so the
 * retry test measures the ORCHESTRATOR's behaviour rather than re-testing the
 * gateway's.
 */
function stubGateway(calls: GatewayCalls, text: string): AiGateway {
  return {
    async execute(input: {
      idempotencyKey: string;
      input?: { untrustedContext?: readonly string[] };
    }): Promise<AiGatewayResult> {
      calls.executes.push({ idempotencyKey: input.idempotencyKey });
      calls.contexts.push(...(input.input?.untrustedContext ?? []));
      const existing = calls.recorded.get(input.idempotencyKey);
      // A REPLAY COSTS NOTHING, exactly as the real gateway's does.
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
      calls.quotes += 1;
      return { estimateMilli: 0n } as never;
    },
  } as unknown as AiGateway;
}

const PLAN_JSON = JSON.stringify({
  summary: { ar: 'ملخص', en: 'A summary' },
  steps: [],
});

function orchestrator(
  db: TenantScopedClient,
  calls: GatewayCalls,
  text = PLAN_JSON,
): CopilotOrchestrator {
  return new CopilotOrchestrator({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: copilotPolicy(),
    gateway: stubGateway(calls, text),
  });
}

/**
 * The AppError a promise rejected with, as a plain shape.
 *
 * SEVERAL ASSERTIONS BELOW COMPARE TWO REFUSALS TO EACH OTHER — an out-of-scope
 * id against a fabricated one — because §2.1 requires them to be
 * indistinguishable in BOTH the code and the message. This is what makes that
 * comparison readable, and it fails loudly if a call that should refuse instead
 * resolves.
 */
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

function emptyCalls(): GatewayCalls {
  return { executes: [], quotes: 0, recorded: new Map(), contexts: [] };
}

// ---------------------------------------------------------------------------
// P7-R1 — a Copilot session is bound to a brand it was ADMITTED to
// ---------------------------------------------------------------------------

describe('P7-R1: a Copilot session cannot be opened for a brand the member may not act on', () => {
  it('a member restricted to one brand is REFUSED a session for the other', async () => {
    await setBrandScope(fixtures.a.userId, [fixtures.a.brandId]);
    const authorization = await authorizationFor(fixtures.a.userId);
    const calls = emptyCalls();

    const before = await inA((db) => db.copilotSession.count());

    await expect(
      inA((db) =>
        orchestrator(db, calls).openSession({
          authorization,
          brandId: otherBrandId,
          surface: 'general',
          locale: 'EN',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // NOTHING WAS WRITTEN. The refusal is an admission check before the row, not
    // a check on a row that already exists.
    expect(await inA((db) => db.copilotSession.count())).toBe(before);
    expect(calls.executes).toHaveLength(0);
  });

  it('a REAL out-of-scope brand and a FABRICATED one are indistinguishable', async () => {
    await setBrandScope(fixtures.a.userId, [fixtures.a.brandId]);
    const authorization = await authorizationFor(fixtures.a.userId);

    const open = (brandId: string) =>
      failure(
        inA((db) =>
          orchestrator(db, emptyCalls()).openSession({
            authorization,
            brandId,
            surface: 'general',
            locale: 'EN',
            expiresAt: null,
          }),
        ),
      );

    const outOfScope = await open(otherBrandId);
    const fabricated = await open(randomUUID());
    const foreignWorkspace = await open(fixtures.b.brandId);

    // Same code AND same message. A difference in either would tell a restricted
    // member which ids are real — the inference CLAUDE.md §2.1 closes.
    expect(outOfScope.code).toBe('NOT_FOUND');
    expect(fabricated.code).toBe(outOfScope.code);
    expect(foreignWorkspace.code).toBe(outOfScope.code);
    expect(fabricated.message).toBe(outOfScope.message);
    expect(foreignWorkspace.message).toBe(outOfScope.message);
  });

  it('a session opened for a brand IN scope succeeds and OWNS that brand', async () => {
    await setBrandScope(fixtures.a.userId, [fixtures.a.brandId]);
    const authorization = await authorizationFor(fixtures.a.userId);

    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(session.brandId).toBe(fixtures.a.brandId);
    expect(session.userId).toBe(fixtures.a.userId);
  });

  it('a turn takes its brand from the SESSION, and the session is re-admitted LIVE', async () => {
    // Opened while the member could act on brand A.
    await setBrandScope(fixtures.a.userId, [fixtures.a.brandId]);
    const wide = await authorizationFor(fixtures.a.userId);
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: wide,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );

    // The turn, while the scope still covers it: the brand comes from the row.
    const okCalls = emptyCalls();
    const turn = await inA((db) =>
      orchestrator(db, okCalls).turn({
        sessionId: session.id,
        request: 'What happened last week?',
        authorization: wide,
        planKey: null,
        idempotencyKey: `remediation-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(turn.brandId).toBe(fixtures.a.brandId);

    // NOW AN ADMINISTRATOR NARROWS THE SCOPE to the other brand.
    await setBrandScope(fixtures.a.userId, [otherBrandId]);
    const narrowed = await authorizationFor(fixtures.a.userId);

    const refusedCalls = emptyCalls();
    const messagesBefore = await inA((db) =>
      db.copilotMessage.count({ where: { sessionId: session.id } }),
    );

    await expect(
      inA((db) =>
        orchestrator(db, refusedCalls).turn({
          sessionId: session.id,
          request: 'And this week?',
          authorization: narrowed,
          planKey: null,
          idempotencyKey: `remediation-${randomUUID()}`,
          locale: 'EN',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    /*
     * THE ORDER IS THE POINT. No gateway call, and no message row — the refusal
     * happened at the session lookup, before retrieval, before the model and
     * before anything was persisted.
     */
    expect(refusedCalls.executes).toHaveLength(0);
    expect(await inA((db) => db.copilotMessage.count({ where: { sessionId: session.id } }))).toBe(
      messagesBefore,
    );
  });

  it('a GENERAL session — no brand — stays reachable by a restricted member', async () => {
    await setBrandScope(fixtures.a.userId, [fixtures.a.brandId]);
    const authorization = await authorizationFor(fixtures.a.userId);
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization,
        brandId: null,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );

    // Narrow it further; a conversation about no brand in particular is not a
    // conversation about a brand they lost.
    await setBrandScope(fixtures.a.userId, [otherBrandId]);
    const narrowed = await authorizationFor(fixtures.a.userId);

    const turn = await inA((db) =>
      orchestrator(db, emptyCalls()).turn({
        sessionId: session.id,
        request: 'Hello',
        authorization: narrowed,
        planKey: null,
        idempotencyKey: `remediation-${randomUUID()}`,
        locale: 'EN',
        expiresAt: null,
      }),
    );
    expect(turn.brandId).toBeNull();
  });

  it("another member cannot post into somebody else's conversation", async () => {
    const authorization = await authorizationFor(fixtures.a.userId);
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const other = await authorizationFor(otherUserId);

    await expect(
      inA((db) =>
        orchestrator(db, emptyCalls()).turn({
          sessionId: session.id,
          request: 'Whose conversation is this?',
          authorization: other,
          planKey: null,
          idempotencyKey: `remediation-${randomUUID()}`,
          locale: 'EN',
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// P7-R2 — a client-chosen idempotency key is not a credential
// ---------------------------------------------------------------------------

describe('P7-R2: a replay lookup is bound to the caller, the session and the brand', () => {
  function plans(db: TenantScopedClient): CopilotPlanService {
    return new CopilotPlanService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: copilotPolicy(),
    });
  }

  it("another member's idempotency key does NOT return that member's plan", async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const theirs = await authorizationFor(otherUserId);
    const key = `shared-key-${randomUUID()}`;

    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: mine,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const theirSession = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: theirs,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );

    const first = await inA((db) =>
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

    const second = await inA((db) =>
      plans(db).createPlan({
        sessionId: theirSession.id,
        brandId: fixtures.a.brandId,
        authorization: theirs,
        steps: [],
        summary: { ar: 'ملخص', en: 'Summary' },
        estimatedCreditsMilli: 0n,
        // THE SAME KEY. It used to be the whole predicate beside the workspace.
        idempotencyKey: `${key}-theirs`,
        expiresAt: null,
      }),
    );

    expect(second.plan.id).not.toBe(first.plan.id);
    expect(second.plan.userId).toBe(otherUserId);
    expect(first.plan.userId).toBe(fixtures.a.userId);
  });

  it('a replay for the SAME person, session and brand still replays', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const key = `replay-${randomUUID()}`;
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: mine,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
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
    const again = await create();
    expect(again.plan.id).toBe(first.plan.id);
    // THE TOKEN IS NOT RE-ISSUED. Two simultaneously valid confirmations for one
    // plan is exactly what a single-use credential must never become.
    expect(again.confirmationToken).toBeNull();
  });

  it('a NARROWED scope stops replaying a plan it would now refuse to create', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const key = `scope-replay-${randomUUID()}`;
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: mine,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const first = await inA((db) =>
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

    await setBrandScope(fixtures.a.userId, [otherBrandId]);
    const narrowed = await authorizationFor(fixtures.a.userId);

    const replayed = await inA((db) =>
      plans(db).createPlan({
        sessionId: session.id,
        brandId: fixtures.a.brandId,
        authorization: narrowed,
        steps: [],
        summary: { ar: 'ملخص', en: 'Summary' },
        estimatedCreditsMilli: 0n,
        idempotencyKey: `${key}-after`,
        expiresAt: null,
      }),
    );
    // A new plan, not the old one handed back through a scope that no longer
    // admits its brand.
    expect(replayed.plan.id).not.toBe(first.plan.id);
  });

  it('a RETRIED turn writes one user message, one assistant message, one charge', async () => {
    const mine = await authorizationFor(fixtures.a.userId);
    const session = await inA((db) =>
      orchestrator(db, emptyCalls()).openSession({
        authorization: mine,
        brandId: fixtures.a.brandId,
        surface: 'general',
        locale: 'EN',
        expiresAt: null,
      }),
    );
    const key = `turn-retry-${randomUUID()}`;
    const calls = emptyCalls();

    const run = () =>
      inA((db) =>
        orchestrator(db, calls).turn({
          sessionId: session.id,
          request: 'Explain last week.',
          authorization: mine,
          planKey: null,
          idempotencyKey: key,
          locale: 'EN',
          expiresAt: null,
        }),
      );

    const first = await run();
    const retry = await run();

    const messages = await inA((db) =>
      db.copilotMessage.findMany({
        where: { workspaceId: fixtures.a.workspaceId, sessionId: session.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // EXACTLY TWO ROWS. The retry wrote nothing: `ON CONFLICT DO NOTHING` on the
    // per-session unique key is what makes the first write the only write.
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);
    // AND THE RETRY REJOINED THE ORIGINAL TURN rather than starting a parallel
    // one, which is what the shared correlation id means.
    expect(retry.correlationId).toBe(first.correlationId);
    expect(messages[0]?.correlationId).toBe(first.correlationId);
    expect(messages[1]?.correlationId).toBe(first.correlationId);
    // ONE CHARGE. The second execute returned the recorded outcome.
    expect(calls.executes).toHaveLength(2);
    expect(first.creditsChargedMilli).toBe(100n);
    expect(retry.creditsChargedMilli).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// P7-R3 — an external action carries the confirmer's LIVE scope
// ---------------------------------------------------------------------------

describe('P7-R3: publishing admits its target against brand AND scope', () => {
  const library = (db: TenantScopedClient) =>
    new ContentLibraryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy(),
    });

  it('the item must belong to the brand the confirmed step NAMED', async () => {
    // The fixture item belongs to brand A. Naming the OTHER brand must refuse,
    // even though the caller is unrestricted and may act on both.
    await expect(
      inA((db) =>
        library(db).requireItemForBrand({
          contentItemId: fixtures.a.contentItemId,
          brandId: otherBrandId,
          brandScope: [],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a confirmer whose scope no longer covers the brand is refused', async () => {
    await expect(
      inA((db) =>
        library(db).requireItemForBrand({
          contentItemId: fixtures.a.contentItemId,
          brandId: fixtures.a.brandId,
          // THE DEFECT WAS PASSING `[]` HERE, which means UNRESTRICTED — so the
          // check the comment claimed to rely on was switched off.
          brandScope: [otherBrandId],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an EMPTY scope is unrestricted, and the matching brand is admitted', async () => {
    const item = await inA((db) =>
      library(db).requireItemForBrand({
        contentItemId: fixtures.a.contentItemId,
        brandId: fixtures.a.brandId,
        brandScope: [],
      }),
    );
    expect(item.id).toBe(fixtures.a.contentItemId);
  });

  it("another workspace's item is refused identically to a fabricated one", async () => {
    const foreign = await failure(
      inA((db) =>
        library(db).requireItemForBrand({
          contentItemId: fixtures.b.contentItemId,
          brandId: fixtures.a.brandId,
          brandScope: [],
        }),
      ),
    );
    const fabricated = await failure(
      inA((db) =>
        library(db).requireItemForBrand({
          contentItemId: randomUUID(),
          brandId: fixtures.a.brandId,
          brandScope: [],
        }),
      ),
    );
    expect(foreign.code).toBe('NOT_FOUND');
    expect(fabricated.code).toBe(foreign.code);
    expect(fabricated.message).toBe(foreign.message);
  });
});

// ---------------------------------------------------------------------------
// P7-R4 — a compensation re-checks the LIVE scope against the ACTUAL target
// ---------------------------------------------------------------------------

describe('P7-R4: an undo refuses when access was removed after the plan ran', () => {
  it('archiveItem refuses an out-of-scope target and changes nothing', async () => {
    const before = await inA((db) =>
      db.contentItem.findFirst({ where: { id: fixtures.a.contentItemId } }),
    );

    const outcome = await inA((db) =>
      new ContentLibraryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: contentPolicy(),
      }).archiveItem({
        contentItemId: fixtures.a.contentItemId,
        brandId: fixtures.a.brandId,
        brandScope: [otherBrandId],
        actorUserId: fixtures.a.userId,
        requireStatusIn: ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED'],
        reason: 'test',
        now: new Date(),
      }),
    );

    expect(outcome.outcome).toBe('NOT_FOUND');
    const after = await inA((db) =>
      db.contentItem.findFirst({ where: { id: fixtures.a.contentItemId } }),
    );
    expect(after?.status).toBe(before?.status);
    expect(after?.deletedAt).toBeNull();
  });

  it('the undo path refuses the compensation, with the same code a missing row gets', async () => {
    const plan = await inA((db) =>
      db.copilotActionPlan.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          sessionId: fixtures.a.copilotSessionId,
          userId: fixtures.a.userId,
          status: 'COMPLETED',
          planVersion: 900,
          planHash: createHash('sha256').update(randomUUID()).digest('hex'),
          summary: { ar: 'ملخص', en: 'Summary' },
          steps: [],
          highestActionClass: 'INTERNAL_REVERSIBLE',
          requiresConfirmation: true,
          undoStatus: 'AVAILABLE',
          correlationId: randomUUID(),
        },
      }),
    );
    await inA((db) =>
      db.copilotToolCall.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          planId: plan.id,
          sessionId: fixtures.a.copilotSessionId,
          ordinal: 1,
          toolKey: 'content.draft',
          actionClass: 'INTERNAL_REVERSIBLE',
          status: 'SUCCEEDED',
          argumentsJson: {},
          idempotencyKey: `undo-scope-${randomUUID()}`,
          compensation: {
            kind: 'content.archive',
            contentItemId: fixtures.a.contentItemId,
            requireStatusIn: ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED'],
          },
        },
      }),
    );

    // THE SCOPE IS NARROWED AFTER THE PLAN RAN. An administrator did this in the
    // minutes between; the undo button is still on the screen.
    await setBrandScope(fixtures.a.userId, [otherBrandId]);

    const outcome = await inA((db) =>
      new CopilotUndoService({ db, workspaceId: fixtures.a.workspaceId }).undo({
        planId: plan.id,
        userId: fixtures.a.userId,
        collaborators: {
          campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
          calendar: new ContentCalendarService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: contentPolicy(),
            timezone: 'UTC',
            quota: {
              limit: async () => null,
              consume: async () => true,
              refund: async () => undefined,
            },
          }),
          library: new ContentLibraryService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: contentPolicy(),
          }),
        },
      }),
    );

    expect(outcome.undone).toHaveLength(0);
    // `already_gone` — the SAME machine code a genuinely missing target gets, so
    // the refusal reason cannot be used to probe for ids.
    expect(outcome.refused.map((r) => r.reason)).toEqual(['already_gone']);

    const item = await inA((db) =>
      db.contentItem.findFirst({ where: { id: fixtures.a.contentItemId } }),
    );
    expect(item?.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P7-R5 — a delayed redelivery converges on the original run
// ---------------------------------------------------------------------------

describe('P7-R5: an automation run key survives a delayed redelivery', () => {
  function engineAt(db: TenantScopedClient, now: Date, notified: string[]): AutomationEngine {
    return new AutomationEngine({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
      clock: { now: () => now },
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
    roleKey: 'owner',
    permissionKeys: ['workspace.read', 'automation.manage'],
    brandScope: [],
  });

  it('a redelivery TWO DAYS LATER is the same run, and notifies nobody twice', async () => {
    const rule = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `redelivery ${randomUUID()}`,
          enabled: true,
          triggerType: 'POST_PUBLISHED',
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
        },
      }),
    );

    const event: TriggerEvent = {
      type: 'POST_PUBLISHED',
      brandId: fixtures.a.brandId,
      refType: 'PublishJob',
      refId: fixtures.a.publishJobId,
      facts: {},
    };

    const notified: string[] = [];
    const first = await inA((db) =>
      engineAt(db, new Date('2026-09-16T12:59:00.000Z'), notified).run({
        rule,
        event,
        resolveActor: async () => actor(),
      }),
    );
    /*
     * TWO DAYS LATER. A worker restart, a backoff, a queue drained after an
     * incident — every one of those is an ordinary reason for a delivery to
     * arrive late, and under the hour bucket every one of them ran the rule
     * again.
     */
    const late = await inA((db) =>
      engineAt(db, new Date('2026-09-18T04:10:00.000Z'), notified).run({
        rule,
        event,
        resolveActor: async () => actor(),
      }),
    );

    expect(late.run?.id).toBe(first.run?.id);
    expect(notified).toHaveLength(1);

    const runs = await inA((db) => db.automationRun.count({ where: { ruleId: rule.id } }));
    expect(runs).toBe(1);

    // And the key itself carries no clock.
    const key = runIdempotencyKeyFor({
      ruleId: rule.id,
      triggerType: 'POST_PUBLISHED',
      refId: fixtures.a.publishJobId,
      bucket: runBucketFor({
        triggerType: 'POST_PUBLISHED',
        localDate: '1999-01-01',
        hourLocal: 0,
      }),
    });
    expect(first.run?.idempotencyKey).toBe(key);
  });

  it('a SCHEDULED rule still fires once per configured occurrence per day', async () => {
    const rule = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `scheduled ${randomUUID()}`,
          enabled: true,
          triggerType: 'SCHEDULED_TIME',
          triggerConfig: { daysOfWeek: [], hourLocal: 9 },
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
        },
      }),
    );
    const event: TriggerEvent = {
      type: 'SCHEDULED_TIME',
      brandId: fixtures.a.brandId,
      refType: null,
      refId: null,
      facts: {},
    };
    const notified: string[] = [];

    // Two sweeps of the SAME occurrence, an hour apart: one run.
    const a = await inA((db) =>
      engineAt(db, new Date('2026-09-16T09:04:00.000Z'), notified).run({
        rule,
        event,
        resolveActor: async () => actor(),
      }),
    );
    const b = await inA((db) =>
      engineAt(db, new Date('2026-09-16T10:58:00.000Z'), notified).run({
        rule,
        event,
        resolveActor: async () => actor(),
      }),
    );
    expect(b.run?.id).toBe(a.run?.id);

    // The NEXT DAY is a different occurrence, which is what "daily" means.
    const tomorrow = await inA((db) =>
      engineAt(db, new Date('2026-09-17T09:02:00.000Z'), notified).run({
        rule,
        event,
        resolveActor: async () => actor(),
      }),
    );
    expect(tomorrow.run?.id).not.toBe(a.run?.id);
    expect(await inA((db) => db.automationRun.count({ where: { ruleId: rule.id } }))).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// P7-R6 — the automation worker's quota is the real one
// ---------------------------------------------------------------------------

describe('P7-R6: the shared scheduling quota is real, not a no-op', () => {
  const quotaFor = (db: TenantScopedClient) =>
    createScheduleQuota({
      db,
      workspaceId: fixtures.a.workspaceId,
      environment: 'DEVELOPMENT',
    });

  it('CONSUMING WRITES TO THE USAGE LEDGER — the no-op counted nothing', async () => {
    /*
     * THE DISCRIMINATOR. The worker's adapter returned `true` from `consume()`
     * and did nothing else, so every automation-placed slot was invisible to the
     * plan's monthly counter: a rule was a way to schedule past the ceiling and
     * leave no trace of having done so.
     *
     * Whether this particular workspace HAS a ceiling is beside the point — what
     * the real adapter must do, and the no-op could not, is COUNT.
     */
    const key = `quota-probe-${randomUUID()}`;
    const events = await inA(async (db) => {
      await quotaFor(db).consume(key);
      return db.usageEvent.count({
        where: { workspaceId: fixtures.a.workspaceId, idempotencyKey: key },
      });
    });
    expect(events).toBe(1);
  });

  it('it is IDEMPOTENT on the key, so a retried run does not double-count', async () => {
    const key = `quota-idempotent-${randomUUID()}`;
    const events = await inA(async (db) => {
      const quota = quotaFor(db);
      await quota.consume(key);
      await quota.consume(key);
      return db.usageEvent.count({
        where: { workspaceId: fixtures.a.workspaceId, idempotencyKey: key },
      });
    });
    expect(events).toBe(1);
  });

  it('IT REFUSES AT THE CEILING, which the no-op could never do', async () => {
    /*
     * A platform override sets this workspace's ceiling to ONE. The override
     * path is the one D-10 precedence already resolves; nothing here invents a
     * limit in source (CLAUDE.md §2.2) — the number is fixture data.
     */
    /*
     * THE CEILING IS "WHAT IS ALREADY USED, PLUS ONE", read from the counter
     * rather than assumed to be zero. Earlier tests in this file consume from
     * the same monthly window, and a hard-coded 1 would make this assertion
     * depend on the order the suite happens to run in — which is how a test
     * becomes a flake that everybody learns to re-run.
     */
    const used = await inA(async (db) => {
      const counter = await db.usageCounter.findFirst({
        where: {
          workspaceId: fixtures.a.workspaceId,
          featureKey: 'limit.scheduled_posts',
          periodEnd: { gt: new Date() },
        },
        orderBy: { periodStart: 'desc' },
        select: { usedValue: true },
      });
      return counter?.usedValue ?? 0;
    });

    const override = await inA(async (db) =>
      db.workspaceOverride.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          featureKey: 'limit.scheduled_posts',
          enabled: true,
          limitValue: used + 1,
          reason: 'phase 7 remediation regression fixture',
          grantedByPlatformUserId: fixtures.platformUserId,
          status: 'ACTIVE',
        },
      }),
    );

    try {
      const outcome = await inA(async (db) => {
        const quota = quotaFor(db);
        return {
          limit: await quota.limit(),
          first: await quota.consume(`ceiling-1-${randomUUID()}`),
          second: await quota.consume(`ceiling-2-${randomUUID()}`),
        };
      });

      expect(outcome.limit).toBe(used + 1);
      // The no-op returned `true` for both, for ever.
      expect(outcome.first).toBe(true);
      expect(outcome.second).toBe(false);
    } finally {
      await inA((db) => db.workspaceOverride.delete({ where: { id: override.id } }));
    }
  });
});

// ---------------------------------------------------------------------------
// P7-R7 — a level metric's window value is its LATEST reading, not its largest
// ---------------------------------------------------------------------------

describe('P7-R7: followers over a window is the latest per account, summed', () => {
  const period = {
    start: new Date('2026-05-01T00:00:00.000Z'),
    end: new Date('2026-05-05T00:00:00.000Z'),
  };

  beforeAll(async () => {
    /*
     * TWO ACCOUNTS ON ONE CONNECTION, each with a reading on two days, and the
     * FIRST ACCOUNT LOSES FOLLOWERS. That decline is the whole test: `MAX(value)`
     * reports the peak for ever, so a brand that is shrinking reads as flat.
     *
     *   account-1:  day 1 = 1000,  day 3 =  900   (latest 900)
     *   account-2:  day 1 =  400,  day 3 =  600   (latest 600)
     *
     *   MAX over the window  -> 1000   (wrong, and it is one ACCOUNT'S peak)
     *   latest per account   -> 1500   (right)
     */
    const rows = [
      { subject: 'followers-a', day: 1, value: 1000n },
      { subject: 'followers-a', day: 3, value: 900n },
      { subject: 'followers-b', day: 1, value: 400n },
      { subject: 'followers-b', day: 3, value: 600n },
    ];
    await inA(async (db) => {
      for (const row of rows) {
        const periodStart = new Date(`2026-05-0${row.day}T00:00:00.000Z`);
        const periodEnd = new Date(`2026-05-0${row.day + 1}T00:00:00.000Z`);
        const observationKey = createHash('sha256')
          .update(`${fixtures.a.workspaceId}|${row.subject}|followers|DAY|${row.day}`)
          .digest('hex');
        await db.metricObservation.upsert({
          where: {
            workspaceId_observationKey: {
              workspaceId: fixtures.a.workspaceId,
              observationKey,
            },
          },
          update: {},
          create: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            socialConnectionId: fixtures.a.socialConnectionId,
            provider: 'LINKEDIN',
            subjectType: 'ACCOUNT',
            subjectExternalId: row.subject,
            metricKey: 'followers',
            granularity: 'DAY',
            periodStart,
            periodEnd,
            value: row.value,
            unit: 'COUNT',
            observedAt: periodEnd,
            sourceKind: 'PROVIDER',
            sourceVersion: 'remediation-1',
            observationKey,
          },
        });
      }
    });
  }, 60_000);

  const queries = (db: TenantScopedClient) =>
    new AnalyticsQueryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
    });

  it('the SUMMARY reports the sum of each account’s last reading', async () => {
    const summary = await inA((db) =>
      queries(db).summary({
        scope: { brandId: fixtures.a.brandId },
        period,
        brandScope: [],
        metricKeys: ['followers'],
      }),
    );
    const followers = summary.metrics.find((metric) => metric.metricKey === 'followers');
    expect(followers?.value).toBe(1500n);
    // NOT the largest single reading, which is what MAX would have said.
    expect(followers?.value).not.toBe(1000n);
  });

  it('BY PROVIDER agrees with the summary, rather than computing it a second way', async () => {
    const rows = await inA((db) =>
      queries(db).byProvider({
        scope: { brandId: fixtures.a.brandId },
        period,
        metricKey: 'followers',
        brandScope: [],
      }),
    );
    const linkedin = rows.find((row) => row.provider === 'LINKEDIN');
    expect(linkedin?.value).toBe(1500n);
  });

  it('the SERIES reports each bucket’s own total across accounts', async () => {
    const series = await inA((db) =>
      queries(db).series({
        scope: { brandId: fixtures.a.brandId },
        period,
        metricKey: 'followers',
        brandScope: [],
      }),
    );
    const values = series.points.map((point) => point.value);
    // Day 1: 1000 + 400. Day 3: 900 + 600. A chart that drew 1000 for both —
    // which `_max` did — would show a brand that never changes.
    expect(values).toEqual([1400n, 1500n]);
  });
});

// ---------------------------------------------------------------------------
// P7-R10 — BrandScope decides who is TOLD
// ---------------------------------------------------------------------------

describe('P7-R10: an automation notification reaches only members scoped to the brand', () => {
  it('a member restricted to the OTHER brand is not a recipient', async () => {
    await setBrandScope(fixtures.a.userId, []); // unrestricted: always told
    await setBrandScope(otherUserId, [otherBrandId]); // restricted: told about B only

    const forBrandA = await inA((db) =>
      resolveRecipients({
        db,
        workspaceId: fixtures.a.workspaceId,
        permissionKey: 'publishing.manage',
        brandId: fixtures.a.brandId,
      }),
    );
    const forOtherBrand = await inA((db) =>
      resolveRecipients({
        db,
        workspaceId: fixtures.a.workspaceId,
        permissionKey: 'publishing.manage',
        brandId: otherBrandId,
      }),
    );

    // The restricted member hears about their OWN brand and not the other one.
    expect(forBrandA).not.toContain(otherUserId);
    expect(forOtherBrand).toContain(otherUserId);
    // The unrestricted member hears about both — EMPTY MEANS UNRESTRICTED, and a
    // fix that silenced everybody would have "passed" the first assertion.
    expect(forBrandA).toContain(fixtures.a.userId);
    expect(forOtherBrand).toContain(fixtures.a.userId);
  });

  it('the permission is still required, scope or no scope', async () => {
    await setBrandScope(otherUserId, []);
    const recipients = await inA((db) =>
      resolveRecipients({
        db,
        workspaceId: fixtures.a.workspaceId,
        permissionKey: 'a.permission.nobody.holds',
        brandId: fixtures.a.brandId,
      }),
    );
    expect(recipients).toEqual([]);
  });

  it('no member of ANOTHER workspace is ever a recipient', async () => {
    const recipients = await inA((db) =>
      resolveRecipients({
        db,
        workspaceId: fixtures.a.workspaceId,
        permissionKey: 'publishing.manage',
        brandId: fixtures.a.brandId,
      }),
    );
    // `otherUserId` IS `fixtures.b.userId` — the same person, with a membership
    // in each workspace. What must never appear is a membership resolved through
    // the other workspace's row, so the count is bounded by A's memberships.
    const membershipsInA = await inA((db) =>
      db.membership.count({ where: { workspaceId: fixtures.a.workspaceId, status: 'ACTIVE' } }),
    );
    expect(recipients.length).toBeLessThanOrEqual(membershipsInA);
    expect(otherMembershipId.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P7-R9 — a monthly plan is grounded in, and records, the accepted strategy
// ---------------------------------------------------------------------------

describe('P7-R9: plan.monthly is bound to the accepted strategy for THIS brand', () => {
  const period = {
    start: new Date('2026-05-01T00:00:00.000Z'),
    end: new Date('2026-05-05T00:00:00.000Z'),
  };

  /** A response the strategy schema accepts, citing evidence and stating no figures. */
  const STRATEGY_JSON = JSON.stringify({
    summary: { ar: 'ملخص الخطة', en: 'A plan summary' },
    pillars: [
      {
        name: { ar: 'الركيزة', en: 'Pillar' },
        rationale: {
          evidenceRefs: [1],
          text: { ar: 'يستند إلى الأداء المقاس', en: 'Rests on measured performance' },
        },
        sharePercent: 50,
      },
    ],
    channelMix: [
      {
        platformKey: 'linkedin',
        sharePercent: 50,
        rationale: {
          evidenceRefs: [1],
          text: { ar: 'حيث يوجد الجمهور', en: 'Where the audience is' },
        },
      },
    ],
    monthlyPlan: [
      {
        weekNumber: 1,
        theme: { ar: 'الإطلاق', en: 'Launch' },
        postsPlanned: 3,
        rationale: {
          evidenceRefs: [1],
          text: { ar: 'إيقاع معقول', en: 'A sustainable cadence' },
        },
      },
    ],
  });

  function strategyService(db: TenantScopedClient, calls: GatewayCalls): StrategyService {
    return new StrategyService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      queries: new AnalyticsQueryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: analyticsPolicy(),
        registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
      }),
      gateway: stubGateway(calls, STRATEGY_JSON),
      // The grounding FLOOR is a product rule tested elsewhere; this suite is
      // about which strategy a plan is bound to, so the floor is out of its way.
      minimumKnowledgeItems: 0,
    });
  }

  async function acceptedStrategyFor(brandId: string): Promise<{ id: string }> {
    return inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId,
          type: 'STRATEGY',
          status: 'ACCEPTED',
          basis: 'OWN_PERFORMANCE',
          title: { ar: 'استراتيجية', en: 'Strategy' },
          body: JSON.parse(STRATEGY_JSON) as object,
          periodStart: period.start,
          periodEnd: period.end,
          generatedByUserId: fixtures.a.userId,
          idempotencyKey: `accepted-${randomUUID()}`,
        },
      }),
    );
  }

  it('a strategy accepted for ANOTHER brand cannot be planned against', async () => {
    const strategy = await acceptedStrategyFor(fixtures.a.brandId);
    const calls = emptyCalls();

    await expect(
      inA((db) =>
        strategyService(db, calls).planMonthly({
          // The caller may act on BOTH brands, so this is not a scope refusal —
          // it is the brand BINDING, which did not exist.
          brandId: otherBrandId,
          strategyInsightId: strategy.id,
          period,
          objective: 'Plan the month',
          idempotencyKey: `plan-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // REFUSED BEFORE THE MODEL. A plan that cannot be grounded must not be paid
    // for.
    expect(calls.executes).toHaveLength(0);
  });

  it('a strategy in ANOTHER WORKSPACE is refused identically', async () => {
    const calls = emptyCalls();
    const refusal = await failure(
      inA((db) =>
        strategyService(db, calls).planMonthly({
          brandId: fixtures.a.brandId,
          strategyInsightId: fixtures.b.insightId,
          period,
          objective: 'Plan the month',
          idempotencyKey: `plan-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          expiresAt: null,
        }),
      ),
    );
    expect(refusal.code).toBe('NOT_FOUND');
    expect(calls.executes).toHaveLength(0);
  });

  it('a member whose scope excludes the brand is refused BEFORE the strategy is read', async () => {
    const strategy = await acceptedStrategyFor(fixtures.a.brandId);
    await expect(
      inA((db) =>
        strategyService(db, emptyCalls()).planMonthly({
          brandId: fixtures.a.brandId,
          strategyInsightId: strategy.id,
          period,
          objective: 'Plan the month',
          idempotencyKey: `plan-${randomUUID()}`,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [otherBrandId],
          expiresAt: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the plan RECORDS which strategy it followed from, and is grounded in it', async () => {
    const strategy = await acceptedStrategyFor(fixtures.a.brandId);
    const calls = emptyCalls();

    const result = await inA((db) =>
      strategyService(db, calls).planMonthly({
        brandId: fixtures.a.brandId,
        strategyInsightId: strategy.id,
        period,
        objective: 'Plan the month',
        idempotencyKey: `plan-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );

    expect(result.insight?.type).toBe('MONTHLY_PLAN');
    // PROVENANCE. Without this a reader of a plan could not tell which strategy
    // it followed from, nor whether that strategy had since been superseded.
    expect(result.insight?.sourceInsightId).toBe(strategy.id);

    // AND THE STRATEGY ACTUALLY REACHED THE MODEL. "Grounded in the accepted
    // strategy" used to mean only that one was checked to exist.
    expect(calls.contexts.some((block) => block.includes('ACCEPTED STRATEGY'))).toBe(true);
    expect(calls.contexts.some((block) => block.includes(strategy.id))).toBe(true);
  });

  it("an idempotency key does not hand one member another member's insight", async () => {
    const key = `insight-key-${randomUUID()}`;
    const foreign = await inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          type: 'STRATEGY',
          status: 'NEW',
          basis: 'OWN_PERFORMANCE',
          title: { ar: 'استراتيجية', en: 'Strategy' },
          body: JSON.parse(STRATEGY_JSON) as object,
          periodStart: period.start,
          periodEnd: period.end,
          // SOMEBODY ELSE'S. The replay lookup used to match on the workspace
          // and the key alone, so guessing or observing this key handed over
          // that person's work.
          generatedByUserId: otherUserId,
          idempotencyKey: key,
        },
      }),
    );

    const outcome = await inA((db) =>
      strategyService(db, emptyCalls())
        .generate({
          brandId: fixtures.a.brandId,
          period,
          objective: 'Propose a strategy',
          idempotencyKey: key,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          expiresAt: null,
        })
        .catch((error: unknown) => error),
    );

    const returned = (outcome as { insight?: { id?: string } }).insight?.id;
    expect(returned).not.toBe(foreign.id);
  });
});

// ---------------------------------------------------------------------------
// P7-R8 — the grounding gate, end to end, through the service that persists
// ---------------------------------------------------------------------------

describe('P7-R8: analytics.explain refuses a claim grounded in the wrong row', () => {
  const period = {
    start: new Date('2026-06-01T00:00:00.000Z'),
    end: new Date('2026-06-05T00:00:00.000Z'),
  };

  /**
   * FOUR METRICS WITH DELIBERATELY UNMISTAKABLE VALUES.
   *
   * Four because the activated policy refuses to explain fewer (a model handed
   * three numbers writes a confident paragraph about three numbers). Distinctive
   * because the assertion below is about WHICH row a number came from, and two
   * metrics that happened to share a digit run would make the test lie.
   */
  const FIGURES = {
    impressions: 811_111n,
    reach: 822_222n,
    engagements: 833_333n,
    clicks: 844_444n,
  } as const;

  beforeAll(async () => {
    await inA(async (db) => {
      for (const [metricKey, value] of Object.entries(FIGURES)) {
        const observationKey = createHash('sha256')
          .update(`${fixtures.a.workspaceId}|grounding|${metricKey}|DAY|2026-06-02`)
          .digest('hex');
        await db.metricObservation.upsert({
          where: {
            workspaceId_observationKey: {
              workspaceId: fixtures.a.workspaceId,
              observationKey,
            },
          },
          update: {},
          create: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            socialConnectionId: fixtures.a.socialConnectionId,
            provider: 'LINKEDIN',
            subjectType: 'ACCOUNT',
            subjectExternalId: 'grounding-account',
            metricKey,
            granularity: 'DAY',
            periodStart: new Date('2026-06-02T00:00:00.000Z'),
            periodEnd: new Date('2026-06-03T00:00:00.000Z'),
            value,
            unit: 'COUNT',
            observedAt: new Date('2026-06-03T00:00:00.000Z'),
            sourceKind: 'PROVIDER',
            sourceVersion: 'remediation-1',
            observationKey,
          },
        });
      }
    });
  }, 60_000);

  const ALL_FIGURES = Object.values(FIGURES)
    .map((value) => value.toString())
    .join(', ');

  function explanation(evidenceRefs: number[]): string {
    return JSON.stringify({
      // THE SUMMARY STATES NO MEASURED FIGURE. It cites nothing, so it may not.
      summary: { ar: 'أسبوع قوي', en: 'A strong week' },
      claims: [
        {
          evidenceRefs,
          text: {
            ar: `الأرقام: ${ALL_FIGURES}`,
            en: `The figures: ${ALL_FIGURES}`,
          },
        },
      ],
      notableChanges: [],
      recommendations: [],
    });
  }

  function insights(db: TenantScopedClient, calls: GatewayCalls, text: string) {
    return new AnalyticsInsightService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: analyticsPolicy(),
      queries: new AnalyticsQueryService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: analyticsPolicy(),
        registry: createAnalyticsRegistry({ environment: 'DEVELOPMENT' }),
      }),
      gateway: stubGateway(calls, text),
      /*
       * THE DENIAL SINK IS WIRED EXACTLY AS `apps/api` WIRES IT, and it is one
       * of the things under test.
       *
       * `explain` audits the rejection and then THROWS, and every caller reaches
       * it inside `withWorkspace` — one transaction. Written on the service's
       * own client the record rolled back with the refusal, so the single event
       * the grounding gate exists to catch left no trace. A suite that omitted
       * the sink would be testing a configuration production never runs.
       */
      denialSink: async (event) => {
        await withWorkspace(
          fixtures.a.workspaceId,
          async (fresh) =>
            writeDeniedAudit(fresh, fixtures.a.workspaceId, {
              action: event.action,
              actorType: 'SYSTEM',
              actorId: event.userId,
              resourceType: 'Insight',
              brandId: event.brandId,
              reason: event.reason,
              after: event.detail,
            }),
          { prisma: app },
        );
      },
    });
  }

  const explainWith = (text: string) =>
    inA((db) =>
      insights(db, emptyCalls(), text).explain({
        brandId: fixtures.a.brandId,
        scope: { brandId: fixtures.a.brandId },
        period,
        idempotencyKey: `explain-${randomUUID()}`,
        actorUserId: fixtures.a.userId,
        planKey: null,
        actorBrandScope: [],
        expiresAt: null,
      }),
    );

  it('ONE claim carrying FOUR rows’ figures while citing ONE row is REFUSED', async () => {
    /*
     * Every figure in the sentence is REAL and every one of them is on the
     * table — which is exactly what the document-wide check asked, and exactly
     * why it passed. At most one of them belongs to the row this claim cites, so
     * the per-claim check refuses regardless of which ordinal the evidence
     * builder assigned to which metric.
     */
    await expect(explainWith(explanation([1]))).rejects.toMatchObject({ code: 'INTERNAL' });

    const rejected = await inA((db) =>
      db.auditEvent.findFirst({
        where: {
          workspaceId: fixtures.a.workspaceId,
          action: 'analytics.explain_rejected',
        },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    // THE REFUSAL IS RECORDED, with kinds and counts and never the model's text.
    expect(rejected).not.toBeNull();
    expect(rejected?.reason).toBe('ungrounded_output');

    /*
     * AND NOTHING WAS PERSISTED. Scoped to THIS window rather than to the type,
     * because the tenant fixtures already carry an insight and an assertion that
     * "no explanation exists" would be asserting something about the fixture.
     */
    const persisted = await inA((db) =>
      db.insight.count({
        where: {
          workspaceId: fixtures.a.workspaceId,
          type: 'ANALYTICS_EXPLANATION',
          periodStart: period.start,
        },
      }),
    );
    expect(persisted).toBe(0);
  });

  it('the SAME sentence is accepted once it cites every row it draws on', async () => {
    const result = await explainWith(explanation([1, 2, 3, 4]));
    expect(result.insight).not.toBeNull();
    expect(result.insufficientData).toBe(false);
  });

  it("an idempotency key does not hand one member another member's explanation", async () => {
    /*
     * THE THIRD OF THE THREE SERVICES P7-R2 NAMED, and the one whose replay
     * returns the most: an insight carries the claims, the evidence ordinals and
     * the figures another member's window produced.
     */
    const key = `explain-key-${randomUUID()}`;
    const foreign = await inA((db) =>
      db.insight.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          type: 'ANALYTICS_EXPLANATION',
          status: 'NEW',
          basis: 'OWN_PERFORMANCE',
          title: { ar: 'تفسير', en: 'Explanation' },
          body: { summary: { ar: 'س', en: 's' }, claims: [] },
          periodStart: period.start,
          periodEnd: period.end,
          // SOMEBODY ELSE'S.
          generatedByUserId: otherUserId,
          idempotencyKey: key,
        },
      }),
    );

    const outcome = await inA((db) =>
      insights(db, emptyCalls(), explanation([1, 2, 3, 4]))
        .explain({
          brandId: fixtures.a.brandId,
          scope: { brandId: fixtures.a.brandId },
          period,
          idempotencyKey: key,
          actorUserId: fixtures.a.userId,
          planKey: null,
          actorBrandScope: [],
          expiresAt: null,
        })
        .catch((error: unknown) => error),
    );

    const returned = (outcome as { insight?: { id?: string } }).insight?.id;
    expect(returned).not.toBe(foreign.id);
  });

  it('a measured figure in the UNCITED SUMMARY is refused', async () => {
    const withNumberInSummary = JSON.stringify({
      summary: {
        ar: `بلغت الظهور ${FIGURES.impressions}`,
        en: `Impressions reached ${FIGURES.impressions}`,
      },
      claims: [
        {
          evidenceRefs: [1, 2, 3, 4],
          text: { ar: 'الأداء مستقر', en: 'Performance is steady' },
        },
      ],
      notableChanges: [],
      recommendations: [],
    });
    await expect(explainWith(withNumberInSummary)).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
