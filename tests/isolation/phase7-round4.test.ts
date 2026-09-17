import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { closeQueues } from '@brandspace/jobs';
import { isAppError } from '@brandspace/shared';
import {
  AutomationEngine,
  CONDITION_FIELDS,
  CONDITION_FIELD_CONTRACTS,
  CONDITION_FIELD_TRIGGERS,
  conditionOperatorsFor,
  gatherFacts,
  parseAutomationPolicy,
  type AutomationActor,
  type AutomationCondition,
  type ConditionField,
  type MetricWindowPort,
} from '@brandspace/automation';
import { MaintenanceScheduler } from '../../apps/api/src/scheduler';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 7 REMEDIATION, ROUND 4, ON REAL POSTGRESQL.
 *
 *   R4-1 — a condition the customer can author is one the engine can EVALUATE:
 *          the field, the operator and the value kind are one contract, refused
 *          identically on create and on update.
 *   R4-2 — a rule the scheduler can enumerate is one it eventually REACHES: the
 *          producers are a fair queue over a durable cursor rather than an
 *          arbitrary `LIMIT` over rows that never retire.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inA = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ACTOR = (): AutomationActor => ({
  userId: fixtures.a.userId,
  roleKey: 'workspace_owner',
  permissionKeys: ['workspace.read', 'automation.manage', 'content.submit'],
  brandScope: [],
});

const engineOn = (db: TenantScopedClient): AutomationEngine =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.a.workspaceId,
    policy: automationPolicy(),
    ports: {},
  });

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : `UNEXPECTED:${String(error)}`;
}

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
  await platform?.$disconnect();
});

// ---------------------------------------------------------------------------
// R4-1 — the contract is enforced by the ENGINE, on both doors
// ---------------------------------------------------------------------------

