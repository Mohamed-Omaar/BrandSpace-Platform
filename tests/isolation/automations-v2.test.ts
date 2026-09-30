import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, writeDeniedAudit, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AUTOMATION_RULE_NAME_TAKEN_REASON,
  AUTOMATION_RULE_VERSION_CONFLICT_REASON,
  AutomationEngine,
  evaluateConditions,
  gatherFacts,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationCondition,
  type AutomationPolicy,
} from '@brandspace/automation';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';
import type { CustomerWorkspaceContext } from '@brandspace/auth';
import { attentionItems } from '../../apps/dashboard/src/server/command-center';
import { seedStoredRule } from './stored-automation-rule';

/**
 * B12 + G13 OPTION (a) (Phase 2B-2b) — AUTOMATIONS v2, AGAINST REAL POSTGRESQL.
 *
 *   1. `updateEditableRule` edits name, description, conditions and both
 *      settings; never `enabled`; fails closed on a stale version; re-checks the
 *      action's permission when the action's settings change.
 *   2. Campaign, format and person are real facts, and a person who is no
 *      longer an active member matches NOTHING under any operator.
 *   3. Skip is gated exactly like confirm, and leaves the run as history.
 *   4. "Needs you" lists only the runs this person could decide.
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

const ALL = [
  'workspace.read',
  'automation.manage',
  'automation.read',
  'content.submit',
  'content.schedule',
  'publishing.manage',
];
function actor(overrides: Partial<AutomationActor> = {}): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ALL,
    brandScope: [],
    ...overrides,
  };
}
/**
 * Wired the way `apps/api` wires it: a refusal is written in its OWN
 * transaction, because the one that refused is about to roll back.
 */
const engine = (db: TenantScopedClient, workspaceId = fixtures.a.workspaceId) =>
  new AutomationEngine({
    db,
    workspaceId,
    policy,
    ports: {},
    denialSink: async (event) => {
      await withWorkspace(
        workspaceId,
        async (fresh) =>
          writeDeniedAudit(fresh, workspaceId, {
            action: 'automation.confirmation_refused',
            actorType: 'USER',
            actorId: event.actorUserId,
            resourceType: 'AutomationRun',
            resourceId: event.runId,
            brandId: event.brandId,
            reason: event.reason,
          }),
        { prisma: app },
      );
    },
  });

/**
 * A STORED rule of a pre-G13 shape (Phase 2B-3 PR 2: no new rule may take one
 * any more; every stored one is still edited, run and confirmed exactly as
 * before, which is what this suite is about).
 */
async function rule(input: {
  triggerType?: 'CONTENT_APPROVED' | 'SCHEDULED_TIME' | 'METRIC_THRESHOLD_CROSSED';
  actionType?: 'NOTIFY' | 'PLACE_ON_CALENDAR' | 'PROPOSE_PUBLISH';
  triggerConfig?: unknown;
  actionConfig?: unknown;
  brandId?: string;
}) {
  return inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: input.brandId ?? fixtures.a.brandId,
      name: `v2 ${randomUUID().slice(0, 8)}`,
      triggerType: input.triggerType ?? 'CONTENT_APPROVED',
      triggerConfig: input.triggerConfig ?? {},
      conditions: [],
      actionType: input.actionType ?? 'NOTIFY',
      actionConfig: input.actionConfig ?? { templateKey: 'automation.notice' },
      createdByUserId: fixtures.a.userId,
    }),
  );
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
          slug: `v2-other-${randomUUID().slice(0, 8)}`,
          name: 'Other',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    )
  ).id;
}, 120_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

