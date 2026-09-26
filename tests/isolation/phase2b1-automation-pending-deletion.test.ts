import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import { WORKSPACE_PENDING_DELETION_FAILURE } from '@brandspace/automation';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import { platformRoleClient } from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 2 (D-328) — A WORKSPACE PENDING DELETION RUNS NO
 * AUTOMATION, AGAINST REAL POSTGRESQL.
 *
 * Two layers: the scheduler's rule producers do not visit its rules, and the
 * engine — in the transaction that would perform the action — refuses an event
 * that was already on its way when the deletion was requested. The refusal is
 * visible: the run ends BLOCKED_BY_POLICY with a stable reason, is audited, and
 * the outbox row is retired rather than dropped or retried for ever.
 */

let platform: PrismaClient;
const BATCH = 500;
// Older than any rule another suite leaves behind, so the fair-work cursor
// (ordered by nextEvaluationAt) puts this suite's rules at the front of the batch.
const PAST = new Date(Date.UTC(2000, 0, 1));
const FUTURE = new Date(Date.UTC(2100, 0, 1));

beforeAll(() => {
  platform = platformRoleClient();
});

afterAll(async () => {
  await closeQueues();
  await platform.$disconnect();
});

async function world(pending: boolean) {
  const id = randomUUID();
  const user = await platform.user.create({
    data: {
      email: `p2b1-auto-${id.slice(0, 8)}@example.local`,
      name: 'Automation owner',
      status: 'ACTIVE',
      timezone: 'UTC',
    },
    select: { id: true },
  });
  await platform.workspace.create({
    data: {
      id,
      workspaceId: id,
      slug: `p2b1-auto-${id.slice(0, 12)}`,
      name: 'Automation',
      ownerUserId: user.id,
      status: 'ACTIVE',
      country: 'US',
      defaultLocale: 'EN',
      timezone: 'UTC',
      currency: 'USD',
      ...(pending
        ? {
            deletionRequestedAt: new Date(),
            deletionScheduledFor: new Date(Date.now() + 30 * 86_400_000),
          }
        : {}),
    },
  });
  const brand = await platform.brand.create({
    data: { workspaceId: id, slug: `auto-${id.slice(0, 8)}`, name: 'Auto', status: 'ACTIVE' },
    select: { id: true },
  });
  return { workspaceId: id, brandId: brand.id, userId: user.id };
}

function rule(
  w: Awaited<ReturnType<typeof world>>,
  triggerType: 'SCHEDULED_TIME' | 'METRIC_THRESHOLD_CROSSED',
  nextEvaluationAt: Date = PAST,
) {
  return platform.automationRule.create({
    data: {
      workspaceId: w.workspaceId,
      brandId: w.brandId,
      name: `p2b1 ${triggerType} ${randomUUID()}`,
      enabled: true,
      triggerType,
      triggerConfig: (triggerType === 'SCHEDULED_TIME'
        ? { hourLocal: 9, weekdays: [0, 1, 2, 3, 4, 5, 6] }
        : { metricKey: 'followers', direction: 'above', threshold: 100, windowDays: 7 }) as never,
      conditions: [],
      actionType: 'NOTIFY',
      actionConfig: { templateKey: 'automation.confirmation_required' } as never,
      maxRunsPerDay: 0,
      createdByUserId: w.userId,
      nextEvaluationAt,
    },
    select: { id: true },
  });
}

describe('Review item 2 · the rule producers skip a workspace pending deletion', () => {
  it('neither producer visits its rules; the same rules in an open workspace are visited', async () => {
    const closed = await world(true);
    const open = await world(false);
    const closedRules = [
      await rule(closed, 'SCHEDULED_TIME'),
      await rule(closed, 'METRIC_THRESHOLD_CROSSED'),
    ];
    const openRules = [
      await rule(open, 'SCHEDULED_TIME'),
      await rule(open, 'METRIC_THRESHOLD_CROSSED'),
    ];

    await new MaintenanceScheduler({ environment: 'DEVELOPMENT' }).sweepAutomations(BATCH);

    const read = (ids: string[]) =>
      platform.automationRule.findMany({
        where: { id: { in: ids } },
        select: { id: true, nextEvaluationAt: true },
      });
    // Not visited: still parked where it was, and no event written for it.
    for (const row of await read(closedRules.map((r) => r.id))) {
      expect(row.nextEvaluationAt?.getTime()).toBe(PAST.getTime());
    }
    expect(
      await platform.automationEvent.count({ where: { workspaceId: closed.workspaceId } }),
    ).toBe(0);
    // The control: an open workspace's rules were visited (their cursor moved).
    for (const row of await read(openRules.map((r) => r.id))) {
      expect(row.nextEvaluationAt?.getTime()).not.toBe(PAST.getTime());
    }
  });
});

describe('Review item 2 · an event that reaches the worker after the request runs nothing', () => {
  it('the run ends BLOCKED_BY_POLICY (workspace_pending_deletion), audited; no action; the event is retired', async () => {
    // Produced while the workspace was open …
    const w = await world(false);
    // Parked far ahead, so no sweep visits it: this is about the worker alone.
    const { id: ruleId } = await rule(w, 'SCHEDULED_TIME', FUTURE);
    const occurrence = `2026-10-01:09`;
    const event = await platform.automationEvent.create({
      data: {
        workspaceId: w.workspaceId,
        brandId: w.brandId,
        triggerType: 'SCHEDULED_TIME',
        ruleId,
        occurrence,
        dedupeKey: `SCHEDULED_TIME:${ruleId}:${occurrence}`,
        dispatchedAt: new Date(),
      },
    });
    // … and the deletion is requested while it waits in the queue.
    await platform.workspace.update({
      where: { id: w.workspaceId },
      data: {
        deletionRequestedAt: new Date(),
        deletionScheduledFor: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    await processAutomationJob({
      kind: EVALUATE_AUTOMATION,
      workspaceId: w.workspaceId,
      idempotencyKey: `automation-event-${event.id}`,
      eventId: event.id,
      eventKey: event.dedupeKey,
      brandId: w.brandId,
      triggerType: 'SCHEDULED_TIME',
      refType: null,
      refId: null,
      ruleId,
      occurrence,
    });

    const runs = await platform.automationRun.findMany({
      where: { workspaceId: w.workspaceId, ruleId },
      select: { id: true, status: true, failureCode: true, finishedAt: true },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'BLOCKED_BY_POLICY',
      failureCode: WORKSPACE_PENDING_DELETION_FAILURE,
    });
    const run = runs[0];
    if (!run) throw new Error('no run recorded');
    expect(run.finishedAt).not.toBeNull();
    // The action did not run: NOTIFY would have written a notification.
    expect(await platform.notification.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
    // Audited like every refusal, with the reason.
    const audit = await platform.auditEvent.findFirst({
      where: { workspaceId: w.workspaceId, action: 'automation.run', resourceId: run.id },
      select: { outcome: true, reason: true },
    });
    expect(audit).toMatchObject({ outcome: 'DENIED', reason: WORKSPACE_PENDING_DELETION_FAILURE });
    // Retired, not silently dropped and not retried for ever.
    expect(
      (await platform.automationEvent.findUniqueOrThrow({ where: { id: event.id } })).deliveredAt,
    ).not.toBeNull();
  });
});