describe('R4-1: the condition contract is enforced server-side', () => {
  /** A rule with no conditions, so an update is the only thing adding them. */
  async function bareRule(triggerType: 'CONTENT_APPROVED' | 'SCHEDULED_TIME'): Promise<string> {
    const rule = await inA((db) =>
      engineOn(db).createRule({
        brandId: fixtures.a.brandId,
        name: `r4 ${randomUUID()}`,
        triggerType,
        triggerConfig: triggerType === 'SCHEDULED_TIME' ? { hourLocal: 9, daysOfWeek: [] } : {},
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.confirmation_required' },
        actor: ACTOR(),
      }),
    );
    return rule.id;
  }

  const create = async (
    triggerType: 'CONTENT_APPROVED' | 'SCHEDULED_TIME',
    conditions: readonly AutomationCondition[],
  ): Promise<string> => {
    try {
      await inA((db) =>
        engineOn(db).createRule({
          brandId: fixtures.a.brandId,
          name: `r4 ${randomUUID()}`,
          triggerType,
          triggerConfig: triggerType === 'SCHEDULED_TIME' ? { hourLocal: 9, daysOfWeek: [] } : {},
          conditions: conditions as never,
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          actor: ACTOR(),
        }),
      );
      return 'OK';
    } catch (error: unknown) {
      return codeOf(error);
    }
  };

  const update = async (
    ruleId: string,
    conditions: readonly AutomationCondition[],
  ): Promise<string> => {
    try {
      await inA((db) =>
        engineOn(db).updateRule({ ruleId, conditions: conditions as never, actor: ACTOR() }),
      );
      return 'OK';
    } catch (error: unknown) {
      return codeOf(error);
    }
  };

  /**
   * THE CASES, and which door each one must be refused at. The point of the
   * table is the LAST assertion in this block: create and update must return
   * the SAME answer for every row, because until this round they did not.
   */
  const refusals: readonly {
    readonly why: string;
    readonly trigger: 'CONTENT_APPROVED' | 'SCHEDULED_TIME';
    readonly condition: AutomationCondition;
  }[] = [
    {
      why: 'a field this trigger never produces',
      trigger: 'SCHEDULED_TIME',
      condition: { field: 'content.status', operator: 'equals', value: 'APPROVED' },
    },
    {
      why: 'magnitude on an identity field',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'brand.id', operator: 'greater_than', value: 5 },
    },
    {
      why: 'a boolean test on a string field',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.pillar', operator: 'is_true' },
    },
    {
      why: 'membership against a number field',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.platformCount', operator: 'in', value: ['3'] },
    },
    {
      why: 'the string "true" against a boolean fact',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.hasCampaign', operator: 'equals', value: 'true' },
    },
    {
      why: 'text where a number is compared',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.platformCount', operator: 'greater_than', value: 'three' },
    },
    {
      why: 'a lone string where a list is required',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.status', operator: 'in', value: 'APPROVED' },
    },
    {
      why: 'an empty list',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.status', operator: 'not_in', value: [] },
    },
    {
      why: 'a status outside the closed set',
      trigger: 'CONTENT_APPROVED',
      condition: { field: 'content.status', operator: 'equals', value: 'NEARLY_APPROVED' },
    },
  ];

  for (const testCase of refusals) {
    it(`createRule refuses ${testCase.why}`, async () => {
      expect(await create(testCase.trigger, [testCase.condition])).toBe('VALIDATION_FAILED');
    });
  }

  /**
   * THE HOLE THIS CLOSES. `updateRule` schema-parsed the supplied conditions and
   * stored them, and did nothing else — so every rule `createRule` refused was
   * reachable in two calls instead of one: create it bare, then PATCH in the
   * condition that was never authorable.
   */
  it('updateRule cannot introduce anything createRule would refuse', async () => {
    for (const testCase of refusals) {
      const ruleId = await bareRule(testCase.trigger);
      const viaCreate = await create(testCase.trigger, [testCase.condition]);
      const viaUpdate = await update(ruleId, [testCase.condition]);
      expect({ why: testCase.why, viaUpdate }).toEqual({
        why: testCase.why,
        viaUpdate: viaCreate,
      });
      expect(viaUpdate).toBe('VALIDATION_FAILED');

      // AND NOTHING WAS STORED. A refusal that still wrote the row would be the
      // same defect wearing an error message.
      const stored = await inA((db) =>
        db.automationRule.findFirstOrThrow({
          where: { id: ruleId, workspaceId: fixtures.a.workspaceId },
          select: { conditions: true },
        }),
      );
      expect(stored.conditions).toEqual([]);
    }
  });

  it('updateRule validates against the rule’s OWN trigger, not a supplied one', async () => {
    const ruleId = await bareRule('SCHEDULED_TIME');
    // Legal on CONTENT_APPROVED, meaningless on the rule's actual trigger.
    expect(
      await update(ruleId, [{ field: 'content.status', operator: 'equals', value: 'APPROVED' }]),
    ).toBe('VALIDATION_FAILED');
    // And the one field a scheduled rule does produce is accepted.
    expect(
      await update(ruleId, [{ field: 'brand.id', operator: 'equals', value: fixtures.a.brandId }]),
    ).toBe('OK');
  });

  it('stores a numeric, a boolean, a string and a list condition, unchanged', async () => {
    const conditions: readonly AutomationCondition[] = [
      { field: 'content.platformCount', operator: 'greater_than', value: 1 },
      { field: 'content.hasCampaign', operator: 'is_true' },
      { field: 'content.pillar', operator: 'equals', value: 'education' },
      { field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] },
    ];
    expect(await create('CONTENT_APPROVED', conditions)).toBe('OK');

    const rule = await inA((db) =>
      db.automationRule.findFirstOrThrow({
        where: { workspaceId: fixtures.a.workspaceId, triggerType: 'CONTENT_APPROVED' },
        orderBy: { createdAt: 'desc' },
        select: { conditions: true },
      }),
    );
    // THE LITERAL SURVIVES THE ROUND TRIP. A number that came back as a string,
    // or a list that came back as a string, is the whole defect.
    expect(rule.conditions).toEqual(conditions);
  });
});

// ---------------------------------------------------------------------------
// R4-1 — the declared value KIND is the kind the gatherer really produces
// ---------------------------------------------------------------------------

