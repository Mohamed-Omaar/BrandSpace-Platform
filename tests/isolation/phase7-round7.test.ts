import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  recordAutomationEvent,
  recordRuleAutomationEvent,
  withWorkspace,
  type TenantScopedClient,
} from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues } from '@brandspace/jobs';
import {
  AutomationEngine,
  evaluateThresholdRule,
  parseAutomationPolicy,
  thresholdOccurrenceKey,
  type AutomationActor,
  type MetricWindowPort,
  type ThresholdOutcome,
} from '@brandspace/automation';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 7 REMEDIATION, ROUND 7 — A CLAIMED FIRE MUST NEVER COMMIT ALONE.
 *
 * THE DEFECT, AND WHY IT WAS SILENT. `evaluateThresholdRule` used to
 * compare-and-swap `thresholdBreached = true` and THEN look up the
 * `MetricObservation` it wanted to cite as provenance. A miss returned
 * `'no_observation'` — a normal return, not a throw — so the surrounding
 * `withWorkspace` transaction committed the breached state, and the scheduler's
 * park with it, WITHOUT the matching `AutomationEvent`.
 *
 * The next sweep then read a rule that was already marked breached, computed
 * `steady`, and did nothing. The crossing had been consumed: no event, no run,
 * no error, no log line, and no way to tell from the rule's own row that
 * anything had been lost. A customer's threshold simply never fired, once, for
 * ever.
 *
 * AND IT IS REACHABLE RATHER THAN THEORETICAL. Analytics retention prunes
 * `MetricObservation` rows, and `withWorkspace` is one READ COMMITTED
 * transaction rather than a repeatable-read snapshot — so a prune that commits
 * between the metric-window read and the provenance lookup is visible to the
 * lookup. The window can answer "past the line" from rows that are gone one
 * statement later.
 *
 * THE INVARIANT THIS SUITE PINS DOWN:
 *
 *   THERE IS NEVER A COMMITTED FIRE TRANSITION WITHOUT ITS `AutomationEvent`.
 *
 * It is proved the only way that means anything: by FORCING the disappearance,
 * between the window evaluation and the event creation, through the real
 * producer, in a real transaction, against real PostgreSQL. The port this suite
 * injects deletes the readings as it answers — which is exactly what the window
 * read racing a prune looks like from inside the producer.
 *
 * AND THE ROUND-6 BEHAVIOUR IS RE-PROVED FROM SCRATCH HERE, because a reorder
 * of the fire path is precisely the kind of change that could quietly break the
 * identity work it sits inside: one observation revised in place, crossing the
 * line twice, through the real `MaintenanceScheduler`.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/** F-23: the suite bootstraps everything it reads. */
let brandId: string;
/** The rule the provenance race is driven against. */
let probeRuleId: string;
/** The rule the round-6 same-row flow is driven against, by the real sweep. */
let flowRuleId: string;
/** A timed rule and a domain rule, so neither idempotency is asserted by proxy. */
let timedRuleId: string;
let domainRuleId: string;
let contentItemId: string;

const PROBE_METRIC = 'impressions';
const FLOW_METRIC = 'followers';
const THRESHOLD = 100;
/** Wide enough that this suite's rules are never queued out of reach (R4-2). */
const BATCH = 500;

const flowObservationKey = `r7-flow-${randomUUID()}`;
let probeSubjectId = '';

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ACTOR = (): AutomationActor => ({
  userId: fixtures.b.userId,
  roleKey: 'workspace_owner',
  permissionKeys: ['workspace.read', 'automation.manage'],
  brandScope: [],
});

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

// ---------------------------------------------------------------------------
// Reading the state the invariant is about
// ---------------------------------------------------------------------------

const ruleState = (ruleId: string) =>
  inB((db) =>
    db.automationRule.findFirstOrThrow({
      where: { id: ruleId, workspaceId: fixtures.b.workspaceId },
      select: { thresholdBreached: true, thresholdCycle: true },
    }),
  );

