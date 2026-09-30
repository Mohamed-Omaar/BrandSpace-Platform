import { randomUUID } from 'node:crypto';
import type { AutomationEvent, AutomationTrigger, PrismaClient } from '@prisma/client';
import { EVALUATE_AUTOMATION } from '@brandspace/jobs';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';

/**
 * PHASE 2B-3 PR 3 — SHARED SET-UP FOR THE TIMED G13 PRODUCER SUITES.
 *
 * The producers run in the API's real `MaintenanceScheduler` against real
 * PostgreSQL, with the clock injected, and deliver through the worker's real
 * `processAutomationJob`. Nothing here fakes the database or the concurrency.
 *
 * THE RULES ARE PARKED IN THE PAST so the fair-work queue (`nextEvaluationAt`,
 * then id) puts them at the front of a large batch, whatever other suites left
 * in a long-lived local database; and every suite switches its rules off at the
 * end, so it leaves nothing behind for the next one to trip over (F-90).
 */

export const BATCH = 500;
export const PAST = new Date(Date.UTC(2000, 0, 1));
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function schedulerAt(now: Date): MaintenanceScheduler {
  return new MaintenanceScheduler({ environment: 'DEVELOPMENT', clock: { now: () => now } });
}

export async function sweepAt(now: Date): Promise<number> {
  return (await schedulerAt(now).sweepAutomations(BATCH)).produced;
}

export async function newBrand(platform: PrismaClient, workspaceId: string): Promise<string> {
  return (
    await platform.brand.create({
      data: {
        workspaceId,
        slug: `pr3-${randomUUID().slice(0, 10)}`,
        name: 'PR 3 brand',
        status: 'ACTIVE',
      },
      select: { id: true },
    })
  ).id;
}

const created: { workspaceId: string; id: string }[] = [];

/** An ENABLED rule on a timed trigger, armed at `armedAt`, due now. */
export async function timedRule(
  platform: PrismaClient,
  input: {
    readonly workspaceId: string;
    readonly brandId: string;
    readonly triggerType: AutomationTrigger;
    readonly armedAt: Date | null;
    readonly createdByUserId: string;
    readonly actionType?: 'NOTIFY_PERSON' | 'REMIND_REVIEWER' | 'MAKE_DRAFT_COPY';
    readonly conditions?: unknown;
  },
): Promise<string> {
  const rule = await platform.automationRule.create({
    data: {
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      name: `pr3 ${input.triggerType} ${randomUUID().slice(0, 8)}`,
      enabled: true,
      triggerType: input.triggerType,
      triggerConfig: {},
      conditions: (input.conditions ?? []) as never,
      actionType: input.actionType ?? 'NOTIFY_PERSON',
      actionConfig:
        (input.actionType ?? 'NOTIFY_PERSON') === 'NOTIFY_PERSON'
          ? { userId: input.createdByUserId }
          : {},
      createdByUserId: input.createdByUserId,
      maxRunsPerDay: 0,
      armedAt: input.armedAt,
      nextEvaluationAt: PAST,
    },
    select: { id: true },
  });
  created.push({ workspaceId: input.workspaceId, id: rule.id });
  return rule.id;
}

/** Put a rule back at the front of the queue, as if its park had run out. */
export async function dueNow(platform: PrismaClient, ruleId: string): Promise<void> {
  await platform.automationRule.update({
    where: { id: ruleId },
    data: { nextEvaluationAt: PAST },
  });
}

export async function eventsFor(
  platform: PrismaClient,
  ruleId: string,
): Promise<AutomationEvent[]> {
  return platform.automationEvent.findMany({
    where: { ruleId },
    orderBy: [{ createdAt: 'asc' }, { dedupeKey: 'asc' }],
  });
}

/** Deliver one outbox row through the worker, exactly as dispatch would. */
export async function deliver(event: AutomationEvent): Promise<void> {
  await processAutomationJob({
    kind: EVALUATE_AUTOMATION,
    workspaceId: event.workspaceId,
    idempotencyKey: `automation-event-${event.id}`,
    eventId: event.id,
    eventKey: event.dedupeKey,
    brandId: event.brandId,
    triggerType: event.triggerType,
    refType: event.refType,
    refId: event.refId,
    ruleId: event.ruleId,
    occurrence: event.occurrence,
  });
}

export async function runsFor(platform: PrismaClient, ruleId: string) {
  return platform.automationRun.findMany({
    where: { ruleId },
    select: { id: true, status: true, failureCode: true, triggerRefId: true },
    orderBy: { startedAt: 'asc' },
  });
}

/** Switch off every rule this process created, so the next suite's queue is clean. */
export async function disableCreatedRules(platform: PrismaClient): Promise<void> {
  for (const rule of created.splice(0)) {
    await platform.automationRule.updateMany({
      where: { id: rule.id, workspaceId: rule.workspaceId },
      data: { enabled: false },
    });
  }
}