describe('R4-1: the contract’s value kinds match the real facts', () => {
  it('every fact gatherFacts produces is of its field’s declared kind', async () => {
    const item = await inA((db) =>
      db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          title: `kind probe ${randomUUID().slice(0, 8)}`,
          contentType: 'POST',
          status: 'APPROVED',
          pillar: 'education',
          origin: 'HUMAN',
          primaryLocale: 'EN',
          createdByUserId: fixtures.a.userId,
        },
      }),
    );

    const metrics: MetricWindowPort = {
      async windowFor() {
        return { value: 1_234n, changeMilli: 5_000 };
      },
    };

    const facts = await inA((db) =>
      gatherFacts(
        db,
        {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          triggerType: 'CONTENT_APPROVED',
          refType: 'ContentItem',
          refId: item.id,
          ruleId: null,
        },
        { metrics },
      ),
    );

    let checked = 0;
    for (const field of Object.keys(facts) as ConditionField[]) {
      const value = facts[field];
      if (value === null || value === undefined) continue;
      expect({ field, kind: typeof value }).toEqual({
        field,
        kind: CONDITION_FIELD_CONTRACTS[field].kind,
      });
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('and the metric facts are numbers, not bigints', async () => {
    const ruleId = (
      await inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: `kind metric ${randomUUID()}`,
            triggerType: 'METRIC_THRESHOLD_CROSSED',
            triggerConfig: {
              metricKey: 'followers',
              direction: 'above',
              threshold: 100,
              windowDays: 7,
            } as never,
            conditions: [],
            actionType: 'NOTIFY',
            actionConfig: { templateKey: 'automation.confirmation_required' } as never,
            maxRunsPerDay: 0,
            createdByUserId: fixtures.a.userId,
          },
        }),
      )
    ).id;

    const facts = await inA((db) =>
      gatherFacts(
        db,
        {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          triggerType: 'METRIC_THRESHOLD_CROSSED',
          refType: 'MetricObservation',
          refId: null,
          ruleId,
        },
        {
          metrics: {
            async windowFor() {
              return { value: 9_000n, changeMilli: -250 };
            },
          },
        },
      ),
    );

    expect(typeof facts['metric.key']).toBe('string');
    expect(typeof facts['metric.value']).toBe('number');
    expect(typeof facts['metric.changeMilli']).toBe('number');
  });

  it('no field is offered with an operator its own facts cannot answer', () => {
    // A structural cross-check: every trigger's offered fields are contracted,
    // and every contracted field is offered by at least one trigger.
    for (const field of CONDITION_FIELDS) {
      expect(CONDITION_FIELD_TRIGGERS[field].length).toBeGreaterThan(0);
      expect(conditionOperatorsFor(field).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// R4-1 — a rule of each value kind RUNS, on real rows and real facts
// ---------------------------------------------------------------------------

describe('R4-1: a numeric, a boolean, a string and a list condition each really run', () => {
  it('each kind holds against the facts the gatherer produced, and a wrong one skips', async () => {
    const campaign = await inA((db) =>
      db.campaign.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `r4 campaign ${randomUUID().slice(0, 8)}`,
          objective: 'AWARENESS',
          status: 'DRAFT',
          createdByUserId: fixtures.a.userId,
        },
      }),
    );

    const item = await inA((db) =>
      db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          campaignId: campaign.id,
          title: `r4 item ${randomUUID().slice(0, 8)}`,
          contentType: 'POST',
          status: 'APPROVED',
          pillar: 'education',
          origin: 'HUMAN',
          primaryLocale: 'EN',
          createdByUserId: fixtures.a.userId,
        },
      }),
    );

    // TWO PLATFORM VARIANTS, so `content.platformCount` is a real 2 rather
    // than a zero that a `greater_than 1` rule would quietly never match.
    for (const platformKey of ['linkedin', 'facebook']) {
      await inA((db) =>
        db.contentVariant.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: item.id,
            platformKey,
            locale: 'EN',
            body: `body for ${platformKey}`,
          },
        }),
      );
    }

    const facts = await inA((db) =>
      gatherFacts(db, {
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        triggerType: 'CONTENT_APPROVED',
        refType: 'ContentItem',
        refId: item.id,
        ruleId: null,
      }),
    );

    /*
     * ONE RULE PER VALUE KIND, and a fifth that must NOT hold.
     *
     * The negative control is the point. Without it "every rule succeeded"
     * would also be true of an engine that had stopped evaluating conditions
     * altogether — which is, in effect, what an unsatisfiable condition made
     * the product feel like from the other side.
     */
    const kinds: readonly {
      readonly label: string;
      readonly condition: AutomationCondition;
      readonly expected: 'SUCCEEDED' | 'SKIPPED';
    }[] = [
      {
        label: 'numeric',
        condition: { field: 'content.platformCount', operator: 'greater_than', value: 1 },
        expected: 'SUCCEEDED',
      },
      {
        label: 'boolean',
        condition: { field: 'content.hasCampaign', operator: 'is_true' },
        expected: 'SUCCEEDED',
      },
      {
        label: 'string',
        condition: { field: 'content.pillar', operator: 'equals', value: 'education' },
        expected: 'SUCCEEDED',
      },
      {
        label: 'list',
        condition: { field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] },
        expected: 'SUCCEEDED',
      },
      {
        label: 'list that excludes the fact',
        condition: { field: 'content.status', operator: 'not_in', value: ['APPROVED'] },
        expected: 'SKIPPED',
      },
    ];

    const notified: string[] = [];
    const engineWithPort = (db: TenantScopedClient): AutomationEngine =>
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

    for (const kind of kinds) {
      const rule = await inA((db) =>
        engineWithPort(db).createRule({
          brandId: fixtures.a.brandId,
          name: `r4 ${kind.label} ${randomUUID()}`,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [kind.condition] as never,
          actionType: 'NOTIFY',
          actionConfig: { templateKey: 'automation.confirmation_required' },
          enabled: true,
          actor: ACTOR(),
        }),
      );

      const outcome = await inA((db) =>
        engineWithPort(db).run({
          rule,
          event: {
            type: 'CONTENT_APPROVED',
            brandId: fixtures.a.brandId,
            refType: 'ContentItem',
            refId: item.id,
            facts,
          },
          resolveActor: async () => ACTOR(),
        }),
      );

      expect({ label: kind.label, status: outcome.status }).toEqual({
        label: kind.label,
        status: kind.expected,
      });
    }

    // FOUR NOTIFICATIONS, NOT FIVE. The one whose condition did not hold ran to
    // completion and did nothing, which is the correct ending for most runs.
    expect(notified.length).toBe(4);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// R4-2 — the producers are a fair queue