const eventsFor = (ruleId: string) =>
  inB((db) =>
    db.automationEvent.findMany({
      where: { workspaceId: fixtures.b.workspaceId, ruleId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, refId: true, refType: true, occurrence: true, dedupeKey: true },
    }),
  );

const runsFor = (ruleId: string) =>
  inB((db) =>
    db.automationRun.findMany({
      where: { workspaceId: fixtures.b.workspaceId, ruleId },
      orderBy: { startedAt: 'asc' },
      select: { id: true, idempotencyKey: true, status: true, triggerRefId: true },
    }),
  );

const observationsForProbe = () =>
  inB((db) =>
    db.metricObservation.count({
      where: { workspaceId: fixtures.b.workspaceId, brandId, metricKey: PROBE_METRIC },
    }),
  );

// ---------------------------------------------------------------------------
// The ports
// ---------------------------------------------------------------------------

/** A window that simply answers, leaving the readings where they are. */
const steadyPort = (value: number): MetricWindowPort => ({
  async windowFor() {
    return { value: BigInt(value), changeMilli: null };
  },
});

/**
 * A WINDOW THAT ANSWERS "PAST THE LINE" AND TAKES ITS EVIDENCE WITH IT.
 *
 * This is the race, reduced to something deterministic. Retention commits its
 * prune at some unpredictable moment; here it commits at the one moment that
 * matters — after the window has decided a crossing happened and before the
 * producer can look up what to cite for it. Everything the producer does from
 * that point on is the code under test.
 */
const vanishingPort = (db: TenantScopedClient, value: number): MetricWindowPort => ({
  async windowFor() {
    await db.metricObservation.deleteMany({
      where: { workspaceId: fixtures.b.workspaceId, brandId, metricKey: PROBE_METRIC },
    });
    return { value: BigInt(value), changeMilli: null };
  },
});

/** One evaluation, in its own transaction, exactly as the sweep performs it. */
async function evaluate(
  ruleId: string,
  port: (db: TenantScopedClient) => MetricWindowPort,
): Promise<ThresholdOutcome> {
  return inB(async (db) => {
    const rule = await db.automationRule.findFirstOrThrow({
      where: { id: ruleId, workspaceId: fixtures.b.workspaceId },
      select: {
        id: true,
        brandId: true,
        triggerConfig: true,
        thresholdBreached: true,
        thresholdCycle: true,
      },
    });
    return evaluateThresholdRule({
      db,
      workspaceId: fixtures.b.workspaceId,
      rule,
      metrics: port(db),
      now: new Date(),
    });
  });
}

/** Put a fresh reading back for the probe brand. */
async function seedProbeObservation(value: number): Promise<string> {
  const now = new Date();
  const row = await inB((db) =>
    db.metricObservation.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        socialConnectionId: fixtures.b.socialConnectionId,
        provider: 'LINKEDIN',
        metricKey: PROBE_METRIC,
        subjectType: 'ACCOUNT',
        subjectExternalId: probeSubjectId,
        granularity: 'DAY',
        periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        periodEnd: now,
        value: BigInt(value),
        unit: 'COUNT',
        observedAt: now,
        sourceKind: 'PROVIDER',
        sourceVersion: 'r7-probe',
        observationKey: `r7-probe-${randomUUID()}`,
      },
      select: { id: true },
    }),
  );
  return row.id;
}

/** The one flow reading, revised in place — exactly as ingestion revises it. */
async function reviseFlowTo(value: number): Promise<void> {
  const now = new Date();
  const changed = await inB((db) =>
    db.metricObservation.updateMany({
      where: { workspaceId: fixtures.b.workspaceId, observationKey: flowObservationKey },
      data: {
        value: BigInt(value),
        observedAt: now,
        periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        periodEnd: now,
      },
    }),
  );
  // THE SAME ROW. An insert here would make the test easier than the defect.
  expect(changed.count).toBe(1);
}

/** Deliver one outbox row exactly as `apps/worker` does, event key included. */
type DeliverableTrigger = 'METRIC_THRESHOLD_CROSSED' | 'SCHEDULED_TIME' | 'CONTENT_APPROVED';

