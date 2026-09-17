import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import {
  AutomationEngine,
  CONDITION_FIELDS,
  CONDITION_FIELD_TRIGGERS,
  conditionFieldsFor,
  contractedFieldsFor,
  evaluateThresholdRule,
  gatherFacts,
  parseAutomationPolicy,
  type AutomationActor,
  type ConditionField,
  type MetricWindowPort,
  type ThresholdOutcome,
} from '@brandspace/automation';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 7 REMEDIATION, ROUND 3 — four residual product defects, on real
 * PostgreSQL.
 *
 * The common shape of all four is a contract stated in one place and kept in
 * another, or in none: a registry that offers more than the runtime produces, an
 * edge that is not an edge, a credential whose window belongs to a lifecycle
 * nobody closes.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

/** A metric port whose answer the test controls, reading like the real one. */
function stubMetrics(readings: { value: bigint | null; changeMilli?: number | null }[]): {
  port: MetricWindowPort;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    port: {
      async windowFor() {
        const reading = readings[Math.min(state.calls, readings.length - 1)] ?? { value: null };
        state.calls += 1;
        return { value: reading.value, changeMilli: reading.changeMilli ?? null };
      },
    },
  };
}

async function thresholdRule(config: Record<string, string | number>): Promise<string> {
  const rule = await inA((db) =>
    db.automationRule.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        name: `threshold ${randomUUID()}`,
        enabled: true,
        triggerType: 'METRIC_THRESHOLD_CROSSED',
        triggerConfig: config as never,
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.confirmation_required' },
        maxRunsPerDay: 0,
        createdByUserId: fixtures.a.userId,
      },
    }),
  );
  return rule.id;
}

/** One sweep over one rule, exactly as `MaintenanceScheduler` performs it. */
async function sweep(ruleId: string, metrics: MetricWindowPort): Promise<ThresholdOutcome> {
  return inA(async (db) => {
    const rule = await db.automationRule.findFirstOrThrow({
      where: { id: ruleId, workspaceId: fixtures.a.workspaceId },
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
      workspaceId: fixtures.a.workspaceId,
      rule,
      metrics,
      now: new Date(),
    });
  });
}

const eventsFor = (ruleId: string) =>
  inA((db) => db.automationEvent.count({ where: { workspaceId: fixtures.a.workspaceId, ruleId } }));

// ---------------------------------------------------------------------------
// R3-2 — the crossing fires once, and re-arms only on a real return
// ---------------------------------------------------------------------------

