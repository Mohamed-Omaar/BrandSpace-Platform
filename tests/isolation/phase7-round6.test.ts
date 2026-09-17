import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues } from '@brandspace/jobs';
import {
  AutomationEngine,
  parseAutomationPolicy,
  runIdempotencyKeyFor,
  type AutomationActor,
} from '@brandspace/automation';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 7 REMEDIATION, ROUND 6 — the outbox and the engine must agree about
 * what "the same event" means.
 *
 * THE DEFECT, ON REAL ROWS. The outbox identifies a threshold event by the
 * rule's ARMING CYCLE — `METRIC_THRESHOLD_CROSSED:<rule>:<cycle>` — because that
 * is what makes a second crossing a second event. The engine identified a run by
 * `(rule, trigger, refId, bucket)`, and for a threshold that is
 * `(rule, METRIC_THRESHOLD_CROSSED, observationId, 'event')`. Those are not the
 * same identity, and the difference is invisible until an observation MOVES.
 *
 * AND AN OBSERVATION DOES MOVE. Ingestion is
 * `INSERT … ON CONFLICT (workspaceId, observationKey) DO UPDATE SET value = …`,
 * so a provider revising a figure changes the SAME ROW while its id stays put.
 * This suite drives exactly that, on one persisted row:
 *
 *   below → revised above (crossing, cycle 0) → revised below (re-arm, cycle 1)
 *         → revised above again (crossing, cycle 1)
 *
 * The outbox writes two events, correctly. The engine — same refId, same
 * `'event'` bucket — derived ONE run key and dropped the second legitimate run.
 *
 * NOTHING HERE FAKES THE PRODUCER. The real `MaintenanceScheduler.sweepAutomations`
 * runs, against the real metric window port, so the crossings are decided by the
 * same code that decides them in production.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/** F-23: the suite bootstraps what it reads — its own brand and its own reading. */
let brandId: string;
let ruleId: string;
let observationId: string;
const observationKey = `r6-followers-${randomUUID()}`;

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ACTOR = (): AutomationActor => ({
  userId: fixtures.b.userId,
  roleKey: 'workspace_owner',
  permissionKeys: ['workspace.read', 'automation.manage'],
  brandScope: [],
});

const THRESHOLD = 100;
/*
 * A BATCH WIDE ENOUGH THAT THIS SUITE'S RULE IS ALWAYS IN IT. The fair-work
 * cursor (R4-2) orders the producers' enumeration, so with a ceiling well above
 * the number of rules any suite leaves behind this one is never queued out of
 * reach — and nothing has to be parked, so no other suite is disturbed.
 */
const BATCH = 500;

const notified: string[] = [];

const scheduler = () => new MaintenanceScheduler({ environment: 'DEVELOPMENT' });

const engineOn = (db: TenantScopedClient): AutomationEngine =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.b.workspaceId,
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

/** The one reading, revised in place — exactly as ingestion revises it. */
async function reviseTo(value: number): Promise<void> {
  const now = new Date();
  const changed = await inB((db) =>
    db.metricObservation.updateMany({
      where: { workspaceId: fixtures.b.workspaceId, observationKey },
      data: {
        value: BigInt(value),
        observedAt: now,
        periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        periodEnd: now,
      },
    }),
  );
  // THE SAME ROW. If this ever inserted instead, the test would be asserting
  // something easier than the defect.
  expect(changed.count).toBe(1);
}

const events = () =>
  inB((db) =>
    db.automationEvent.findMany({
      where: { workspaceId: fixtures.b.workspaceId, ruleId },
      orderBy: { createdAt: 'asc' },
    }),
  );

const runs = () =>
  inB((db) =>
    db.automationRun.findMany({
      where: { workspaceId: fixtures.b.workspaceId, ruleId },
      orderBy: { startedAt: 'asc' },
      select: { id: true, idempotencyKey: true, status: true, triggerRefId: true },
    }),
  );