async function deliver(event: {
  type: DeliverableTrigger;
  refType: string | null;
  refId: string | null;
  ruleId: string | null;
  occurrence: string | null;
  dedupeKey: string;
}): Promise<number> {
  const outcomes = await inB((db) =>
    engineOn(db).deliver({
      event: {
        type: event.type,
        brandId,
        refType: event.refType,
        refId: event.refId,
        ruleId: event.ruleId,
        occurrence: event.occurrence,
        eventKey: event.dedupeKey,
        facts: { 'brand.id': brandId },
      },
      resolveActor: async () => ACTOR(),
    }),
  );
  return outcomes.length;
}

const notifyAction = {
  actionType: 'NOTIFY' as const,
  actionConfig: { templateKey: 'automation.confirmation_required' } as never,
};

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  probeSubjectId = `r7-acct-${randomUUID().slice(0, 8)}`;

  const brand = await inB((db) =>
    db.brand.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        slug: `r7-threshold-${randomUUID().slice(0, 8)}`,
        name: 'R7 fire-without-event probe',
      },
    }),
  );
  brandId = brand.id;

  const now = new Date();
  await inB((db) =>
    db.metricObservation.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        socialConnectionId: fixtures.b.socialConnectionId,
        provider: 'LINKEDIN',
        metricKey: FLOW_METRIC,
        subjectType: 'ACCOUNT',
        subjectExternalId: `r7-flow-${randomUUID().slice(0, 8)}`,
        granularity: 'DAY',
        periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
        periodEnd: now,
        // Below the line, so the first evaluation establishes a side (D-177).
        value: 10n,
        unit: 'COUNT',
        observedAt: now,
        sourceKind: 'PROVIDER',
        sourceVersion: 'r7-flow',
        observationKey: flowObservationKey,
      },
    }),
  );

  const thresholdRule = async (metricKey: string, name: string, enabled: boolean) => {
    const rule = await inB((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.b.workspaceId,
          brandId,
          name: `${name} ${randomUUID()}`,
          enabled,
          triggerType: 'METRIC_THRESHOLD_CROSSED',
          triggerConfig: {
            metricKey,
            direction: 'above',
            threshold: THRESHOLD,
            windowDays: 7,
          } as never,
          conditions: [],
          ...notifyAction,
          maxRunsPerDay: 0,
          createdByUserId: fixtures.b.userId,
        },
        select: { id: true },
      }),
    );
    return rule.id;
  };

  /*
   * THE PROBE RULE IS NOT SWEEPABLE, and that is deliberate rather than
   * convenient. Its transitions are driven one at a time, with an injected
   * window, so that the exact instant provenance disappears is the test's to
   * choose; the real sweep running concurrently over the same rule would move
   * its state between assertions and prove nothing about the ordering.
   */
  probeRuleId = await thresholdRule(PROBE_METRIC, 'r7 provenance probe', false);
  flowRuleId = await thresholdRule(FLOW_METRIC, 'r7 same-row flow', true);

  const timed = await inB((db) =>
    db.automationRule.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        name: `r7 timed ${randomUUID()}`,
        // Not enabled, so only this suite writes its events: the scheduler's own
        // timed producer would otherwise add an occurrence for whatever hour the
        // suite happens to run in.
        enabled: false,
        triggerType: 'SCHEDULED_TIME',
        triggerConfig: { hourLocal: 9, daysOfWeek: [] } as never,
        conditions: [],
        ...notifyAction,
        maxRunsPerDay: 0,
        createdByUserId: fixtures.b.userId,
      },
      select: { id: true },
    }),
  );
  timedRuleId = timed.id;

  const domain = await inB((db) =>
    db.automationRule.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        name: `r7 domain ${randomUUID()}`,
        enabled: true,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {} as never,
        conditions: [],
        ...notifyAction,
        maxRunsPerDay: 0,
        createdByUserId: fixtures.b.userId,
      },
      select: { id: true },
    }),
  );
  domainRuleId = domain.id;

  const item = await inB((db) =>
    db.contentItem.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        brandId,
        title: `r7 approved ${randomUUID().slice(0, 8)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'APPROVED',
        createdByUserId: fixtures.b.userId,
      },
      select: { id: true },
    }),
  );
  contentItemId = item.id;
}, 120_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe('R7: a fire transition and its event commit together or not at all', () => {
  it('establishes the side below the line, and fires nothing', async () => {
    await seedProbeObservation(10);

    expect(await evaluate(probeRuleId, () => steadyPort(10))).toBe('established');
    expect(await ruleState(probeRuleId)).toEqual({ thresholdBreached: false, thresholdCycle: 0 });
    expect(await eventsFor(probeRuleId)).toEqual([]);
  });

  it('THE DEFECT: provenance vanishing mid-fire does not commit the breach', async () => {
    /*
     * The window says the metric is past the line — and the readings are gone by
     * the time the producer asks which one to cite. Before the fix this returned
     * `'no_observation'` with `thresholdBreached = true` ALREADY COMMITTED.
     */
    const outcome = await evaluate(probeRuleId, (db) => vanishingPort(db, 500));
    expect(outcome).toBe('no_observation');

    // The prune really happened: this is not a test that quietly did nothing.
    expect(await observationsForProbe()).toBe(0);

    // AND NOTHING WAS CONSUMED. The remembered side is untouched, the arming
    // cycle has not moved, and no event exists for a fire that never committed.
    expect(await ruleState(probeRuleId)).toEqual({ thresholdBreached: false, thresholdCycle: 0 });
    expect(await eventsFor(probeRuleId)).toEqual([]);
  });

  it('is still armed afterwards, so a repeat of the same race changes nothing', async () => {
    // Retryable means retryable: the second attempt is not a different attempt.
    expect(await evaluate(probeRuleId, (db) => vanishingPort(db, 500))).toBe('no_observation');
    expect(await ruleState(probeRuleId)).toEqual({ thresholdBreached: false, thresholdCycle: 0 });
    expect(await eventsFor(probeRuleId)).toEqual([]);
  });

  it('THE CROSSING SURVIVES: once a reading is back, the same crossing fires', async () => {
    /*
     * This is the assertion the defect failed. The crossing that raced a prune
     * is not lost — it is still waiting, and the next evaluation that can cite
     * something fires it.
     */
    const observationId = await seedProbeObservation(500);

    expect(await evaluate(probeRuleId, () => steadyPort(500))).toBe('fired');
    expect(await ruleState(probeRuleId)).toEqual({ thresholdBreached: true, thresholdCycle: 0 });

    const events = await eventsFor(probeRuleId);
    expect(events).toHaveLength(1);
    expect(events[0]?.refType).toBe('MetricObservation');
    expect(events[0]?.refId).toBe(observationId);
    expect(events[0]?.dedupeKey).toBe(
      `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(probeRuleId, 0)}`,
    );
  });

  it('and the breached state is never observed without its event', async () => {
    /*
     * The invariant stated directly over the rows, rather than inferred from the
     * sequence above: for THIS rule, a breached cycle has an event and an
     * unbreached one does not.
     */
    const state = await ruleState(probeRuleId);
    const events = await eventsFor(probeRuleId);
    const keyForThisCycle = `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(
      probeRuleId,
      state.thresholdCycle,
    )}`;
    expect(state.thresholdBreached).toBe(true);
    expect(events.map((event) => event.dedupeKey)).toContain(keyForThisCycle);
  });

  it('two schedulers racing one crossing still produce one winner and one event', async () => {
    // Re-arm first: back under the line advances the cycle (R3-2).
    await inB((db) =>
      db.metricObservation.updateMany({
        where: { workspaceId: fixtures.b.workspaceId, brandId, metricKey: PROBE_METRIC },
        data: { value: 5n },
      }),
    );
    expect(await evaluate(probeRuleId, () => steadyPort(5))).toBe('rearmed');
    expect(await ruleState(probeRuleId)).toEqual({ thresholdBreached: false, thresholdCycle: 1 });

    const before = (await eventsFor(probeRuleId)).length;
    const outcomes = await Promise.all([
      evaluate(probeRuleId, () => steadyPort(500)),
      evaluate(probeRuleId, () => steadyPort(500)),
      evaluate(probeRuleId, () => steadyPort(500)),
    ]);

    // Exactly one claim wins; the others either lost the compare-and-swap or
    // arrived after it and saw a steady state. Neither writes anything.
    expect(outcomes.filter((outcome) => outcome === 'fired')).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => outcome === 'fired' || outcome === 'lost_race' || outcome === 'steady',
      ),
    ).toHaveLength(3);

    const after = await eventsFor(probeRuleId);
    expect(after).toHaveLength(before + 1);
    expect(after.map((event) => event.dedupeKey)).toContain(
      `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(probeRuleId, 1)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Round 6, re-proved end to end through the real sweep