describe('R3-2: METRIC_THRESHOLD_CROSSED is a true edge across sweeps', () => {
  beforeAll(async () => {
    // The producer looks for a reading to cite as provenance. One is enough:
    // the EVENT's identity is the rule's arming cycle, not this row.
    await inA((db) =>
      db.metricObservation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          metricKey: 'followers',
          subjectType: 'ACCOUNT',
          subjectExternalId: `acct-threshold-${randomUUID().slice(0, 8)}`,
          granularity: 'DAY',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-05-02T00:00:00.000Z'),
          value: 1_000n,
          unit: 'COUNT',
          observedAt: new Date('2026-05-02T00:00:00.000Z'),
          sourceKind: 'PROVIDER',
          sourceVersion: 'threshold-probe-1',
          observationKey: `threshold-${randomUUID()}`,
        },
      }),
    );
  });

  const config = { metricKey: 'followers', direction: 'above', threshold: 100, windowDays: 7 };

  it('A→B→C→D — one event per crossing, none while it stays, re-armed on return', async () => {
    const ruleId = await thresholdRule(config);
    const metrics = stubMetrics([
      { value: 50n }, // establish: below
      { value: 150n }, // A: crossed  -> ONE event
      { value: 160n }, // B: still above, a NEWER reading -> nothing
      { value: 170n }, // B: and again -> nothing
      { value: 40n }, // C: back below -> re-armed, no event
      { value: 180n }, // D: crossed again -> exactly one more
    ]);

    expect(await sweep(ruleId, metrics.port)).toBe('established');
    expect(await eventsFor(ruleId)).toBe(0);

    expect(await sweep(ruleId, metrics.port)).toBe('fired');
    expect(await eventsFor(ruleId)).toBe(1);

    expect(await sweep(ruleId, metrics.port)).toBe('steady');
    expect(await sweep(ruleId, metrics.port)).toBe('steady');
    // THE DEFECT THIS REPLACES: a newer observation while the metric stayed
    // above produced a second event, because the dedupe key was the observation.
    expect(await eventsFor(ruleId)).toBe(1);

    expect(await sweep(ruleId, metrics.port)).toBe('rearmed');
    expect(await eventsFor(ruleId)).toBe(1);

    expect(await sweep(ruleId, metrics.port)).toBe('fired');
    expect(await eventsFor(ruleId)).toBe(2);
  });

  it('E — the same sequence for direction=below', async () => {
    const ruleId = await thresholdRule({ ...config, direction: 'below' });
    const metrics = stubMetrics([
      { value: 500n }, // establish: above the line, so NOT breaching
      { value: 50n }, // crossed downward
      { value: 40n }, // still below
      { value: 600n }, // back above -> re-armed
      { value: 10n }, // crossed downward again
    ]);

    expect(await sweep(ruleId, metrics.port)).toBe('established');
    expect(await sweep(ruleId, metrics.port)).toBe('fired');
    expect(await sweep(ruleId, metrics.port)).toBe('steady');
    expect(await sweep(ruleId, metrics.port)).toBe('rearmed');
    expect(await sweep(ruleId, metrics.port)).toBe('fired');
    expect(await eventsFor(ruleId)).toBe(2);
  });

  it('F — many sweeps with no new data produce nothing at all', async () => {
    const ruleId = await thresholdRule(config);
    const metrics = stubMetrics([{ value: 150n }]);
    expect(await sweep(ruleId, metrics.port)).toBe('established');
    for (let pass = 0; pass < 5; pass += 1) {
      expect(await sweep(ruleId, metrics.port)).toBe('steady');
    }
    expect(await eventsFor(ruleId)).toBe(0);
  });

  it('MISSING IS NEVER ZERO: an unmeasured window leaves the memory untouched', async () => {
    const ruleId = await thresholdRule({ ...config, direction: 'below' });
    const metrics = stubMetrics([{ value: null }]);
    expect(await sweep(ruleId, metrics.port)).toBe('unmeasured');
    const after = await inA((db) => db.automationRule.findFirstOrThrow({ where: { id: ruleId } }));
    // Not "false", which would have been read as "has not fallen below" and made
    // the next reading look like a crossing.
    expect(after.thresholdBreached).toBeNull();
    expect(after.thresholdCycle).toBe(0);
    expect(await eventsFor(ruleId)).toBe(0);
  });

  it('a rule created while ALREADY past the line establishes rather than fires', async () => {
    const ruleId = await thresholdRule(config);
    const metrics = stubMetrics([{ value: 5_000n }]);
    expect(await sweep(ruleId, metrics.port)).toBe('established');
    expect(await eventsFor(ruleId)).toBe(0);
    const after = await inA((db) => db.automationRule.findFirstOrThrow({ where: { id: ruleId } }));
    expect(after.thresholdBreached).toBe(true);
  });

  it('TWO SCHEDULERS RACING ONE CROSSING PRODUCE ONE EVENT', async () => {
    const ruleId = await thresholdRule(config);
    await sweep(ruleId, stubMetrics([{ value: 50n }]).port);

    /*
     * Both read the rule in the same state, both see the crossing. The
     * compare-and-swap lets one move the remembered side; the loser reports
     * `lost_race` and writes nothing, and the outbox's unique dedupe key is the
     * second guard behind it.
     */
    const both = await Promise.all([
      sweep(ruleId, stubMetrics([{ value: 150n }]).port),
      sweep(ruleId, stubMetrics([{ value: 150n }]).port),
    ]);
    expect(both.filter((outcome) => outcome === 'fired')).toHaveLength(1);
    expect(await eventsFor(ruleId)).toBe(1);
  });

  it('G/H — a redelivery of the crossing’s event maps to the original run', async () => {
    const ruleId = await thresholdRule(config);
    await sweep(ruleId, stubMetrics([{ value: 50n }]).port);
    await sweep(ruleId, stubMetrics([{ value: 150n }]).port);

    const event = await inA((db) =>
      db.automationEvent.findFirstOrThrow({
        where: { workspaceId: fixtures.a.workspaceId, ruleId },
      }),
    );

    const notified: string[] = [];
    const engine = (db: TenantScopedClient) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
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
    const actor = (): AutomationActor => ({
      userId: fixtures.a.userId,
      roleKey: 'workspace_owner',
      permissionKeys: ['workspace.read', 'automation.manage'],
      brandScope: [],
    });
    const deliver = () =>
      inA((db) =>
        engine(db).deliver({
          event: {
            type: 'METRIC_THRESHOLD_CROSSED',
            brandId: event.brandId,
            refType: event.refType,
            refId: event.refId,
            ruleId: event.ruleId,
            occurrence: event.occurrence,
            facts: {},
          },
          resolveActor: async () => actor(),
        }),
      );

    const first = await deliver();
    // HOURS OR DAYS LATER. At-least-once is what a queue promises.
    const second = await deliver();
    expect(second[0]?.run?.id).toBe(first[0]?.run?.id);
    expect(await inA((db) => db.automationRun.count({ where: { ruleId } }))).toBe(1);
    expect(notified).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R3-3 — every offered condition field has a real producer
// ---------------------------------------------------------------------------

describe('R3-3: the condition registry and the runtime agree, field by field', () => {
  it('EVERY CONDITION FIELD DECLARES AT LEAST ONE TRIGGER THAT PRODUCES IT', () => {
    for (const field of CONDITION_FIELDS) {
      expect(
        CONDITION_FIELD_TRIGGERS[field].length,
        `${field} is produced by nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('EVERY DECLARED PAIR IS ACTUALLY PRODUCED BY `gatherFacts`', async () => {
    /*
     * THE PARITY TEST, AND THE REASON IT IS MACHINE-ENFORCED.
     *
     * `metric.changeMilli` was offered to customers and produced by nothing;
     * `content.*` was offered on a trigger that reaches no content item. Both
     * were selectable, both compared false for ever, and both looked configured.
     *
     * This walks the DECLARED table against the REAL gatherer — adding a field
     * without a producer, or removing a producer without its field, fails here
     * rather than in somebody's rule six months from now.
     */
    const metrics: MetricWindowPort = {
      async windowFor() {
        return { value: 1_234n, changeMilli: 250 };
      },
    };

    const contexts: {
      trigger: Parameters<typeof contractedFieldsFor>[0];
      refType: string | null;
      refId: string | null;
      ruleId: string | null;
    }[] = [
      {
        trigger: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: fixtures.a.contentItemId,
        ruleId: null,
      },
      {
        trigger: 'CONTENT_SCHEDULED',
        refType: 'CalendarSlot',
        refId: fixtures.a.calendarSlotId,
        ruleId: null,
      },
      {
        trigger: 'POST_PUBLISHED',
        refType: 'PublishJob',
        refId: fixtures.a.publishJobId,
        ruleId: null,
      },
      {
        trigger: 'ANALYTICS_REFRESHED',
        refType: 'AnalyticsIngestionRun',
        refId: fixtures.a.analyticsRunId,
        ruleId: null,
      },
      { trigger: 'SCHEDULED_TIME', refType: null, refId: null, ruleId: null },
    ];

    const thresholdRuleId = await thresholdRule({
      metricKey: 'followers',
      direction: 'above',
      threshold: 100,
      windowDays: 7,
    });
    contexts.push({
      trigger: 'METRIC_THRESHOLD_CROSSED',
      refType: 'MetricObservation',
      refId: null,
      ruleId: thresholdRuleId,
    });

    for (const context of contexts) {
      const facts = await inA((db) =>
        gatherFacts(
          db,
          {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            triggerType: context.trigger,
            refType: context.refType,
            refId: context.refId,
            ruleId: context.ruleId,
          },
          { metrics },
        ),
      );

      for (const field of contractedFieldsFor(context.trigger)) {
        expect(facts[field], `${context.trigger} did not produce ${field}`).toBeDefined();
      }
    }
  });

  it('a field is offered for authoring only where it is produced', () => {
    // The authoring screen renders `conditionFieldsFor`, so "offered",
    // "accepted" and "produced" are one list rather than three.
    expect(conditionFieldsFor('SCHEDULED_TIME')).toEqual(['brand.id']);
    expect(conditionFieldsFor('ANALYTICS_REFRESHED')).toEqual(['brand.id']);
    expect(conditionFieldsFor('METRIC_THRESHOLD_CROSSED')).toContain('metric.changeMilli');
    expect(conditionFieldsFor('CONTENT_SCHEDULED')).toContain('content.status');
    expect(conditionFieldsFor('CONTENT_APPROVED')).not.toContain('publish.provider');
  });

  it('THE ENGINE REFUSES A CONDITION ON A FIELD ITS TRIGGER NEVER PRODUCES', async () => {
    const engine = (db: TenantScopedClient) =>
      new AutomationEngine({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: automationPolicy(),
        ports: {},
      });
    const actor: AutomationActor = {
      userId: fixtures.a.userId,
      roleKey: 'workspace_owner',
      permissionKeys: ['workspace.read', 'automation.manage'],
      brandScope: [],
    };

    // The screen no longer offers this pairing; going around the screen is
    // refused too, because a rule whose condition can never hold never fires.
    await expect(
      inA((db) =>
        engine(db).createRule({
          brandId: fixtures.a.brandId,
          name: `impossible ${randomUUID()}`,
          triggerType: 'SCHEDULED_TIME',
          triggerConfig: { hourLocal: 9, daysOfWeek: [] },
          conditions: [
            { field: 'content.status' as ConditionField, operator: 'equals', value: 'APPROVED' },
          ],
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          enabled: false,
          actor,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // The same rule with a field the trigger DOES produce is accepted.
    const created = await inA((db) =>
      engine(db).createRule({
        brandId: fixtures.a.brandId,
        name: `possible ${randomUUID()}`,
        triggerType: 'SCHEDULED_TIME',
        triggerConfig: { hourLocal: 9, daysOfWeek: [] },
        conditions: [
          { field: 'brand.id' as ConditionField, operator: 'equals', value: fixtures.a.brandId },
        ],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.confirmation_required' },
        enabled: false,
        actor,
      }),
    );
    expect(created.id).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R3-4 — the confirmation lifecycle is one coherent contract
// ---------------------------------------------------------------------------

describe('R3-4: an external proposal mints on demand and ends explicitly', () => {
  const confirmer = (): AutomationActor => ({
    userId: fixtures.a.userId,
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read', 'publishing.manage', 'automation.manage'],
    brandScope: [],
  });

  function engineAt(db: TenantScopedClient, now: Date): AutomationEngine {
    return new AutomationEngine({
      db,
      workspaceId: fixtures.a.workspaceId,
      policy: automationPolicy(),
      clock: { now: () => now },
      ports: {
        notifications: {
          notify: async () => ({ recipients: 1 }),
        },
      },
    });
  }

  async function proposal(now: Date): Promise<string> {
    const rule = await inA((db) =>
      db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `external ${randomUUID()}`,
          enabled: true,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'PROPOSE_PUBLISH',
          actionConfig: {},
          requiresConfirmationForExternal: true,
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
        },
      }),
    );
    const outcome = await inA((db) =>
      engineAt(db, now).run({
        rule,
        event: {
          type: 'CONTENT_APPROVED',
          brandId: fixtures.a.brandId,
          refType: 'ContentItem',
          refId: fixtures.a.contentItemId,
          facts: {},
        },
        resolveActor: async () => confirmer(),
      }),
    );
    expect(outcome.status).toBe('AWAITING_CONFIRMATION');
    /*
     * CONTRACT A: THE WORKER MINTS NOTHING. The run records that a person is
     * needed; no raw credential is created, so none can be dropped by the
     * background process that created it.
     */
    expect(outcome.confirmationToken).toBeNull();
    return outcome.run?.id ?? '';
  }

  it('NO CREDENTIAL EXISTS UNTIL SOMEBODY AUTHORIZED ASKS FOR ONE', async () => {
    const now = new Date();
    const runId = await proposal(now);

    const stored = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));
    expect(stored.confirmationTokenHash).toBeNull();
    expect(stored.confirmationExpiresAt).not.toBeNull();

    const issued = await inA((db) =>
      engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    expect(issued.token.length).toBeGreaterThan(16);

    const confirmed = await inA((db) =>
      engineAt(db, now).confirmRun({ runId, token: issued.token, actor: confirmer() }),
    );
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it('ISSUING DOES NOT EXTEND THE PROPOSAL’S WINDOW', async () => {
    const now = new Date();
    const runId = await proposal(now);
    const before = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));

    await inA((db) => engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() }));

    const after = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));
    // Otherwise anybody could keep a stale proposal alive for ever by asking for
    // tokens they never spend.
    expect(after.confirmationExpiresAt?.toISOString()).toBe(
      before.confirmationExpiresAt?.toISOString(),
    );
  });

  it('AFTER THE WINDOW CLOSES, NO CREDENTIAL CAN BE ISSUED', async () => {
    const now = new Date();
    const runId = await proposal(now);
    const stored = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));
    const past = new Date((stored.confirmationExpiresAt?.getTime() ?? 0) + 1_000);

    await expect(
      inA((db) => engineAt(db, past).reissueRunConfirmation({ runId, actor: confirmer() })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CONCURRENT REQUESTS LEAVE EXACTLY ONE LIVE CREDENTIAL', async () => {
    const now = new Date();
    const runId = await proposal(now);

    const [first, second] = await Promise.all([
      inA((db) => engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() })).catch(
        () => null,
      ),
      inA((db) => engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() })).catch(
        () => null,
      ),
    ]);
    const issued = [first, second].filter((result) => result !== null);
    expect(issued.length).toBeGreaterThanOrEqual(1);

    // Whichever tokens were handed out, exactly ONE can still confirm.
    let accepted = 0;
    for (const result of issued) {
      const ok = await inA((db) =>
        engineAt(db, now)
          .confirmRun({ runId, token: result?.token ?? '', actor: confirmer() })
          .then(() => true)
          .catch(() => false),
      );
      if (ok) accepted += 1;
    }
    expect(accepted).toBe(1);
  });

  it('THE OLD TOKEN IS DEAD AFTER A ROTATION', async () => {
    const now = new Date();
    const runId = await proposal(now);
    const first = await inA((db) =>
      engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    const second = await inA((db) =>
      engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() }),
    );
    expect(second.token).not.toBe(first.token);

    await expect(
      inA((db) => engineAt(db, now).confirmRun({ runId, token: first.token, actor: confirmer() })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('A CONFIRMED, CANCELLED OR EXPIRED RUN CANNOT BE RESURRECTED', async () => {
    const now = new Date();

    const confirmedRun = await proposal(now);
    const token = await inA((db) =>
      engineAt(db, now).reissueRunConfirmation({ runId: confirmedRun, actor: confirmer() }),
    );
    await inA((db) =>
      engineAt(db, now).confirmRun({ runId: confirmedRun, token: token.token, actor: confirmer() }),
    );
    await expect(
      inA((db) =>
        engineAt(db, now).reissueRunConfirmation({ runId: confirmedRun, actor: confirmer() }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    for (const status of ['CANCELLED', 'EXPIRED', 'FAILED'] as const) {
      const runId = await proposal(now);
      await inA((db) =>
        db.automationRun.updateMany({
          where: { id: runId, workspaceId: fixtures.a.workspaceId },
          data: { status, confirmationTokenHash: null },
        }),
      );
      await expect(
        inA((db) => engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() })),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('THE RAW TOKEN IS NEVER PERSISTED, in the run or in the audit trail', async () => {
    const now = new Date();
    const runId = await proposal(now);
    const issued = await inA((db) =>
      engineAt(db, now).reissueRunConfirmation({ runId, actor: confirmer() }),
    );

    const stored = await inA((db) => db.automationRun.findFirstOrThrow({ where: { id: runId } }));
    expect(JSON.stringify(stored)).not.toContain(issued.token);

    const audits = await inA((db) =>
      db.auditEvent.findMany({
        where: { workspaceId: fixtures.a.workspaceId, resourceId: runId },
      }),
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(issued.token);
  });
});