/**
 * Deliver one outbox row exactly as `apps/worker` does — including the event
 * key, which is the whole point of this round.
 *
 * THE FACTS ARE THE BRAND'S AND NOTHING MORE. The rule under test carries no
 * conditions, so what a condition could read is not what is being asserted;
 * carrying a full `gatherFacts` result here would only add a second thing that
 * could fail.
 */
async function deliver(event: {
  brandId: string;
  refType: string | null;
  refId: string | null;
  ruleId: string | null;
  occurrence: string | null;
  dedupeKey: string;
}): Promise<number> {
  const outcomes = await inB((db) =>
    engineOn(db).deliver({
      event: {
        type: 'METRIC_THRESHOLD_CROSSED',
        brandId: event.brandId,
        refType: event.refType,
        refId: event.refId,
        ruleId: event.ruleId,
        occurrence: event.occurrence,
        eventKey: event.dedupeKey,
        facts: { 'brand.id': event.brandId },
      },
      resolveActor: async () => ACTOR(),
    }),
  );
  return outcomes.length;
}

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);

  const brand = await inB((db) =>
    db.brand.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        slug: `r6-threshold-${randomUUID().slice(0, 8)}`,
        name: 'R6 threshold identity probe',
      },
    }),
  );
  brandId = brand.id;

  const now = new Date();
  const observation = await inB((db) =>
    db.metricObservation.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        socialConnectionId: fixtures.b.socialConnectionId,
        provider: 'LINKEDIN',
        metricKey: 'followers',
        subjectType: 'ACCOUNT',
        subjectExternalId: `r6-acct-${randomUUID().slice(0, 8)}`,
        granularity: 'DAY',
        periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        periodEnd: now,
        // BELOW THE LINE TO BEGIN WITH, so the first evaluation establishes a
        // side and fires nothing — `null` is never `false` (D-177).
        value: 10n,
        unit: 'COUNT',
        observedAt: now,
        sourceKind: 'PROVIDER',
        sourceVersion: 'r6-identity',
        observationKey,
      },
    }),
  );
  observationId = observation.id;

  const rule = await inB((db) =>
    db.automationRule.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        name: `r6 threshold ${randomUUID()}`,
        enabled: true,
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        triggerConfig: {
          metricKey: 'followers',
          direction: 'above',
          threshold: THRESHOLD,
          windowDays: 7,
        } as never,
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.confirmation_required' } as never,
        maxRunsPerDay: 0,
        createdByUserId: fixtures.b.userId,
      },
    }),
  );
  ruleId = rule.id;
}, 120_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

