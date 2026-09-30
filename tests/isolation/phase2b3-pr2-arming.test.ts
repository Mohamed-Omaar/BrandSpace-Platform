import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationPolicy,
} from '@brandspace/automation';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 2B-3, PR 2 — A RULE LISTENS FROM THE MOMENT IT IS ARMED (OD-21, no
 * backfill), AGAINST REAL POSTGRESQL AND THROUGH THE REAL WORKER PROCESSOR.
 *
 *   - `armedAt` is set when a rule is created, switched on, or given new
 *     trigger settings — and by nothing else.
 *   - An outbox event created before `armedAt` ends NOT_RUN with no run row;
 *     the outbox row is still retired.
 *   - An event after it runs; a rule stored before PR 2 (no `armedAt`) runs
 *     exactly as it always did.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
let policy: AutomationPolicy;

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

function actor(): AutomationActor {
  return {
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'automation.manage', 'content.schedule'],
    brandScope: [],
  };
}

const at = (iso: string) => new Date(iso);
const engineAt = (db: TenantScopedClient, now: Date) =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy,
    ports: {},
    clock: { now: () => now },
  });

/** A stored, ENABLED rule on CONTENT_APPROVED that notifies — armed at `armedAt`. */
async function listeningRule(armedAt: Date | null): Promise<string> {
  const rule = await inA((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      name: `pr2 arming ${randomUUID().slice(0, 8)}`,
      triggerType: 'CONTENT_APPROVED',
      actionType: 'NOTIFY',
      actionConfig: { templateKey: 'automation.notice' },
      createdByUserId: fixtures.a.userId,
      enabled: true,
      maxRunsPerDay: 0,
      armedAt,
    }),
  );
  return rule.id;
}

/** One outbox event created at `createdAt`, delivered through the worker. */
async function deliverAt(createdAt: Date): Promise<{ eventId: string }> {
  const approvalId = randomUUID();
  const event = await inA((db) =>
    db.automationEvent.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: fixtures.a.contentItemId,
        dedupeKey: `CONTENT_APPROVED:${approvalId}`,
        createdAt,
        dispatchedAt: new Date(),
      },
    }),
  );
  await processAutomationJob({
    kind: EVALUATE_AUTOMATION,
    workspaceId: fixtures.a.workspaceId,
    idempotencyKey: `automation-event-${event.id}`,
    eventId: event.id,
    eventKey: event.dedupeKey,
    brandId: fixtures.a.brandId,
    triggerType: 'CONTENT_APPROVED',
    refType: 'ContentItem',
    refId: fixtures.a.contentItemId,
    ruleId: null,
    occurrence: null,
  });
  return { eventId: event.id };
}

const runsOf = (ruleId: string) =>
  inA((db) => db.automationRun.findMany({ where: { ruleId }, select: { status: true } }));
const deliveredAt = (eventId: string) =>
  inA(
    async (db) =>
      (await db.automationEvent.findFirstOrThrow({ where: { id: eventId } })).deliveredAt,
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  policy = parseAutomationPolicy(defaultPayload('automations'));
}, 60_000);

afterEach(async () => {
  await inA((db) =>
    db.automationRule.updateMany({
      where: { workspaceId: fixtures.a.workspaceId, name: { startsWith: 'pr2 arming' } },
      data: { deletedAt: new Date(), enabled: false },
    }),
  );
});

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

describe('what arms a rule', () => {
  it('creation arms it at the moment it is created', async () => {
    const now = at('2026-09-30T10:00:00Z');
    const rule = await inA((db) =>
      engineAt(db, now).createRule({
        brandId: fixtures.a.brandId,
        name: `pr2 arming created ${randomUUID().slice(0, 8)}`,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {},
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.notice' },
        actor: actor(),
      }),
    );
    expect(rule.armedAt).toEqual(now);
  });

  it('switching it on re-arms it; switching off, or on again while on, does not', async () => {
    const ruleId = await listeningRule(at('2026-01-01T00:00:00Z'));
    await inA((db) =>
      db.automationRule.update({ where: { id: ruleId }, data: { enabled: false } }),
    );

    const onAt = at('2026-09-30T11:00:00Z');
    const on = await inA((db) =>
      engineAt(db, onAt).updateRule({ ruleId, enabled: true, actor: actor() }),
    );
    expect(on.armedAt).toEqual(onAt);

    const again = await inA((db) =>
      engineAt(db, at('2026-09-30T12:00:00Z')).updateRule({
        ruleId,
        enabled: true,
        actor: actor(),
      }),
    );
    expect(again.armedAt).toEqual(onAt);

    const off = await inA((db) =>
      engineAt(db, at('2026-09-30T13:00:00Z')).updateRule({
        ruleId,
        enabled: false,
        actor: actor(),
      }),
    );
    expect(off.armedAt).toEqual(onAt);
  });

  it('new trigger settings re-arm it; a name, conditions or action settings do not', async () => {
    const armed = at('2026-01-01T00:00:00Z');
    const rule = await inA((db) =>
      seedStoredRule(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `pr2 arming timed ${randomUUID().slice(0, 8)}`,
        triggerType: 'SCHEDULED_TIME',
        triggerConfig: { hourLocal: 9 },
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.notice' },
        createdByUserId: fixtures.a.userId,
        armedAt: armed,
      }),
    );
    const renamed = await inA((db) =>
      engineAt(db, at('2026-09-30T10:00:00Z')).updateEditableRule({
        ruleId: rule.id,
        expectedVersion: rule.version,
        name: `pr2 arming renamed ${randomUUID().slice(0, 8)}`,
        triggerConfig: { hourLocal: 9 },
        actor: actor(),
      }),
    );
    expect(renamed.armedAt).toEqual(armed);

    const movedAt = at('2026-09-30T11:00:00Z');
    const moved = await inA((db) =>
      engineAt(db, movedAt).updateEditableRule({
        ruleId: rule.id,
        expectedVersion: renamed.version,
        triggerConfig: { hourLocal: 17 },
        actor: actor(),
      }),
    );
    expect(moved.armedAt).toEqual(movedAt);
  });
});

describe('an event older than the arming does not reach the rule', () => {
  it('before armedAt: NOT_RUN, no run row, and the outbox row is still retired', async () => {
    const armedAt = new Date(Date.now() - 60_000);
    const ruleId = await listeningRule(armedAt);
    const { eventId } = await deliverAt(new Date(armedAt.getTime() - 60_000));
    expect(await runsOf(ruleId)).toEqual([]);
    expect(await deliveredAt(eventId)).not.toBeNull();
  });

  it('after armedAt: it runs', async () => {
    const armedAt = new Date(Date.now() - 60_000);
    const ruleId = await listeningRule(armedAt);
    await deliverAt(new Date(armedAt.getTime() + 1_000));
    expect(await runsOf(ruleId)).toEqual([{ status: 'SUCCEEDED' }]);
  });

  it('a rule stored before PR 2 (no armedAt) runs on an old event, as it always did', async () => {
    const ruleId = await listeningRule(null);
    await deliverAt(new Date('2020-01-01T00:00:00Z'));
    expect(await runsOf(ruleId)).toEqual([{ status: 'SUCCEEDED' }]);
  });

  it('two rules on one event: only the one armed before it runs', async () => {
    const eventAt = new Date(Date.now() - 30_000);
    const early = await listeningRule(new Date(eventAt.getTime() - 60_000));
    const late = await listeningRule(new Date(eventAt.getTime() + 60_000));
    await deliverAt(eventAt);
    expect(await runsOf(early)).toEqual([{ status: 'SUCCEEDED' }]);
    expect(await runsOf(late)).toEqual([]);
  });
});
