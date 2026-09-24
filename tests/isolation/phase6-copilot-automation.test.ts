import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  CampaignService,
  ContentCalendarService,
  ContentLibraryService,
  parseContentPolicy,
} from '@brandspace/content';
import {
  CopilotPlanService,
  CopilotUndoService,
  parseCopilotPolicy,
  resolveLiveAuthorization,
  type CopilotPolicy,
  type ExecutorContext,
  type LiveAuthorization,
} from '@brandspace/copilot';
import { AutomationEngine, parseAutomationPolicy } from '@brandspace/automation';
import {
  AnalyticsQueryService,
  createAnalyticsRegistry,
  parseAnalyticsPolicy,
} from '@brandspace/analytics';
import {
  automationRuleCheck,
  copilotAutomationPort,
} from '../../apps/api/src/routes/copilot-automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 6 · P6-12 — THE COPILOT MAY COMPOSE AN AUTOMATION, AND MAY NOT TURN IT ON.
 *
 * `automation.create_rule` is the first Copilot tool that writes into a domain
 * whose whole purpose is acting WITHOUT a person. So the properties pinned are
 * the ones that keep a person in charge of that:
 *
 *   1. THE RULE IS CREATED DISABLED, whatever the model asked for — enabling
 *      stays a human act on the Automations screen;
 *   2. IT GOES THROUGH THE ENGINE, so a caller without the ACTION's own
 *      permission cannot author a rule that uses it, and an impossible
 *      trigger/action pair never reaches a confirm button;
 *   3. IT IS A CONFIRMED, AUDITED PLAN like any other state change;
 *   4. UNDO REMOVES IT only while it is still what the assistant made — not
 *      once somebody has switched it on;
 *   5. ANOTHER WORKSPACE'S BRAND IS NOT A DOOR, and a plan cancelled by its
 *      author is closed on the server (the new `/cancel`).
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: CopilotPolicy;

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseCopilotPolicy(defaultPayload('copilot'));
}, 60_000);

beforeEach(async () => {
  // The open-plan ceiling is per user; expire what earlier tests left waiting.
  await inA((db) =>
    db.copilotActionPlan.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, status: 'AWAITING_CONFIRMATION' },
      data: { status: 'EXPIRED', confirmationTokenHash: null, confirmationExpiresAt: null },
    }),
  );
});

afterAll(async () => {
  await app?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function plans(db: TenantScopedClient): CopilotPlanService {
  return new CopilotPlanService({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    denialSink: async (event) => {
      await withWorkspace(
        fixtures.a.workspaceId,
        async (fresh) =>
          writeDeniedAudit(fresh, fixtures.a.workspaceId, {
            action: event.action,
            actorType: 'USER',
            actorId: event.userId,
            resourceType: 'CopilotActionPlan',
            resourceId: event.planId,
            reason: event.reason,
          }),
        { prisma: app },
      );
    },
  });
}

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
    automations: copilotAutomationPort({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
    }),
  };
}

function undoCollaborators(db: TenantScopedClient) {
  const contentPolicy = parseContentPolicy(defaultPayload('content'));
  return {
    campaigns: new CampaignService({ db, workspaceId: fixtures.a.workspaceId }),
    calendar: new ContentCalendarService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy,
      timezone: 'UTC',
      quota: { limit: async () => null, consume: async () => true, refund: async () => undefined },
    }),
    library: new ContentLibraryService({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: contentPolicy,
    }),
    automations: copilotAutomationPort({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
    }),
  };
}

async function authorization(
  overrides: Partial<LiveAuthorization> = {},
): Promise<LiveAuthorization> {
  const live = await inA((db) =>
    resolveLiveAuthorization(db, fixtures.a.workspaceId, fixtures.a.userId),
  );
  if (!live) throw new Error('fixture owner has no live membership');
  return { ...live, ...overrides };
}

const ruleStep = (brandId: string, overrides: Record<string, unknown> = {}) => ({
  toolKey: 'automation.create_rule',
  arguments: {
    brandId,
    name: `Copilot rule ${randomUUID().slice(0, 6)}`,
    triggerType: 'CONTENT_APPROVED',
    actionType: 'PLACE_ON_CALENDAR',
    actionConfig: { offsetHours: 24 },
    ...overrides,
  },
});

async function composeAndRun(auth: LiveAuthorization, step = ruleStep(fixtures.a.brandId)) {
  const created = await inA((db) =>
    plans(db).createPlan({
      sessionId: fixtures.a.copilotSessionId,
      brandId: fixtures.a.brandId,
      authorization: auth,
      steps: [step],
      summary: { ar: 'قاعدة', en: 'A rule' },
      estimatedCreditsMilli: 0n,
      expiresAt: null,
      automationRules: automationRuleCheck,
    }),
  );
  await inA((db) =>
    plans(db).confirm({
      planId: created.plan.id,
      planHash: created.plan.planHash,
      token: created.confirmationToken as string,
      userId: fixtures.a.userId,
    }),
  );
  const outcome = await inA((db) =>
    plans(db).execute({
      planId: created.plan.id,
      userId: fixtures.a.userId,
      context: (live, plan) => executorContext(db, live, plan.correlationId),
    }),
  );
  return { created, outcome };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'NO_REFUSAL';
  } catch (error: unknown) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

