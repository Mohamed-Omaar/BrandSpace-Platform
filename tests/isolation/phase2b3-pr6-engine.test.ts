import { randomUUID } from 'node:crypto';
import type { AutomationRule, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import type { Clock } from '@brandspace/shared';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-3 PR 6 — DRAFT_IDEAS IN THE ENGINE, AGAINST REAL POSTGRESQL.
 *
 *   - authoring: written only by someone holding `content.create` AND
 *     `copilot.use` (D-405 / D-315), and only when the plan includes it
 *     (owner decision 11);
 *   - running: every engine gate, then AWAITING_EXECUTION, due now — nothing
 *     charged, nothing counted, nothing drafted (the API executor does that);
 *   - a workspace that lost the entitlement: BLOCKED_BY_POLICY `not_entitled`.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

// FROZEN, not fixed to a calendar date: a run row's `startedAt` is the
// database's own now(), and `durationMs` is measured from it. Nothing asserted
// below depends on what the date is.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const clock: Clock = { now: () => NOW };

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const AUTHOR = ['workspace.read', 'automation.manage', 'content.create', 'copilot.use'];

function actor(permissionKeys: readonly string[] = AUTHOR): AutomationActor {
  return { userId: fixtures.a.userId, roleKey: 'workspace_owner', permissionKeys, brandScope: [] };
}

let entitled = true;
let asked: string[] = [];
const engine = (db: TenantScopedClient, withPort = true) =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    clock,
    ports: withPort
      ? {
          entitlements: {
            allows: async (featureKey: string) => {
              asked.push(featureKey);
              return entitled;
            },
          },
        }
      : {},
  });

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  // The analytics events are configured, so POST_TOP_10_PERCENT may be authored.
  policy = parseAutomationPolicy({
    events: {
      weeklyEngagementDrop: { minBaseline: 100 },
      topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
    },
  });
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

const createDraftIdeas = (db: TenantScopedClient, withPort: boolean, by = actor()) =>
  engine(db, withPort).createRule({
    brandId: fixtures.a.brandId,
    name: `pr6 ideas ${randomUUID().slice(0, 8)}`,
    triggerType: 'POST_TOP_10_PERCENT',
    triggerConfig: {},
    conditions: [],
    actionType: 'DRAFT_IDEAS',
    actionConfig: {},
    actor: by,
  });

describe('authoring DRAFT_IDEAS', () => {
  it('is refused when the plan does not include it, or nobody can ask the plan', async () => {
    entitled = false;
    asked = [];
    await expect(inA((db) => createDraftIdeas(db, true))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(asked).toEqual(['limit.automation_ai_actions']);
    entitled = true;
    await expect(inA((db) => createDraftIdeas(db, false))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('needs content.create AND copilot.use', async () => {
    entitled = true;
    for (const missing of ['content.create', 'copilot.use']) {
      await expect(
        inA((db) => createDraftIdeas(db, true, actor(AUTHOR.filter((key) => key !== missing)))),
        missing,
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('is never paired with a trigger outside its five', async () => {
    entitled = true;
    await expect(
      inA((db) =>
        engine(db).createRule({
          brandId: fixtures.a.brandId,
          name: `pr6 ideas ${randomUUID().slice(0, 8)}`,
          triggerType: 'POST_PUBLISHED',
          triggerConfig: {},
          conditions: [],
          actionType: 'DRAFT_IDEAS',
          actionConfig: {},
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('is accepted, disabled by default, when entitled', async () => {
    entitled = true;
    const rule = await inA((db) => createDraftIdeas(db, true));
    expect(rule.actionType).toBe('DRAFT_IDEAS');
  });
});

describe('running DRAFT_IDEAS', () => {
  let rule: AutomationRule;

  beforeAll(async () => {
    entitled = true;
    rule = await inA((db) => createDraftIdeas(db, true));
  });

  const run = (resolved: AutomationActor | null = actor()) =>
    inA((db) =>
      engine(db).run({
        rule: { ...rule, enabled: true, armedAt: null },
        event: {
          type: 'POST_TOP_10_PERCENT',
          brandId: fixtures.a.brandId,
          refType: 'ContentItem',
          refId: fixtures.a.contentItemId,
          eventKey: `pr6-engine:${randomUUID()}`,
          facts: {},
        },
        resolveActor: async () => resolved,
      }),
    );

  it('every gate passed: AWAITING_EXECUTION, due now, nothing leased', async () => {
    entitled = true;
    const outcome = await run();
    expect(outcome.status).toBe('AWAITING_EXECUTION');
    const stored = await platform.automationRun.findUniqueOrThrow({
      where: { id: outcome.run!.id },
    });
    expect(stored).toMatchObject({
      status: 'AWAITING_EXECUTION',
      conditionsHeld: true,
      executionAvailableAt: NOW,
      executionAttempts: 0,
      executionLeaseId: null,
      failureCode: null,
      finishedAt: null,
    });
    const audit = await platform.auditEvent.findFirst({
      where: { resourceId: outcome.run!.id, action: 'automation.awaiting_execution' },
    });
    expect(audit).not.toBeNull();
    // Another workspace never sees it.
    expect(
      await inB((db) => db.automationRun.findFirst({ where: { id: outcome.run!.id } })),
    ).toBeNull();
  });

  it('a plan that no longer includes it: BLOCKED_BY_POLICY not_entitled', async () => {
    entitled = false;
    const outcome = await run();
    expect([outcome.status, outcome.run?.failureCode]).toEqual([
      'BLOCKED_BY_POLICY',
      'not_entitled',
    ]);
    entitled = true;
  });

  it('a creator without copilot.use: BLOCKED_BY_AUTHORIZATION, the plan never asked', async () => {
    asked = [];
    const outcome = await run(actor(AUTHOR.filter((key) => key !== 'copilot.use')));
    expect([outcome.status, outcome.run?.failureCode]).toEqual([
      'BLOCKED_BY_AUTHORIZATION',
      'creator_lost_permission',
    ]);
    expect(asked).toEqual([]);
  });
});
