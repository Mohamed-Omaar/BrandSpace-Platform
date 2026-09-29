import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  AutomationEngine,
  CONDITION_VALUE_UNAVAILABLE,
  actionSupportsTrigger,
  gatherFacts,
  isOlderAutomation,
  memberCatalogueFor,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
  type AutomationPorts,
  type TriggerEvent,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3, PR 1 — THE FOUNDATION, AGAINST REAL POSTGRESQL.
 *
 *   1. The M1c CHECKs accept every new enum value in its declared shape and
 *      still reject a mismatched reference, a missing or stray rule address,
 *      and an asks-first action with confirmation switched off.
 *   2. Stored rules of every shipped trigger × action shape run EXACTLY as
 *      before; the entitlement port is never consulted for them.
 *   3. A rule naming a campaign, brand or person that no longer resolves for
 *      its brand ends SKIPPED `condition_value_unavailable` — never widened.
 *   4. The member picker lists only ACTIVE members whose BrandScope admits the
 *      rule's brand, and nothing across a workspace or outside the viewer's
 *      brands.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;
let otherBrandId: string;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const EVERYTHING = [
  'workspace.read',
  'automation.manage',
  'content.submit',
  'content.schedule',
  'publishing.manage',
];

function actor(overrides: Partial<AutomationActor> = {}): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: EVERYTHING,
    brandScope: [],
    ...overrides,
  };
}

/** Every port a shipped action can use, answering like the real one would. */
let entitlementQuestions: string[] = [];
const ports: AutomationPorts = {
  notifications: { notify: async () => ({ recipients: 1 }) },
  approvals: { submitForApproval: async () => ({ approvalId: randomUUID() }) },
  calendar: { placeOnCalendar: async () => ({ slotId: randomUUID() }) },
  /*
   * AN ENTITLEMENT PORT THAT SAYS NO TO EVERYTHING, and records being asked.
   * Every shipped action declares no entitlement, so it must never be asked
   * and must never change an outcome.
   */
  entitlements: {
    allows: async (featureKey: string) => {
      entitlementQuestions.push(featureKey);
      return false;
    },
  },
};

const engine = (db: TenantScopedClient) =>
  new AutomationEngine({ db, workspaceId: fixtures.a.workspaceId, policy, ports });

/** Refused inside its own transaction, so the next statement is unaffected. */
async function refusal(fn: (db: TenantScopedClient) => Promise<unknown>): Promise<string> {
  try {
    await inA(fn);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'accepted';
}

class RolledBack extends Error {}
/** Accepted — and then rolled back, so nothing is left for any sweep to find. */
async function accepted(fn: (db: TenantScopedClient) => Promise<unknown>): Promise<boolean> {
  try {
    await inA(async (db) => {
      await fn(db);
      throw new RolledBack();
    });
  } catch (error: unknown) {
    if (error instanceof RolledBack) return true;
    throw error;
  }
  return false;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
  otherBrandId = (
    await inA((db) =>
      db.brand.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          slug: `pr1-other-${randomUUID().slice(0, 8)}`,
          name: 'PR 1 other',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
}, 60_000);

/*
 * RETIRE THIS FILE'S RULES AFTER EACH TEST. A brand may hold only
 * `maxRulesPerBrand` live rules, and the walk above writes fifteen; a retired
 * (soft-deleted) rule does not count and keeps its run history.
 */
afterEach(async () => {
  await inA((db) =>
    db.automationRule.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, name: { startsWith: 'pr1 ' }, deletedAt: null },
      data: { deletedAt: new Date(), enabled: false },
    }),
  );
});

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. The M1c CHECKs
// ---------------------------------------------------------------------------