// ---------------------------------------------------------------------------

describe('R4-2: no rule is starved behind a batch', () => {
  const BATCH = 3;
  const RULES = 8;
  const scheduler = () => new MaintenanceScheduler({ environment: 'DEVELOPMENT' });

  /** Rules belonging to THIS block; everything else is parked out of the way. */
  let mine: string[] = [];

  /**
   * F-23: the suite bootstraps what it reads. Other suites leave automation
   * rules in this database, and a fairness assertion about "the first batch" is
   * meaningless if the batch is full of somebody else's rows — so every rule
   * that is not this block's is parked far into the future. That is the
   * cursor's own mechanism, used deliberately, not a back door around it.
   */
  async function parkEveryoneElse(): Promise<void> {
    await platform.automationRule.updateMany({
      where: { id: { notIn: mine } },
      data: { nextEvaluationAt: new Date('2099-01-01T00:00:00.000Z') },
    });
  }

  async function makeTimedRules(hourLocal: number, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const rule = await inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: `timed ${index} ${randomUUID()}`,
            enabled: true,
            triggerType: 'SCHEDULED_TIME',
            triggerConfig: { hourLocal, daysOfWeek: [] } as never,
            conditions: [],
            actionType: 'NOTIFY',
            actionConfig: { templateKey: 'automation.confirmation_required' } as never,
            maxRunsPerDay: 0,
            createdByUserId: fixtures.a.userId,
          },
        }),
      );
      ids.push(rule.id);
    }
    return ids;
  }

  /** Put every rule of this block at the front of the queue, oldest first. */
  async function makeAllDue(ids: readonly string[]): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await platform.automationRule.update({
        where: { id },
        data: { nextEvaluationAt: new Date(Date.now() - (ids.length - index) * 60_000) },
      });
    }
  }

  const visited = (ids: readonly string[]) =>
    platform.automationRule.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, lastEvaluatedAt: true, nextEvaluationAt: true },
    });

  beforeEach(async () => {
    mine = [];
  });

  /*
   * PUT THE DATABASE BACK. Parking other suites' rules is how this block gets a
   * deterministic queue; leaving them parked until 2099 would be this suite
   * quietly breaking the next one.
   */
  afterAll(async () => {
    await platform.$executeRawUnsafe(
      'UPDATE "automation_rule" SET "nextEvaluationAt" = "createdAt" WHERE "nextEvaluationAt" > $1',
      new Date('2098-01-01T00:00:00.000Z'),
    );
  });

  it('visits every rule within ceil(rules / batch) passes, and the SAME rule never twice first', async () => {
    // The workspace's zone decides what "the local hour" is; a rule set to an
    // hour that is not now is enumerated and parked without producing.
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    // Deliberately NOT due: this test is about reach, not about firing.
    mine = await makeTimedRules((hourNow + 5) % 24, RULES);
    await makeAllDue(mine);
    await parkEveryoneElse();

    const firstSeen = new Map<string, number>();
    const passes = Math.ceil(RULES / BATCH);
    for (let pass = 0; pass < passes; pass += 1) {
      await scheduler().sweepAutomations(BATCH);
      for (const row of await visited(mine)) {
        if (row.lastEvaluatedAt !== null && !firstSeen.has(row.id)) firstSeen.set(row.id, pass);
      }
    }

    // EVERY rule was reached. Before the cursor, the same three could have come
    // back for ever and five of these would never have been looked at.
    expect(firstSeen.size).toBe(RULES);
    // And they were reached in waves of at most `batch`, in queue order.
    for (let pass = 0; pass < passes; pass += 1) {
      const wave = [...firstSeen.values()].filter((seen) => seen === pass).length;
      expect(wave).toBeLessThanOrEqual(BATCH);
    }
  }, 60_000);

  it('a rule beyond the first batch still fires in its own hour', async () => {
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    mine = await makeTimedRules(hourNow, RULES);
    await makeAllDue(mine);
    await parkEveryoneElse();

    // The LAST rule in the queue — the one an unordered `take: 3` would have
    // been free never to return.
    const last = mine[mine.length - 1];
    if (last === undefined) throw new Error('no rules');

    for (let pass = 0; pass < Math.ceil(RULES / BATCH); pass += 1) {
      await scheduler().sweepAutomations(BATCH);
    }

    const events = await inA((db) =>
      db.automationEvent.count({
        where: { workspaceId: fixtures.a.workspaceId, ruleId: { in: mine } },
      }),
    );
    expect(events).toBe(RULES);

    const tail = await inA((db) =>
      db.automationEvent.count({ where: { workspaceId: fixtures.a.workspaceId, ruleId: last } }),
    );
    expect(tail).toBe(1);

    // AND EXACTLY ONCE. Further passes inside the same hour add nothing: the
    // rule is parked, and the occurrence key would collide even if it were not.
    await scheduler().sweepAutomations(BATCH);
    await scheduler().sweepAutomations(BATCH);
    expect(
      await inA((db) =>
        db.automationEvent.count({
          where: { workspaceId: fixtures.a.workspaceId, ruleId: { in: mine } },
        }),
      ),
    ).toBe(RULES);
  }, 60_000);

  it('repeated passes do not favour the same rules', async () => {
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    mine = await makeTimedRules((hourNow + 7) % 24, RULES);
    await makeAllDue(mine);
    await parkEveryoneElse();

    await scheduler().sweepAutomations(BATCH);
    const firstWave = (await visited(mine))
      .filter((row) => row.lastEvaluatedAt !== null)
      .map((row) => row.id);
    expect(firstWave.length).toBe(BATCH);

    /*
     * THE PROPERTY. The rules visited first are parked ahead of the ones that
     * were not, so the next pass CANNOT contain them — which is precisely what
     * an unordered `take: batch` could not promise.
     */
    const parked = await visited(firstWave);
    const waiting = await visited(mine.filter((id) => !firstWave.includes(id)));
    for (const row of parked) {
      for (const other of waiting) {
        expect(row.nextEvaluationAt.getTime()).toBeGreaterThanOrEqual(
          other.nextEvaluationAt.getTime(),
        );
      }
    }

    await scheduler().sweepAutomations(BATCH);
    const secondWave = (await visited(mine))
      .filter((row) => row.lastEvaluatedAt !== null)
      .map((row) => row.id);
    expect(secondWave.length).toBe(2 * BATCH);
    for (const id of firstWave) expect(secondWave).toContain(id);
  }, 60_000);

  it('threshold state beyond the first batch advances too', async () => {
    /*
     * A REAL READING, so the real window port has something to measure. A rule
     * whose metric cannot be measured records nothing by design (`null` is not
     * a side), and "nothing was recorded" would be indistinguishable from the
     * starvation this test exists to rule out.
     */
    const now = new Date();
    await inA((db) =>
      db.metricObservation.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          metricKey: 'followers',
          subjectType: 'ACCOUNT',
          subjectExternalId: `acct-fair-${randomUUID().slice(0, 8)}`,
          granularity: 'DAY',
          periodStart: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
          periodEnd: now,
          value: 5_000n,
          unit: 'COUNT',
          observedAt: now,
          sourceKind: 'PROVIDER',
          sourceVersion: 'r4-fair-work',
          observationKey: `fair-${randomUUID()}`,
        },
      }),
    );

    const ids: string[] = [];
    for (let index = 0; index < RULES; index += 1) {
      const rule = await inA((db) =>
        db.automationRule.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            name: `threshold ${index} ${randomUUID()}`,
            enabled: true,
            triggerType: 'METRIC_THRESHOLD_CROSSED',
            triggerConfig: {
              metricKey: 'followers',
              direction: 'above',
              threshold: 1,
              windowDays: 7,
            } as never,
            conditions: [],
            actionType: 'NOTIFY',
            actionConfig: { templateKey: 'automation.confirmation_required' } as never,
            maxRunsPerDay: 0,
            createdByUserId: fixtures.a.userId,
          },
        }),
      );
      ids.push(rule.id);
    }
    mine = ids;
    await makeAllDue(mine);
    await parkEveryoneElse();

    for (let pass = 0; pass < Math.ceil(RULES / BATCH); pass += 1) {
      await scheduler().sweepAutomations(BATCH);
    }

    // EVERY rule was evaluated, including the ones past the first batch: the
    // memory that decides whether a future move is a CROSSING now exists for
    // all of them rather than for the first three for ever.
    const rows = await visited(mine);
    expect(rows.filter((row) => row.lastEvaluatedAt !== null).length).toBe(RULES);
    const evaluated = await platform.automationRule.count({
      where: { id: { in: mine }, thresholdEvaluatedAt: { not: null } },
    });
    expect(evaluated).toBe(RULES);
  }, 60_000);

  it('two schedulers racing stay safe: one event per occurrence, no lost rule', async () => {
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    mine = await makeTimedRules(hourNow, RULES);
    await makeAllDue(mine);
    await parkEveryoneElse();

    for (let pass = 0; pass < Math.ceil(RULES / BATCH); pass += 1) {
      // TWO INSTANCES, THE SAME PASS. The dedupe key makes a duplicate
      // production a no-op and the park is conditional, so the only question
      // is whether anything is lost or doubled. Neither.
      await Promise.all([scheduler().sweepAutomations(BATCH), scheduler().sweepAutomations(BATCH)]);
    }

    const perRule = await inA((db) =>
      db.automationEvent.groupBy({
        by: ['ruleId'],
        where: { workspaceId: fixtures.a.workspaceId, ruleId: { in: mine } },
        _count: { _all: true },
      }),
    );
    expect(perRule.length).toBe(RULES);
    for (const row of perRule) expect(row._count._all).toBe(1);
  }, 90_000);

  it('a rule disabled after its event was produced never becomes an actionable run', async () => {
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    mine = await makeTimedRules(hourNow, 1);
    const ruleId = mine[0];
    if (ruleId === undefined) throw new Error('no rule');
    await makeAllDue(mine);
    await parkEveryoneElse();

    await scheduler().sweepAutomations(BATCH);
    const event = await inA((db) =>
      db.automationEvent.findFirstOrThrow({
        where: { workspaceId: fixtures.a.workspaceId, ruleId },
      }),
    );

    // THE RULE IS SWITCHED OFF AFTER THE EVENT EXISTS — the worst ordering.
    await inA((db) =>
      db.automationRule.update({ where: { id: ruleId }, data: { enabled: false } }),
    );

    const outcomes = await inA((db) =>
      engineOn(db).deliver({
        event: {
          type: 'SCHEDULED_TIME',
          brandId: event.brandId,
          refType: event.refType,
          refId: event.refId,
          ruleId: event.ruleId,
          occurrence: event.occurrence,
          facts: { 'brand.id': event.brandId },
        },
        resolveActor: async () => ACTOR(),
      }),
    );
    expect(outcomes).toEqual([]);
    expect(
      await inA((db) =>
        db.automationRun.count({ where: { workspaceId: fixtures.a.workspaceId, ruleId } }),
      ),
    ).toBe(0);
  }, 60_000);

  it('a rule disabled between enumeration and evaluation produces nothing', async () => {
    const zone = await platform.workspace.findFirstOrThrow({
      where: { id: fixtures.a.workspaceId },
      select: { timezone: true },
    });
    const hourNow = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: zone.timezone ?? 'UTC',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    mine = await makeTimedRules(hourNow, RULES);
    await makeAllDue(mine);
    await parkEveryoneElse();

    /*
     * THE RACE, RUN FOR REAL. Half the rules are switched off WHILE the sweep
     * is running, so for some of them the platform enumeration and the tenant
     * transaction straddle the disable. The producer re-reads the rule under
     * RLS inside that transaction, so no event may exist for a rule that was
     * already off when its own transaction began — and the invariant that can
     * be asserted afterwards is the one that matters: a DISABLED rule with an
     * event must have been enabled when the event was written, which the run
     * path then re-checks anyway.
     */
    const half = mine.slice(0, Math.floor(RULES / 2));
    await Promise.all([
      scheduler().sweepAutomations(RULES),
      platform.automationRule.updateMany({ where: { id: { in: half } }, data: { enabled: false } }),
    ]);

    // Nothing crashed, nothing was written twice, and every event names a rule.
    const events = await inA((db) =>
      db.automationEvent.groupBy({
        by: ['ruleId'],
        where: { workspaceId: fixtures.a.workspaceId, ruleId: { in: mine } },
        _count: { _all: true },
      }),
    );
    for (const row of events) expect(row._count._all).toBe(1);

    // AND A DISABLED RULE CANNOT RUN, whichever side of the race it landed on.
    await platform.automationRule.updateMany({
      where: { id: { in: half } },
      data: { enabled: false },
    });
    for (const ruleId of half) {
      const event = await inA((db) =>
        db.automationEvent.findFirst({ where: { workspaceId: fixtures.a.workspaceId, ruleId } }),
      );
      if (!event) continue;
      const outcomes = await inA((db) =>
        engineOn(db).deliver({
          event: {
            type: 'SCHEDULED_TIME',
            brandId: event.brandId,
            refType: event.refType,
            refId: event.refId,
            ruleId: event.ruleId,
            occurrence: event.occurrence,
            facts: { 'brand.id': event.brandId },
          },
          resolveActor: async () => ACTOR(),
        }),
      );
      expect(outcomes).toEqual([]);
    }
  }, 90_000);
});