describe('P6-12 · a composed rule is created, confirmed, audited — and switched OFF', () => {
  it('asks for confirmation, then creates the rule disabled even if asked to enable it', async () => {
    const auth = await authorization();
    const created = await inA((db) =>
      plans(db).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization: auth,
        // THE MODEL ASKS FOR `enabled: true`. The tool's schema does not carry
        // the field and the executor writes `false` regardless.
        steps: [ruleStep(fixtures.a.brandId, { enabled: true })],
        summary: { ar: 'قاعدة', en: 'A rule' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
        automationRules: automationRuleCheck,
      }),
    );
    // A STATE CHANGE, SO A PERSON CONFIRMS IT.
    expect(created.plan.requiresConfirmation).toBe(true);
    expect(created.plan.status).toBe('AWAITING_CONFIRMATION');
    expect(
      created.steps[0]?.preview.find((l) => l.labelKey === 'copilot.preview.ruleEnabled'),
    ).toEqual({ labelKey: 'copilot.preview.ruleEnabled', after: 'off' });

    await inA((db) =>
      plans(db).confirm({
        planId: created.plan.id,
        planHash: created.plan.planHash,
        token: created.confirmationToken as string,
        userId: fixtures.a.userId,
      }),
    );
    const outcome = await inA((db) =>
      plans(db).execute({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        context: (live, plan) => executorContext(db, live, plan.correlationId),
      }),
    );
    expect(outcome.plan.status).toBe('COMPLETED');
    const ruleId = outcome.toolCalls[0]?.resourceId as string;
    const rule = await inA((db) => db.automationRule.findFirst({ where: { id: ruleId } }));
    expect(rule?.enabled).toBe(false);
    expect(rule?.brandId).toBe(fixtures.a.brandId);
    expect(rule?.createdByUserId).toBe(fixtures.a.userId);

    // AUDITED TWICE: the engine's own `automation.created`, and the Copilot's
    // per-tool record joining it to the plan.
    const audits = await inA((db) =>
      db.auditEvent.findMany({
        where: {
          workspaceId: fixtures.a.workspaceId,
          OR: [
            { action: 'automation.created', resourceId: ruleId },
            { action: 'copilot.tool.automation.create_rule', resourceId: ruleId },
          ],
        },
        select: { action: true },
      }),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      'automation.created',
      'copilot.tool.automation.create_rule',
    ]);
  });

  it('never reaches a confirm button for an impossible trigger/action pair', async () => {
    const auth = await authorization();
    // PLACE_ON_CALENDAR needs a content item; SCHEDULED_TIME carries none.
    const code = await refusal(
      inA((db) =>
        plans(db).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization: auth,
          steps: [ruleStep(fixtures.a.brandId, { triggerType: 'SCHEDULED_TIME' })],
          summary: { ar: 'قاعدة', en: 'A rule' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
          automationRules: automationRuleCheck,
        }),
      ),
    );
    expect(code).toBe('NOT_FOUND');
  });

  it('refuses a rule whose ACTION the caller may not perform, before anything is shown', async () => {
    // Holds automation.manage, but not publishing.manage: PROPOSE_PUBLISH is out.
    const auth = await authorization();
    const narrowed = {
      ...auth,
      permissionKeys: auth.permissionKeys.filter((key) => key !== 'publishing.manage'),
    };
    const code = await refusal(
      inA((db) =>
        plans(db).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization: narrowed,
          steps: [
            ruleStep(fixtures.a.brandId, { actionType: 'PROPOSE_PUBLISH', actionConfig: {} }),
          ],
          summary: { ar: 'قاعدة', en: 'A rule' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
          automationRules: automationRuleCheck,
        }),
      ),
    );
    expect(code).toBe('NOT_FOUND');
  });

  it('fails CLOSED when the surface did not wire the registry check', async () => {
    const auth = await authorization();
    const code = await refusal(
      inA((db) =>
        plans(db).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization: auth,
          steps: [ruleStep(fixtures.a.brandId)],
          summary: { ar: 'قاعدة', en: 'A rule' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
          // NO automationRules.
        }),
      ),
    );
    expect(code).toBe('NOT_FOUND');
  });

  it("another workspace's brand is refused like one that does not exist", async () => {
    const auth = await authorization();
    const code = await refusal(
      inA((db) =>
        plans(db).createPlan({
          sessionId: fixtures.a.copilotSessionId,
          brandId: fixtures.a.brandId,
          authorization: auth,
          steps: [ruleStep(fixtures.b.brandId)],
          summary: { ar: 'قاعدة', en: 'A rule' },
          estimatedCreditsMilli: 0n,
          expiresAt: null,
          automationRules: automationRuleCheck,
        }),
      ),
    );
    expect(code).toBe('NOT_FOUND');
    const leaked = await inA((db) =>
      db.automationRule.count({ where: { brandId: fixtures.b.brandId } }),
    );
    expect(leaked).toBe(0);
  });
});