// ---------------------------------------------------------------------------

describe('R7: the round-6 same-row flow is unchanged by the reorder', () => {
  it('one observation revised in place crosses twice and produces two events', async () => {
    // 1. BELOW — the first evaluation records the side and fires nothing.
    await scheduler().sweepAutomations(BATCH);
    expect(await eventsFor(flowRuleId)).toEqual([]);

    // 2. ABOVE — a real crossing, cycle 0.
    await reviseFlowTo(500);
    await scheduler().sweepAutomations(BATCH);
    expect(await eventsFor(flowRuleId)).toHaveLength(1);

    // 3. BELOW AGAIN — the rule re-arms, and the cycle advances.
    await reviseFlowTo(5);
    await scheduler().sweepAutomations(BATCH);
    expect(await eventsFor(flowRuleId)).toHaveLength(1);

    // 4. ABOVE AGAIN — a second, genuine crossing of THE SAME ROW.
    await reviseFlowTo(900);
    await scheduler().sweepAutomations(BATCH);

    const events = await eventsFor(flowRuleId);
    expect(events).toHaveLength(2);
    // ONE REFERENCE, TWO EVENTS. The refId is provenance and is allowed to
    // repeat; the identity is the arming cycle and must not.
    expect(events[0]?.refId).toBe(events[1]?.refId);
    expect(events[0]?.dedupeKey).not.toBe(events[1]?.dedupeKey);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(flowRuleId, 0)}`,
      `METRIC_THRESHOLD_CROSSED:${thresholdOccurrenceKey(flowRuleId, 1)}`,
    ]);
  });

  it('delivering both creates TWO runs on the same reference', async () => {
    const events = await eventsFor(flowRuleId);
    expect(events).toHaveLength(2);
    const notificationsBefore = notified.length;

    for (const event of events) {
      expect(
        await deliver({
          type: 'METRIC_THRESHOLD_CROSSED',
          refType: event.refType,
          refId: event.refId,
          ruleId: flowRuleId,
          occurrence: event.occurrence,
          dedupeKey: event.dedupeKey,
        }),
      ).toBe(1);
    }

    const runs = await runsFor(flowRuleId);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.triggerRefId).toBe(runs[1]?.triggerRefId);
    expect(runs[0]?.idempotencyKey).not.toBe(runs[1]?.idempotencyKey);
    expect(runs.every((run) => run.status === 'SUCCEEDED')).toBe(true);
    // TWO ACTIONS, NOT ONE. The notification port is keyed on the run, so two
    // runs mean two notifications and a suppressed run would mean one.
    expect(notified).toHaveLength(notificationsBefore + 2);
    expect(new Set(notified.slice(notificationsBefore)).size).toBe(2);
  });

  it('redelivering either event creates no duplicate run or action', async () => {
    const events = await eventsFor(flowRuleId);
    const before = await runsFor(flowRuleId);
    const notificationsBefore = notified.length;

    for (const event of events) {
      await deliver({
        type: 'METRIC_THRESHOLD_CROSSED',
        refType: event.refType,
        refId: event.refId,
        ruleId: flowRuleId,
        occurrence: event.occurrence,
        dedupeKey: event.dedupeKey,
      });
    }

    expect(await runsFor(flowRuleId)).toEqual(before);
    expect(notified).toHaveLength(notificationsBefore);
  });

  it('racing deliveries of one event remain idempotent', async () => {
    const events = await eventsFor(flowRuleId);
    const event = events[0];
    expect(event).toBeDefined();
    const before = await runsFor(flowRuleId);
    const notificationsBefore = notified.length;

    await Promise.all(
      [0, 1, 2].map(() =>
        deliver({
          type: 'METRIC_THRESHOLD_CROSSED',
          refType: event?.refType ?? null,
          refId: event?.refId ?? null,
          ruleId: flowRuleId,
          occurrence: event?.occurrence ?? null,
          dedupeKey: event?.dedupeKey ?? '',
        }),
      ),
    );

    expect(await runsFor(flowRuleId)).toEqual(before);
    expect(notified).toHaveLength(notificationsBefore);
  });
});

// ---------------------------------------------------------------------------
// The other two producers, so neither is asserted by proxy
// ---------------------------------------------------------------------------

describe('R7: timed and domain identity are untouched', () => {
  it('a timed rule is identified by its occurrence, in the outbox and in the run', async () => {
    const occurrence = '2026-09-17T09';

    // TWO SWEEPS INSIDE ONE HOUR WRITE ONE ROW. The real producer's dedupe key.
    await inB((db) =>
      recordRuleAutomationEvent(db, fixtures.b.workspaceId, {
        triggerType: 'SCHEDULED_TIME',
        brandId,
        ruleId: timedRuleId,
        occurrence,
      }),
    );
    await inB((db) =>
      recordRuleAutomationEvent(db, fixtures.b.workspaceId, {
        triggerType: 'SCHEDULED_TIME',
        brandId,
        ruleId: timedRuleId,
        occurrence,
      }),
    );
    const events = await eventsFor(timedRuleId);
    expect(events).toHaveLength(1);
    expect(events[0]?.occurrence).toBe(occurrence);
    expect(events[0]?.refId).toBeNull();
    expect(events[0]?.dedupeKey).toBe(`SCHEDULED_TIME:${timedRuleId}:${occurrence}`);

    // The rule has to be reachable for delivery; it was created disabled only so
    // that the scheduler's own timed producer could not add another occurrence.
    await inB((db) =>
      db.automationRule.updateMany({
        where: { id: timedRuleId, workspaceId: fixtures.b.workspaceId },
        data: { enabled: true },
      }),
    );

    // AND THE RUN KEEPS THE OCCURRENCE IT WAS CREATED FOR. A delivery that slips
    // past the hour boundary must not become a second run of the same schedule.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliver({
        type: 'SCHEDULED_TIME',
        refType: null,
        refId: null,
        ruleId: timedRuleId,
        occurrence,
        dedupeKey: `SCHEDULED_TIME:${timedRuleId}:${occurrence}`,
      });
    }
    expect(await runsFor(timedRuleId)).toHaveLength(1);
  });

  it('a domain event is still identified by its reference', async () => {
    await inB((db) =>
      recordAutomationEvent(
        db,
        fixtures.b.workspaceId,
        { triggerType: 'CONTENT_APPROVED', refType: 'ContentItem' },
        { brandId, refId: contentItemId },
      ),
    );
    await inB((db) =>
      recordAutomationEvent(
        db,
        fixtures.b.workspaceId,
        { triggerType: 'CONTENT_APPROVED', refType: 'ContentItem' },
        { brandId, refId: contentItemId },
      ),
    );

    const events = await inB((db) =>
      db.automationEvent.findMany({
        where: {
          workspaceId: fixtures.b.workspaceId,
          brandId,
          triggerType: 'CONTENT_APPROVED',
        },
        select: { dedupeKey: true, refId: true, refType: true },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.dedupeKey).toBe(`CONTENT_APPROVED:${contentItemId}`);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliver({
        type: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: contentItemId,
        ruleId: null,
        occurrence: null,
        dedupeKey: `CONTENT_APPROVED:${contentItemId}`,
      });
    }
    expect(await runsFor(domainRuleId)).toHaveLength(1);
  });
});