describe('R6: one observation, revised in place, crosses the line twice', () => {
  it('produces two events, on the same reference, one per arming cycle', async () => {
    // 1. BELOW. The first evaluation records the side and fires nothing.
    await scheduler().sweepAutomations(BATCH);
    expect(await events()).toEqual([]);

    // 2. REVISED ABOVE — a genuine crossing, arming cycle 0.
    await reviseTo(500);
    await scheduler().sweepAutomations(BATCH);
    expect((await events()).length).toBe(1);

    // 3. REVISED BACK BELOW — the rule re-arms, and re-arming is not an event.
    await reviseTo(10);
    await scheduler().sweepAutomations(BATCH);
    expect((await events()).length).toBe(1);

    // 4. REVISED ABOVE AGAIN — a genuine SECOND crossing, arming cycle 1.
    await reviseTo(500);
    await scheduler().sweepAutomations(BATCH);

    const produced = await events();
    expect(produced.length).toBe(2);

    // THE SAME REFERENCE, BOTH TIMES. This is the fact the whole round turns
    // on: the observation id is provenance and it did not move, because the row
    // was UPDATED rather than replaced.
    expect(produced.map((event) => event.refId)).toEqual([observationId, observationId]);
    expect(new Set(produced.map((event) => event.refId)).size).toBe(1);

    // AND TWO DIFFERENT IDENTITIES, because the arming cycle advanced.
    expect(new Set(produced.map((event) => event.dedupeKey)).size).toBe(2);
    for (const event of produced) {
      expect(event.dedupeKey).toMatch(new RegExp(`^METRIC_THRESHOLD_CROSSED:${ruleId}:\\d+$`));
      expect(event.occurrence).toBeNull();
    }
  }, 180_000);

  it('and the OLD run key could not have told them apart', async () => {
    /*
     * THE DEFECT, STATED ARITHMETICALLY. Both events carry the same rule, the
     * same trigger and the same refId, and a non-timed trigger got the constant
     * bucket `'event'` — so the two legitimate crossings hashed to ONE key and
     * the second run was suppressed as a redelivery of the first.
     */
    const produced = await events();
    const [first, second] = produced;
    if (!first || !second) throw new Error('the two crossings were not produced');

    const oldKey = (refId: string | null): string =>
      runIdempotencyKeyFor({
        ruleId,
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        refId,
        bucket: 'event',
      });
    expect(oldKey(first.refId)).toBe(oldKey(second.refId));

    // THE NEW ONE DOES, because the bucket is the event's own identity.
    const newKey = (dedupeKey: string): string =>
      runIdempotencyKeyFor({
        ruleId,
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        refId: first.refId,
        bucket: dedupeKey,
      });
    expect(newKey(first.dedupeKey)).not.toBe(newKey(second.dedupeKey));
  });

  it('delivering both creates TWO runs and TWO actions', async () => {
    const produced = await events();
    const [first, second] = produced;
    if (!first || !second) throw new Error('the two crossings were not produced');

    notified.length = 0;
    expect(await deliver(first)).toBe(1);
    expect(await deliver(second)).toBe(1);

    const created = await runs();
    expect(created.length).toBe(2);
    expect(new Set(created.map((run) => run.idempotencyKey)).size).toBe(2);
    // BOTH RUNS NAME THE SAME READING. Provenance survived; identity moved off
    // it.
    expect(created.map((run) => run.triggerRefId)).toEqual([observationId, observationId]);
    expect(notified.length).toBe(2);
  }, 60_000);

  it('redelivering either event creates no second run and no second action', async () => {
    const produced = await events();
    const [first, second] = produced;
    if (!first || !second) throw new Error('the two crossings were not produced');

    const before = await runs();
    notified.length = 0;

    // A REDELIVERY IS ORDINARY. BullMQ promises at-least-once, the outbox sweep
    // re-dispatches anything it cannot see delivered, and both must converge on
    // the run that already exists.
    await deliver(first);
    await deliver(first);
    await deliver(second);

    expect(await runs()).toEqual(before);
    expect(notified.length).toBe(0);
  }, 60_000);

  it('and two deliveries of one event racing each other stay safe', async () => {
    const produced = await events();
    const [first] = produced;
    if (!first) throw new Error('the first crossing was not produced');

    const before = await runs();
    notified.length = 0;

    /*
     * THE UNIQUE CONSTRAINT IS THE DE-DUPLICATION, not the read that precedes
     * it — so two workers reaching the same event at the same instant is the
     * case that has to hold, and the fast-path read is only an optimisation.
     */
    await Promise.all([deliver(first), deliver(first), deliver(first)]);

    expect(await runs()).toEqual(before);
    expect(notified.length).toBe(0);
  }, 60_000);

  it('a third crossing of the same row is a third run', async () => {
    // The property generalises: the row never changes, and every genuine
    // re-arming still earns its own event and its own run.
    await reviseTo(10);
    await scheduler().sweepAutomations(BATCH);
    await reviseTo(500);
    await scheduler().sweepAutomations(BATCH);

    const produced = await events();
    expect(produced.length).toBe(3);
    expect(new Set(produced.map((event) => event.refId)).size).toBe(1);

    const third = produced[2];
    if (!third) throw new Error('the third crossing was not produced');
    notified.length = 0;
    expect(await deliver(third)).toBe(1);

    expect((await runs()).length).toBe(3);
    expect(notified.length).toBe(1);
  }, 180_000);
});