describe('P6-12 · undo removes a composed rule only while it is still untouched', () => {
  it('removes a disabled, unedited rule', async () => {
    const { created, outcome } = await composeAndRun(await authorization());
    const ruleId = outcome.toolCalls[0]?.resourceId as string;
    const undone = await inA((db) =>
      new CopilotUndoService({ db, workspaceId: fixtures.a.workspaceId }).undo({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        collaborators: undoCollaborators(db),
      }),
    );
    expect(undone.plan.undoStatus).toBe('UNDONE');
    const rule = await inA((db) => db.automationRule.findFirst({ where: { id: ruleId } }));
    // SOFT-DELETED through the engine, so its history and audit remain.
    expect(rule?.deletedAt).not.toBeNull();
  });

  it('refuses once a person has switched the rule ON', async () => {
    const auth = await authorization();
    const { created, outcome } = await composeAndRun(auth);
    const ruleId = outcome.toolCalls[0]?.resourceId as string;
    await inA((db) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: automationPolicy(),
        ports: {},
      }).updateRule({ ruleId, enabled: true, actor: auth }),
    );
    const undone = await inA((db) =>
      new CopilotUndoService({ db, workspaceId: fixtures.a.workspaceId }).undo({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        collaborators: undoCollaborators(db),
      }),
    );
    expect(undone.refused.map((r) => r.reason)).toEqual(['rule_enabled_since']);
    const rule = await inA((db) => db.automationRule.findFirst({ where: { id: ruleId } }));
    expect(rule?.deletedAt).toBeNull();
    expect(rule?.enabled).toBe(true);
  });
});

describe('P6-12 · a declined plan is closed on the server', () => {
  it('cancel clears the token, audits, and the plan can no longer be confirmed', async () => {
    const auth = await authorization();
    const created = await inA((db) =>
      plans(db).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization: auth,
        steps: [ruleStep(fixtures.a.brandId)],
        summary: { ar: 'قاعدة', en: 'A rule' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
        automationRules: automationRuleCheck,
      }),
    );
    await inA((db) =>
      plans(db).cancel({
        planId: created.plan.id,
        userId: fixtures.a.userId,
        reason: 'declined_by_customer',
      }),
    );
    const row = await inA((db) =>
      db.copilotActionPlan.findFirst({ where: { id: created.plan.id } }),
    );
    expect(row?.status).toBe('CANCELLED');
    expect(row?.confirmationTokenHash).toBeNull();

    const code = await refusal(
      inA((db) =>
        plans(db).confirm({
          planId: created.plan.id,
          planHash: created.plan.planHash,
          token: created.confirmationToken as string,
          userId: fixtures.a.userId,
        }),
      ),
    );
    expect(code).not.toBe('NO_REFUSAL');
    const audit = await inA((db) =>
      db.auditEvent.count({
        where: { action: 'copilot.plan_cancelled', resourceId: created.plan.id },
      }),
    );
    expect(audit).toBe(1);
  });

  it("another member cannot cancel somebody's plan", async () => {
    const auth = await authorization();
    const created = await inA((db) =>
      plans(db).createPlan({
        sessionId: fixtures.a.copilotSessionId,
        brandId: fixtures.a.brandId,
        authorization: auth,
        steps: [ruleStep(fixtures.a.brandId)],
        summary: { ar: 'قاعدة', en: 'A rule' },
        estimatedCreditsMilli: 0n,
        expiresAt: null,
        automationRules: automationRuleCheck,
      }),
    );
    const code = await refusal(
      inA((db) =>
        plans(db).cancel({
          planId: created.plan.id,
          userId: randomUUID(),
          reason: 'declined_by_customer',
        }),
      ),
    );
    expect(code).not.toBe('NO_REFUSAL');
    const row = await inA((db) =>
      db.copilotActionPlan.findFirst({ where: { id: created.plan.id } }),
    );
    expect(row?.status).toBe('AWAITING_CONFIRMATION');
  });
});

describe('P6-12 · the automations list keeps the brand it was asked for', () => {
  it('listRules intersects the selected brand with the scope rather than replacing it', async () => {
    const engine = (db: TenantScopedClient) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: automationPolicy(),
        ports: {},
      });
    const other = await inA(async (db) => {
      const brand = await db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          name: 'Automations other brand',
          slug: `auto-other-${randomUUID().slice(0, 8)}`,
        },
      });
      return brand.id;
    });
    const auth = await authorization();
    await inA((db) =>
      engine(db).createRule({
        brandId: other,
        name: 'Other brand rule',
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {},
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.notice' },
        actor: auth,
      }),
    );
    // A member scoped to BOTH brands, looking at brand A.
    const rules = await inA((db) =>
      engine(db).listRules({
        brandId: fixtures.a.brandId,
        brandScope: [fixtures.a.brandId, other],
      }),
    );
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.brandId === fixtures.a.brandId)).toBe(true);
  });
});