describe('M1c — the outbox and rule CHECKs know the G13 values', () => {
  type Shape = { refType: string | null; refId: () => string | null; ruleAddressed: boolean };
  const shapes = (): Record<string, Shape> => ({
    POST_FAILED: {
      refType: 'PublishAttempt',
      refId: () => fixtures.a.publishAttemptId,
      ruleAddressed: false,
    },
    REVIEW_WAITING_24H: {
      refType: 'Approval',
      refId: () => fixtures.a.approvalId,
      ruleAddressed: true,
    },
    CAMPAIGN_STARTED: {
      refType: 'Campaign',
      refId: () => fixtures.a.campaignId,
      ruleAddressed: true,
    },
    CAMPAIGN_ENDED: {
      refType: 'Campaign',
      refId: () => fixtures.a.campaignId,
      ruleAddressed: true,
    },
    WEEKLY_ENGAGEMENT_DROPPED: { refType: null, refId: () => null, ruleAddressed: true },
    SCHEDULE_GAP: { refType: null, refId: () => null, ruleAddressed: true },
    POST_TOP_10_PERCENT: {
      refType: 'ContentItem',
      refId: () => fixtures.a.contentItemId,
      ruleAddressed: true,
    },
    FACT_EXPIRING: {
      refType: 'BrandKnowledgeItem',
      refId: () => fixtures.a.knowledgeItemId,
      ruleAddressed: true,
    },
  });

  const event = (
    triggerType: string,
    overrides: { refType?: string | null; refId?: string | null; ruleId?: string | null } = {},
  ) => {
    const shape = shapes()[triggerType];
    return {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      triggerType: triggerType as never,
      refType: overrides.refType === undefined ? (shape?.refType ?? null) : overrides.refType,
      refId: overrides.refId === undefined ? (shape?.refId() ?? null) : overrides.refId,
      ruleId:
        overrides.ruleId === undefined
          ? shape?.ruleAddressed
            ? fixtures.a.automationRuleId
            : null
          : overrides.ruleId,
      dedupeKey: `pr1:${triggerType}:${randomUUID()}`,
    };
  };

  it('accepts every new trigger value in its declared shape', async () => {
    for (const triggerType of Object.keys(shapes())) {
      expect(
        await accepted((db) => db.automationEvent.create({ data: event(triggerType) })),
        triggerType,
      ).toBe(true);
    }
  });

  it('still rejects a mismatched reference for every new trigger', async () => {
    for (const [triggerType, shape] of Object.entries(shapes())) {
      const wrong =
        shape.refType === null
          ? { refType: 'ContentItem', refId: fixtures.a.contentItemId }
          : { refType: 'PublishJob', refId: fixtures.a.publishJobId };
      expect(
        await refusal((db) => db.automationEvent.create({ data: event(triggerType, wrong) })),
        triggerType,
      ).toContain('automation_event_ref_matches_trigger');
      if (shape.refType !== null) {
        expect(
          await refusal((db) =>
            db.automationEvent.create({ data: event(triggerType, { refId: null }) }),
          ),
          `${triggerType} without a refId`,
        ).toContain('automation_event_ref_matches_trigger');
      }
    }
  });

  it('a rule-derived event needs its rule, and a domain event may not carry one', async () => {
    for (const [triggerType, shape] of Object.entries(shapes())) {
      const stray = shape.ruleAddressed ? null : fixtures.a.automationRuleId;
      expect(
        await refusal((db) =>
          db.automationEvent.create({ data: event(triggerType, { ruleId: stray }) }),
        ),
        triggerType,
      ).toContain('automation_event_rule_addressed_when_derived');
    }
  });

  it('the existing triggers keep their shapes, and ANOMALY_DETECTED stays unrepresentable', async () => {
    expect(
      await accepted((db) =>
        db.automationEvent.create({
          data: {
            ...event('CONTENT_APPROVED'),
            refType: 'ContentItem',
            refId: fixtures.a.contentItemId,
            ruleId: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      await refusal((db) =>
        db.automationEvent.create({
          data: {
            ...event('CONTENT_APPROVED'),
            refType: 'PublishJob',
            refId: fixtures.a.publishJobId,
            ruleId: null,
          },
        }),
      ),
    ).toContain('automation_event_ref_matches_trigger');
    expect(
      await refusal((db) =>
        db.automationEvent.create({
          data: { ...event('ANOMALY_DETECTED'), refType: null, refId: null, ruleId: null },
        }),
      ),
    ).toContain('automation_event_ref_matches_trigger');
  });

  const ruleRow = (actionType: string, requiresConfirmationForExternal: boolean) => ({
    workspaceId: fixtures.a.workspaceId,
    brandId: fixtures.a.brandId,
    name: `pr1 check ${randomUUID()}`,
    enabled: false,
    triggerType: 'CONTENT_APPROVED' as const,
    triggerConfig: {},
    conditions: [],
    actionType: actionType as never,
    actionConfig: {},
    requiresConfirmationForExternal,
    createdByUserId: fixtures.a.userId,
  });

  it('an asks-first action cannot be stored with confirmation switched off', async () => {
    for (const actionType of ['PROPOSE_PUBLISH', 'RETRY_PUBLISH', 'PAUSE_CAMPAIGN']) {
      expect(
        await refusal((db) => db.automationRule.create({ data: ruleRow(actionType, false) })),
        actionType,
      ).toContain('automation_rule_external_requires_confirmation');
      expect(
        await accepted((db) => db.automationRule.create({ data: ruleRow(actionType, true) })),
        actionType,
      ).toBe(true);
    }
  });

  it('every other new action value is representable either way', async () => {
    for (const actionType of [
      'SCHEDULE_NEXT_FREE_SLOT',
      'NOTIFY_PERSON',
      'ADD_TO_CAMPAIGN',
      'REMIND_REVIEWER',
      'DRAFT_IDEAS',
      'MAKE_DRAFT_COPY',
    ]) {
      expect(
        await accepted((db) => db.automationRule.create({ data: ruleRow(actionType, false) })),
        actionType,
      ).toBe(true);
    }
  });

  it('armedAt and dueWatermark are NULL on existing and new rules alike', async () => {
    const existing = await inA((db) =>
      db.automationRule.findFirstOrThrow({
        where: { id: fixtures.a.automationRuleId },
        select: { armedAt: true, dueWatermark: true },
      }),
    );
    expect(existing).toEqual({ armedAt: null, dueWatermark: null });
    const created = await inA((db) =>
      engine(db).createRule({
        brandId: fixtures.a.brandId,
        name: `pr1 fresh ${randomUUID().slice(0, 8)}`,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {},
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.notice' },
        actor: actor(),
      }),
    );
    expect({ armedAt: created.armedAt, dueWatermark: created.dueWatermark }).toEqual({
      armedAt: null,
      dueWatermark: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Existing stored rules behave exactly as before
// ---------------------------------------------------------------------------

/** One event per shipped trigger, aimed at a real row of workspace A. */
function eventFor(triggerType: string, ruleId: string): TriggerEvent {
  const refs: Record<string, [string | null, string | null]> = {
    CONTENT_APPROVED: ['ContentItem', fixtures.a.contentItemId],
    CONTENT_SCHEDULED: ['CalendarSlot', fixtures.a.calendarSlotId],
    POST_PUBLISHED: ['PublishJob', fixtures.a.publishJobId],
    ANALYTICS_REFRESHED: ['AnalyticsIngestionRun', fixtures.a.analyticsRunId],
    METRIC_THRESHOLD_CROSSED: ['MetricObservation', fixtures.a.metricObservationId],
    SCHEDULED_TIME: [null, null],
  };
  const [refType, refId] = refs[triggerType] ?? [null, null];
  return {
    type: triggerType as TriggerEvent['type'],
    brandId: fixtures.a.brandId,
    refType,
    refId,
    ruleId,
    eventKey: `pr1:${randomUUID()}`,
    facts: { 'brand.id': fixtures.a.brandId },
  };
}

const CONFIGS: Record<string, unknown> = {
  CONTENT_APPROVED: {},
  CONTENT_SCHEDULED: {},
  POST_PUBLISHED: {},
  ANALYTICS_REFRESHED: {},
  METRIC_THRESHOLD_CROSSED: { metricKey: 'impressions', direction: 'above', threshold: 1 },
  SCHEDULED_TIME: { hourLocal: 9 },
  NOTIFY: { templateKey: 'automation.notice' },
  SUBMIT_FOR_APPROVAL: {},
  PLACE_ON_CALENDAR: { offsetHours: 48 },
  PROPOSE_PUBLISH: {},
};

/** Stored DISABLED, so no sweep in any suite ever reaches it; run as enabled. */
async function storedRule(input: {
  triggerType: string;
  actionType: string;
  conditions?: unknown;
  brandId?: string;
}): Promise<AutomationRule> {
  return inA((db) =>
    engine(db).createRule({
      brandId: input.brandId ?? fixtures.a.brandId,
      name: `pr1 ${input.triggerType} ${input.actionType} ${randomUUID().slice(0, 8)}`,
      triggerType: input.triggerType as never,
      triggerConfig: CONFIGS[input.triggerType],
      conditions: input.conditions ?? [],
      actionType: input.actionType as never,
      actionConfig: CONFIGS[input.actionType],
      actor: actor(),
    }),
  );
}

async function runOnce(
  rule: AutomationRule,
  input: { facts?: Record<string, unknown>; resolved?: AutomationActor | null } = {},
) {
  const event = eventFor(rule.triggerType, rule.id);
  return inA((db) =>
    engine(db).run({
      rule: { ...rule, enabled: true },
      event: { ...event, facts: { ...event.facts, ...(input.facts ?? {}) } },
      resolveActor: async () => (input.resolved === undefined ? actor() : input.resolved),
    }),
  );
}

describe('existing stored rules of every shape behave exactly as before', () => {
  const EXPECTED: Record<string, string> = {
    NOTIFY: 'SUCCEEDED',
    SUBMIT_FOR_APPROVAL: 'SUCCEEDED',
    PLACE_ON_CALENDAR: 'SUCCEEDED',
    PROPOSE_PUBLISH: 'AWAITING_CONFIRMATION',
  };

  it('every shipped trigger × every action it supports, and the entitlement port is never asked', async () => {
    entitlementQuestions = [];
    let walked = 0;
    for (const trigger of AUTOMATION_TRIGGERS) {
      for (const action of AUTOMATION_ACTIONS) {
        if (!actionSupportsTrigger(action.type, trigger.type)) continue;
        const rule = await storedRule({ triggerType: trigger.type, actionType: action.type });
        const outcome = await runOnce(rule);
        expect(outcome.status, `${trigger.type} × ${action.type}`).toBe(EXPECTED[action.type]);
        expect(outcome.run?.failureCode ?? null, `${trigger.type} × ${action.type}`).toBeNull();
        expect(isOlderAutomation(rule)).toBe(false);
        walked += 1;
      }
    }
    expect(walked).toBe(15);
    expect(entitlementQuestions).toEqual([]);
  });

  it('a creator who lost the action permission, the brand, or the membership is blocked as before', async () => {
    const rule = await storedRule({
      triggerType: 'CONTENT_APPROVED',
      actionType: 'PLACE_ON_CALENDAR',
    });
    const lostPermission = await runOnce(rule, {
      resolved: actor({ permissionKeys: ['workspace.read', 'automation.manage'] }),
    });
    expect([lostPermission.status, lostPermission.run?.failureCode]).toEqual([
      'BLOCKED_BY_AUTHORIZATION',
      'creator_lost_permission',
    ]);
    const lostBrand = await runOnce(rule, { resolved: actor({ brandScope: [otherBrandId] }) });
    expect([lostBrand.status, lostBrand.run?.failureCode]).toEqual([
      'BLOCKED_BY_AUTHORIZATION',
      'creator_lost_brand_scope',
    ]);
    const gone = await runOnce(rule, { resolved: null });
    expect([gone.status, gone.run?.failureCode]).toEqual([
      'BLOCKED_BY_AUTHORIZATION',
      'creator_no_longer_a_member',
    ]);
  });

  it('conditions over LIVE values evaluate as before: held runs, not held skips with no code', async () => {
    const rule = await storedRule({
      triggerType: 'CONTENT_APPROVED',
      actionType: 'NOTIFY',
      conditions: [
        { field: 'content.campaignId', operator: 'equals', value: fixtures.a.campaignId },
        { field: 'content.authorUserId', operator: 'equals', value: fixtures.a.userId },
        { field: 'brand.id', operator: 'equals', value: fixtures.a.brandId },
      ],
    });
    const held = await runOnce(rule, {
      facts: {
        'content.campaignId': fixtures.a.campaignId,
        'content.authorUserId': fixtures.a.userId,
      },
    });
    expect([held.status, held.run?.failureCode ?? null]).toEqual(['SUCCEEDED', null]);
    const notHeld = await runOnce(rule, {
      facts: { 'content.campaignId': null, 'content.authorUserId': fixtures.a.userId },
    });
    expect([notHeld.status, notHeld.run?.failureCode ?? null, notHeld.run?.conditionsHeld]).toEqual(
      ['SKIPPED', null, false],
    );
  });

  it('a stored rule on the retired ANOMALY_DETECTED trigger still lists, toggles and deletes', async () => {
    const anomaly = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `pr1 anomaly ${randomUUID()}`,
          enabled: false,
          triggerType: 'ANOMALY_DETECTED',
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.notice' },
          createdByUserId: fixtures.a.userId,
        },
      }),
    );
    expect(isOlderAutomation(anomaly)).toBe(true);
    const listed = await inA((db) => engine(db).listRules({ brandScope: [] }));
    expect(listed.map((rule) => rule.id)).toContain(anomaly.id);
    const enabled = await inA((db) =>
      engine(db).updateRule({ ruleId: anomaly.id, enabled: true, actor: actor() }),
    );
    expect(enabled.enabled).toBe(true);
    await inA((db) =>
      engine(db).updateRule({ ruleId: anomaly.id, enabled: false, actor: actor() }),
    );
    await inA((db) => engine(db).deleteRule({ ruleId: anomaly.id, actor: actor() }));
  });

  it('nothing planned can be authored, and a stored planned action fails closed without asking', async () => {
    await expect(
      inA((db) =>
        engine(db).createRule({
          brandId: fixtures.a.brandId,
          name: `pr1 planned ${randomUUID().slice(0, 8)}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'ADD_TO_CAMPAIGN' as never,
          actionConfig: {},
          actor: actor({ permissionKeys: [...EVERYTHING, 'content.create', 'campaigns.manage'] }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      inA((db) =>
        engine(db).createRule({
          brandId: fixtures.a.brandId,
          name: `pr1 planned ${randomUUID().slice(0, 8)}`,
          triggerType: 'POST_FAILED' as never,
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.notice' },
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    entitlementQuestions = [];
    for (const actionType of [
      'RETRY_PUBLISH',
      'PAUSE_CAMPAIGN',
      'DRAFT_IDEAS',
      'ADD_TO_CAMPAIGN',
    ]) {
      const planned = await inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: `pr1 raw ${actionType} ${randomUUID()}`,
            enabled: false,
            triggerType: 'CONTENT_APPROVED',
            triggerConfig: {},
            conditions: [],
            actionType: actionType as never,
            actionConfig: {},
            requiresConfirmationForExternal: true,
            createdByUserId: fixtures.a.userId,
          },
        }),
      );
      const outcome = await runOnce(planned, {
        resolved: actor({
          permissionKeys: [...EVERYTHING, 'content.create', 'campaigns.manage', 'copilot.use'],
        }),
      });
      // Never AWAITING_CONFIRMATION, never performed.
      expect([outcome.status, outcome.run?.failureCode], actionType).toEqual([
        'FAILED',
        'unknown_action',
      ]);
    }
    expect(entitlementQuestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Stale condition values fail closed
// ---------------------------------------------------------------------------

describe('a value the rule names that no longer resolves ends the run SKIPPED, never widened', () => {
  async function campaign(brandId: string): Promise<string> {
    return (
      await inA((db) =>
        db.campaign.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId,
            name: `pr1 campaign ${randomUUID().slice(0, 8)}`,
            objective: 'AWARENESS',
          },
          select: { id: true },
        }),
      )
    ).id;
  }

  async function member(brandScope: string[] | null): Promise<string> {
    const user = await platform.user.create({
      data: { email: `pr1-${randomUUID()}@example.test`, timezone: 'UTC' },
      select: { id: true },
    });
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'content_creator', workspaceId: null },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        ...(brandScope === null ? {} : { brandScope }),
      },
    });
    return user.id;
  }

  const setMembership = (
    userId: string,
    data: { status?: 'ACTIVE' | 'SUSPENDED'; brandScope?: string[] },
  ) =>
    platform.membership.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, userId },
      data,
    });

  /** A negative condition: the shape a stale value would WIDEN. */
  const notEquals = (field: string, value: string) =>
    storedRule({
      triggerType: 'CONTENT_APPROVED',
      actionType: 'NOTIFY',
      conditions: [{ field, operator: 'not_equals', value }],
    });

  const stale = { status: 'SKIPPED', failureCode: CONDITION_VALUE_UNAVAILABLE };
  const shape = (outcome: Awaited<ReturnType<typeof runOnce>>) => ({
    status: outcome.status,
    failureCode: outcome.run?.failureCode ?? null,
  });

  it('a campaign: live evaluates; deleted, another brand’s, or another workspace’s is stale', async () => {
    const live = await campaign(fixtures.a.brandId);
    const rule = await notEquals('content.campaignId', live);
    expect(shape(await runOnce(rule, { facts: { 'content.campaignId': null } }))).toEqual({
      status: 'SUCCEEDED',
      failureCode: null,
    });

    await inA((db) => db.campaign.update({ where: { id: live }, data: { deletedAt: new Date() } }));
    expect(shape(await runOnce(rule, { facts: { 'content.campaignId': null } }))).toEqual(stale);

    const elsewhere = await notEquals('content.campaignId', await campaign(otherBrandId));
    expect(shape(await runOnce(elsewhere, { facts: { 'content.campaignId': null } }))).toEqual(
      stale,
    );

    const foreign = await notEquals('content.campaignId', fixtures.b.campaignId);
    expect(shape(await runOnce(foreign, { facts: { 'content.campaignId': null } }))).toEqual(stale);
  });

  it('a person: stale while they are not ACTIVE or their scope does not admit the brand', async () => {
    const person = await member([]);
    const rule = await notEquals('content.authorUserId', person);
    const facts = { 'content.authorUserId': fixtures.a.userId };
    expect(shape(await runOnce(rule, { facts }))).toEqual({
      status: 'SUCCEEDED',
      failureCode: null,
    });

    await setMembership(person, { brandScope: [otherBrandId] });
    expect(shape(await runOnce(rule, { facts }))).toEqual(stale);

    await setMembership(person, { brandScope: [fixtures.a.brandId] });
    expect(shape(await runOnce(rule, { facts }))).toEqual({
      status: 'SUCCEEDED',
      failureCode: null,
    });

    await setMembership(person, { status: 'SUSPENDED' });
    expect(shape(await runOnce(rule, { facts }))).toEqual(stale);

    // A member with NO scope value at all (NULL = every brand) resolves.
    const unscoped = await notEquals('content.authorUserId', await member(null));
    expect(shape(await runOnce(unscoped, { facts }))).toEqual({
      status: 'SUCCEEDED',
      failureCode: null,
    });

    // A member of ANOTHER workspace is not a member of this one.
    const foreign = await notEquals('content.authorUserId', fixtures.b.userId);
    expect(shape(await runOnce(foreign, { facts }))).toEqual(stale);
  });

  it('a brand: an archived one, or another workspace’s, is stale', async () => {
    const archived = (
      await inA((db) =>
        db.brand.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            slug: `pr1-archived-${randomUUID().slice(0, 8)}`,
            name: 'PR 1 archived',
            status: 'ACTIVE',
          },
          select: { id: true },
        }),
      )
    ).id;
    const rule = await notEquals('brand.id', archived);
    expect(shape(await runOnce(rule))).toEqual({ status: 'SUCCEEDED', failureCode: null });
    await inA((db) => db.brand.update({ where: { id: archived }, data: { status: 'ARCHIVED' } }));
    expect(shape(await runOnce(rule))).toEqual(stale);

    const foreign = await notEquals('brand.id', fixtures.b.brandId);
    expect(shape(await runOnce(foreign))).toEqual(stale);
  });

  it('a value that is not an id at all is stale — and the transaction survives it', async () => {
    const rule = await notEquals('content.campaignId', 'not-a-uuid');
    await inA(async (db) => {
      const outcome = await engine(db).run({
        rule: { ...rule, enabled: true },
        event: eventFor(rule.triggerType, rule.id),
        resolveActor: async () => actor(),
      });
      expect([outcome.status, outcome.run?.failureCode]).toEqual(['SKIPPED', stale.failureCode]);
      // The same transaction is still usable: nothing was sent to a uuid column.
      expect(await db.automationRule.count({ where: { id: rule.id } })).toBe(1);
    });
  });

  it('a stale run is recorded as history and performs nothing', async () => {
    let notified = 0;
    const rule = await notEquals('content.campaignId', fixtures.b.campaignId);
    const outcome = await inA((db) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy,
        ports: {
          notifications: {
            notify: async () => {
              notified += 1;
              return { recipients: 1 };
            },
          },
        },
      }).run({
        rule: { ...rule, enabled: true },
        event: eventFor(rule.triggerType, rule.id),
        resolveActor: async () => actor(),
      }),
    );
    expect(outcome.status).toBe('SKIPPED');
    expect(notified).toBe(0);
    const stored = await inA((db) =>
      db.automationRun.findFirstOrThrow({ where: { id: outcome.run?.id ?? '' } }),
    );
    expect(stored.failureCode).toBe(CONDITION_VALUE_UNAVAILABLE);
    expect(stored.finishedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. The scoped member picker, and cross-tenant refusal
// ---------------------------------------------------------------------------

describe('the member picker lists members whose BrandScope admits the rule’s brand', () => {
  /** `null` writes NO scope at all — the column's NULL, which means every brand. */
  async function member(status: 'ACTIVE' | 'SUSPENDED' | 'INVITED', brandScope: string[] | null) {
    const user = await platform.user.create({
      data: {
        email: `pr1-picker-${randomUUID()}@example.test`,
        name: `Picker ${randomUUID().slice(0, 6)}`,
        timezone: 'UTC',
      },
      select: { id: true },
    });
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'content_creator', workspaceId: null },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: user.id,
        roleId: role.id,
        status,
        ...(brandScope === null ? {} : { brandScope }),
      },
    });
    return user.id;
  }

  it('unrestricted and brand-scoped ACTIVE members in; other brands and inactive members out', async () => {
    const unrestricted = await member('ACTIVE', []);
    // How an owner's membership is usually written: no scope column value.
    const noScope = await member('ACTIVE', null);
    const scopedHere = await member('ACTIVE', [fixtures.a.brandId]);
    const scopedElsewhere = await member('ACTIVE', [otherBrandId]);
    const suspended = await member('SUSPENDED', []);
    const invited = await member('INVITED', []);

    const listed = (
      await inA((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          viewerBrandScope: [],
        }),
      )
    ).map((choice) => choice.id);
    expect(listed).toContain(fixtures.a.userId);
    expect(listed).toContain(unrestricted);
    expect(listed).toContain(noScope);
    expect(listed).toContain(scopedHere);
    expect(listed).not.toContain(scopedElsewhere);
    expect(listed).not.toContain(suspended);
    expect(listed).not.toContain(invited);
    expect(listed).not.toContain(fixtures.b.userId);

    // The other brand's list is the mirror image for the scoped members.
    const other = (
      await inA((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: otherBrandId,
          viewerBrandScope: [],
        }),
      )
    ).map((choice) => choice.id);
    expect(other).toContain(scopedElsewhere);
    expect(other).not.toContain(scopedHere);
  });

  it('a brand outside the viewer’s scope, or of another workspace, lists nobody', async () => {
    expect(
      await inA((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          viewerBrandScope: [otherBrandId],
        }),
      ),
    ).toEqual([]);
    expect(
      await inA((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.b.brandId,
          viewerBrandScope: [],
        }),
      ),
    ).toEqual([]);
    // Naming workspace B from inside A's transaction: RLS shows nothing.
    expect(
      await inA((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.b.workspaceId,
          brandId: fixtures.b.brandId,
          viewerBrandScope: [],
        }),
      ),
    ).toEqual([]);
    // And workspace B's own list never contains A's members.
    const fromB = (
      await inB((db) =>
        memberCatalogueFor(db, {
          workspaceId: fixtures.b.workspaceId,
          brandId: fixtures.b.brandId,
          viewerBrandScope: [],
        }),
      )
    ).map((choice) => choice.id);
    expect(fromB).not.toContain(fixtures.a.userId);
  });
});

describe('cross-workspace and cross-brand refusal', () => {
  it('a rule of workspace A cannot be read, edited or run from workspace B', async () => {
    const rule = await storedRule({ triggerType: 'CONTENT_APPROVED', actionType: 'NOTIFY' });
    const engineB = (db: TenantScopedClient) =>
      new AutomationEngine({ db, workspaceId: fixtures.b.workspaceId, policy, ports });
    await expect(inB((db) => engineB(db).getRule(rule.id, []))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      inB((db) =>
        engineB(db).updateRule({
          ruleId: rule.id,
          enabled: true,
          actor: actor({ userId: fixtures.b.userId }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Delivering B's event reaches none of A's rules.
    const delivered = await inB((db) =>
      engineB(db).deliver({
        event: { ...eventFor('CONTENT_APPROVED', rule.id), brandId: fixtures.b.brandId },
        resolveActor: async () => actor({ userId: fixtures.b.userId }),
      }),
    );
    expect(delivered).toEqual([]);
  });

  it('a rule cannot be written for a brand outside the author’s scope', async () => {
    await expect(
      inA((db) =>
        engine(db).createRule({
          brandId: fixtures.a.brandId,
          name: `pr1 scope ${randomUUID().slice(0, 8)}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.notice' },
          actor: actor({ brandScope: [otherBrandId] }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('content.channels is produced from the post’s own variants, in its own workspace', async () => {
    const facts = await inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: fixtures.a.contentItemId,
        ruleId: null,
      }),
    );
    expect(Array.isArray(facts['content.channels'])).toBe(true);
    const variants = await inA((db) =>
      db.contentVariant.findMany({
        where: { contentItemId: fixtures.a.contentItemId },
        select: { platformKey: true },
      }),
    );
    const expected = [
      ...new Set(
        variants
          .map((variant) => variant.platformKey.toUpperCase())
          .filter((key) => ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X'].includes(key)),
      ),
    ].sort();
    expect(facts['content.channels']).toEqual(expected);

    // Workspace B's item, named from A: no content facts at all.
    const foreign = await inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: fixtures.b.contentItemId,
        ruleId: null,
      }),
    );
    expect(foreign['content.channels']).toBeUndefined();
  });
});