describe('updateEditableRule', () => {
  it('edits name, description, conditions and trigger settings, and never touches enabled', async () => {
    const created = await rule({
      triggerType: 'SCHEDULED_TIME',
      triggerConfig: { hourLocal: 9, daysOfWeek: [] },
    });
    await platform.automationRule.update({
      where: { id: created.id },
      data: { enabled: true, version: { increment: 1 } },
    });
    const before = await platform.automationRule.findUniqueOrThrow({ where: { id: created.id } });

    const edited = await inA((db) =>
      engine(db).updateEditableRule({
        ruleId: created.id,
        expectedVersion: before.version,
        name: '  Morning digest  ',
        description: 'Tell the team every weekday.',
        conditions: [{ field: 'brand.id', operator: 'equals', value: fixtures.a.brandId }],
        triggerConfig: { hourLocal: 7, daysOfWeek: [1, 2, 3, 4, 5] },
        actor: actor(),
      }),
    );
    expect(edited.name).toBe('Morning digest');
    expect(edited.description).toBe('Tell the team every weekday.');
    expect(edited.enabled).toBe(true);
    expect(edited.version).toBe(before.version + 1);
    expect(edited.triggerConfig).toEqual({ hourLocal: 7, daysOfWeek: [1, 2, 3, 4, 5] });
    expect(edited.conditions).toEqual([
      { field: 'brand.id', operator: 'equals', value: fixtures.a.brandId },
    ]);

    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { resourceId: created.id, action: 'automation.updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.after).toMatchObject({
      changed: ['name', 'description', 'conditions', 'triggerConfig'],
    });
    // Which fields changed, never their values.
    expect(JSON.stringify(audit.after)).not.toContain(fixtures.a.brandId);
  });

  it('a stale version is refused and nothing is written', async () => {
    const created = await rule({});
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version - 1,
          name: 'Late edit',
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: AUTOMATION_RULE_VERSION_CONFLICT_REASON },
    });
    const row = await platform.automationRule.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.name).toBe(created.name);
    expect(row.version).toBe(created.version);
  });

  it('two edits against one version: exactly one lands', async () => {
    const created = await rule({});
    const results = await Promise.allSettled(
      ['First', 'Second'].map((name) =>
        inA((db) =>
          engine(db).updateEditableRule({
            ruleId: created.id,
            expectedVersion: created.version,
            name: `${name} ${randomUUID().slice(0, 4)}`,
            actor: actor(),
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('a changed trigger setting re-arms the rule like a new one', async () => {
    const created = await rule({
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      triggerConfig: { metricKey: 'impressions', direction: 'above', threshold: 100 },
    });
    await platform.automationRule.update({
      where: { id: created.id },
      data: {
        thresholdBreached: true,
        thresholdCycle: 3,
        nextEvaluationAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const edited = await inA((db) =>
      engine(db).updateEditableRule({
        ruleId: created.id,
        expectedVersion: created.version,
        triggerConfig: { metricKey: 'impressions', direction: 'above', threshold: 500 },
        actor: actor(),
      }),
    );
    expect(edited.thresholdBreached).toBeNull();
    expect(edited.thresholdCycle).toBe(3);
    expect(edited.nextEvaluationAt.getTime()).toBeLessThan(Date.now() + 1_000);
  });

  it('changing the ACTION’s settings needs the action’s own permission', async () => {
    const created = await rule({
      actionType: 'PLACE_ON_CALENDAR',
      actionConfig: { offsetHours: 24 },
    });
    const withoutSchedule = actor({
      permissionKeys: ALL.filter((key) => key !== 'content.schedule'),
    });
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version,
          actionConfig: { offsetHours: 48 },
          actor: withoutSchedule,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The same settings, unchanged, are not a change — no permission is needed.
    const renamed = await inA((db) =>
      engine(db).updateEditableRule({
        ruleId: created.id,
        expectedVersion: created.version,
        name: `Renamed ${randomUUID().slice(0, 4)}`,
        actionConfig: { offsetHours: 24 },
        actor: withoutSchedule,
      }),
    );
    expect(renamed.actionConfig).toEqual({ offsetHours: 24 });
    const moved = await inA((db) =>
      engine(db).updateEditableRule({
        ruleId: created.id,
        expectedVersion: renamed.version,
        actionConfig: { offsetHours: 48 },
        actor: actor(),
      }),
    );
    expect(moved.actionConfig).toEqual({ offsetHours: 48 });
  });

  it('runs the create path’s checks: a condition this trigger never produces is refused', async () => {
    const created = await rule({
      triggerType: 'SCHEDULED_TIME',
      triggerConfig: { hourLocal: 9, daysOfWeek: [] },
    });
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version,
          conditions: [{ field: 'content.type', operator: 'equals', value: 'REEL' }],
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version,
          triggerConfig: { hourLocal: 25, daysOfWeek: [] },
          actor: actor(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('a name another rule of the brand already has is refused with its own reason', async () => {
    const first = await rule({});
    const second = await rule({});
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: second.id,
          expectedVersion: second.version,
          name: first.name,
          actor: actor(),
        }),
      ),
    ).rejects.toMatchObject({ publicDetails: { reason: AUTOMATION_RULE_NAME_TAKEN_REASON } });
  });

  it('another brand’s member and another workspace see NOT_FOUND', async () => {
    const created = await rule({});
    await expect(
      inA((db) =>
        engine(db).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version,
          name: 'Hijack',
          actor: actor({ brandScope: [otherBrandId] }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      inB((db) =>
        engine(db, fixtures.b.workspaceId).updateEditableRule({
          ruleId: created.id,
          expectedVersion: created.version,
          name: 'Hijack',
          actor: actor({ userId: fixtures.b.userId }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('campaign, format and person are real facts', () => {
  async function post(authorUserId: string | null): Promise<string> {
    const item = await platform.contentItem.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        campaignId: fixtures.a.campaignId,
        title: 'Fact post',
        contentType: 'REEL',
        primaryLocale: 'EN',
        status: 'APPROVED',
        createdByUserId: authorUserId,
      } as never,
      select: { id: true },
    });
    return item.id;
  }
  const factsFor = (itemId: string) =>
    inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: itemId,
        ruleId: null,
      }),
    );

  it('produces the campaign, the format and the ACTIVE author', async () => {
    const facts = await factsFor(await post(fixtures.a.userId));
    expect(facts['content.campaignId']).toBe(fixtures.a.campaignId);
    expect(facts['content.type']).toBe('REEL');
    expect(facts['content.authorUserId']).toBe(fixtures.a.userId);
    expect(
      evaluateConditions(
        [{ field: 'content.authorUserId', operator: 'equals', value: fixtures.a.userId }],
        facts,
      ),
    ).toBe(true);
  });

  it('an author who left resolves to nothing, and every operator on them fails closed', async () => {
    // A member of workspace A who then leaves it.
    const leaver = await platform.user.create({
      data: { email: `leaver-${randomUUID()}@example.test`, timezone: 'UTC' },
      select: { id: true },
    });
    const role = await platform.role.findFirstOrThrow({
      where: { key: 'marketing_manager', workspaceId: null },
      select: { id: true },
    });
    await platform.membership.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        userId: leaver.id,
        roleId: role.id,
        status: 'REMOVED',
      },
    });
    const facts = await factsFor(await post(leaver.id));
    expect(facts['content.authorUserId']).toBeNull();
    const conditions: AutomationCondition[] = [
      { field: 'content.authorUserId', operator: 'equals', value: leaver.id },
      { field: 'content.authorUserId', operator: 'not_equals', value: fixtures.a.userId },
      { field: 'content.authorUserId', operator: 'in', value: [leaver.id] },
      { field: 'content.authorUserId', operator: 'not_in', value: [fixtures.a.userId] },
    ];
    for (const condition of conditions) {
      expect(evaluateConditions([condition], facts), condition.operator).toBe(false);
    }
  });

  it('a post with no recorded author fails closed too', async () => {
    const facts = await factsFor(await post(null));
    expect(
      evaluateConditions(
        [{ field: 'content.authorUserId', operator: 'not_equals', value: fixtures.a.userId }],
        facts,
      ),
    ).toBe(false);
  });
});

describe('Skip, and "Needs you"', () => {
  let proposeRuleId: string;

  beforeAll(async () => {
    proposeRuleId = (await rule({ actionType: 'PROPOSE_PUBLISH' })).id;
  });

  async function waiting(input: { brandId?: string; expiresInMs?: number } = {}): Promise<string> {
    const run = await platform.automationRun.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: input.brandId ?? fixtures.a.brandId,
        ruleId: proposeRuleId,
        status: 'AWAITING_CONFIRMATION',
        triggerType: 'CONTENT_APPROVED',
        idempotencyKey: `v2-${randomUUID()}`,
        conditionsHeld: true,
        actionType: 'PROPOSE_PUBLISH',
        confirmationExpiresAt: new Date(Date.now() + (input.expiresInMs ?? 600_000)),
        correlationId: randomUUID(),
      },
      select: { id: true },
    });
    return run.id;
  }

  it('skipping cancels the run, keeps it as history, and says who decided', async () => {
    const runId = await waiting();
    const skipped = await inA((db) => engine(db).skipRun({ runId, actor: actor() }));
    expect(skipped.status).toBe('CANCELLED');
    expect(skipped.failureCode).toBe('skipped_by_member');
    expect(skipped.finishedAt).not.toBeNull();
    expect(skipped.confirmedAt).toBeNull();
    const audit = await platform.auditEvent.findFirstOrThrow({
      where: { resourceId: runId, action: 'automation.run_skipped' },
    });
    expect(audit.actorId).toBe(fixtures.a.userId);
  });

  it('a second skip, and a confirmation after a skip, are both refused', async () => {
    const runId = await waiting();
    await inA((db) => engine(db).skipRun({ runId, actor: actor() }));
    await expect(inA((db) => engine(db).skipRun({ runId, actor: actor() }))).rejects.toThrow();
    await expect(
      inA((db) => engine(db).reissueRunConfirmation({ runId, actor: actor() })),
    ).rejects.toThrow();
  });

  it('needs the ACTION’s permission — the same gate as confirming — and audits a refusal', async () => {
    const runId = await waiting();
    await expect(
      inA((db) =>
        engine(db).skipRun({
          runId,
          actor: actor({ permissionKeys: ['automation.manage', 'automation.read'] }),
        }),
      ),
    ).rejects.toThrow();
    const row = await platform.automationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('AWAITING_CONFIRMATION');
    const refusal = await platform.auditEvent.findFirst({
      where: { resourceId: runId, action: 'automation.confirmation_refused' },
    });
    expect(refusal?.reason).toBe('skipper_lacks_permission');
  });

  it('needs the run’s brand in scope, and refuses a run whose window closed', async () => {
    const runId = await waiting();
    await expect(
      inA((db) => engine(db).skipRun({ runId, actor: actor({ brandScope: [otherBrandId] }) })),
    ).rejects.toThrow();
    const expired = await waiting({ expiresInMs: -60_000 });
    await expect(
      inA((db) => engine(db).skipRun({ runId: expired, actor: actor() })),
    ).rejects.toThrow();
    for (const id of [runId, expired]) {
      const row = await platform.automationRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('AWAITING_CONFIRMATION');
    }
  });

  it('another workspace cannot skip it', async () => {
    const runId = await waiting();
    await expect(
      inB((db) =>
        engine(db, fixtures.b.workspaceId).skipRun({
          runId,
          actor: actor({ userId: fixtures.b.userId }),
        }),
      ),
    ).rejects.toThrow();
    const row = await platform.automationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('AWAITING_CONFIRMATION');
  });

  it('Home counts the waiting runs this member could decide, and no others', async () => {
    await waiting();
    await waiting({ brandId: otherBrandId });
    const session = (
      overrides: Partial<CustomerWorkspaceContext> = {},
    ): CustomerWorkspaceContext => ({
      workspaceId: fixtures.a.workspaceId,
      workspaceName: 'A',
      workspaceSlug: 'a',
      workspaceStatus: 'ACTIVE',
      roleKey: 'workspace_owner',
      roleNameEn: 'Owner',
      roleNameAr: 'مالك',
      permissionKeys: ['automation.read', 'publishing.manage'],
      brandScope: [],
      ...overrides,
    });
    const count = async (context: CustomerWorkspaceContext) =>
      (await inA((db) => attentionItems(db, context))).find(
        (item) => item.kind === 'automations-waiting',
      )?.count ?? 0;

    const everything = await count(session());
    expect(everything).toBeGreaterThanOrEqual(2);
    // Without the ACTION's permission nothing waits for you…
    expect(await count(session({ permissionKeys: ['automation.read'] }))).toBe(0);
    // …and without the route's, the item is not built at all.
    expect(await count(session({ permissionKeys: ['publishing.manage'] }))).toBe(0);
    // A member of one brand is not counted the other brand's runs.
    expect(await count(session({ brandScope: [fixtures.a.brandId] }))).toBeLessThan(everything);
  });

  it('"Needs you" lists only open runs whose action this person could take, in scope', async () => {
    const mine = await waiting();
    const otherBrand = await waiting({ brandId: otherBrandId });
    const closed = await waiting({ expiresInMs: -60_000 });

    const all = await inA((db) =>
      engine(db).awaitingRuns({ brandScope: [], permissionKeys: ALL, take: 200 }),
    );
    const ids = all.map((run) => run.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(otherBrand);
    expect(ids).not.toContain(closed);

    const scoped = await inA((db) =>
      engine(db).awaitingRuns({
        brandScope: [fixtures.a.brandId],
        permissionKeys: ALL,
        take: 200,
      }),
    );
    expect(scoped.map((run) => run.id)).not.toContain(otherBrand);

    // Without the action's own permission, nothing is waiting for you.
    const withoutPublishing = await inA((db) =>
      engine(db).awaitingRuns({
        brandScope: [],
        permissionKeys: ['automation.read', 'automation.manage'],
      }),
    );
    expect(withoutPublishing).toHaveLength(0);

    const fromB = await inB((db) =>
      engine(db, fixtures.b.workspaceId).awaitingRuns({ brandScope: [], permissionKeys: ALL }),
    );
    expect(fromB.map((run) => run.id)).not.toContain(mine);
  });
});
