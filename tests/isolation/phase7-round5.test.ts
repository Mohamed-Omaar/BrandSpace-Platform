import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { defaultPayload } from '@brandspace/config';
import { isAppError } from '@brandspace/shared';
import {
  AutomationEngine,
  parseAutomationPolicy,
  type AutomationActor,
} from '@brandspace/automation';
import { conditionsFrom, triggerConfigFrom } from '../../apps/dashboard/src/server/automation-form';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';
import { seedStoredRule } from './stored-automation-rule';

/**
 * PHASE 7 REMEDIATION, ROUND 5, ON REAL POSTGRESQL.
 *
 * The unit suite proves the DECODER refuses. This proves the consequence that
 * actually matters: A REQUEST THE DECODER REFUSES LEAVES THE DATABASE EXACTLY
 * AS IT FOUND IT. No rule is created, no rule is updated, and — the defect this
 * round closes — no conditional rule is quietly stored as an unconditional one.
 *
 * IT COMPOSES THE TWO HALVES THE SERVER ACTION COMPOSES, in the same order:
 * decode the form, then hand the result to the engine. Nothing here reaches
 * around either of them.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/**
 * F-23: THE SUITE BOOTSTRAPS WHAT IT READS.
 *
 * Its own brand, in workspace B, so the per-brand rule ceiling this file works
 * under is a ceiling only this file's rules occupy — and so "the count did not
 * move" is a statement about this test rather than about whichever suites
 * happened to run before it.
 */
let brandId: string;

const automationPolicy = () => parseAutomationPolicy(defaultPayload('automations'));

const inB = <T>(fn: (db: TenantScopedClient) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

const ACTOR = (): AutomationActor => ({
  userId: fixtures.b.userId,
  roleKey: 'workspace_owner',
  // Phase 2B-3 PR 2: new rules are G13 rules; "make a draft copy" needs content.create.
  permissionKeys: ['workspace.read', 'automation.manage', 'content.create'],
  brandScope: [],
});

const engineOn = (db: TenantScopedClient): AutomationEngine =>
  new AutomationEngine({
    db,
    workspaceId: fixtures.b.workspaceId,
    policy: automationPolicy(),
    ports: {},
  });

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const member of value) data.append(key, member);
    } else {
      data.set(key, value as string);
    }
  }
  return data;
}

/**
 * Exactly what `createAutomationAction` does: decode, then create — for a rule
 * a person can write today (Phase 2B-3 PR 2: CONTENT_APPROVED × "make a draft
 * copy", a G13 rule).
 */
async function submit(
  entries: Record<string, string | readonly string[]>,
  name = `r5 ${randomUUID()}`,
): Promise<string> {
  try {
    const data = form(entries);
    const triggerConfig = triggerConfigFrom(data, 'CONTENT_APPROVED');
    const conditions = conditionsFrom(data);
    await inB((db) =>
      engineOn(db).createRule({
        brandId,
        name,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig,
        conditions: conditions as never,
        actionType: 'MAKE_DRAFT_COPY',
        actionConfig: {},
        actor: ACTOR(),
      }),
    );
    return 'OK';
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED: ${String(error)}`;
  }
}

/** A STORED rule of a pre-G13 shape — the only way one exists after the G13 flip. */
async function stored(input: {
  triggerType: 'CONTENT_APPROVED' | 'SCHEDULED_TIME' | 'METRIC_THRESHOLD_CROSSED';
  triggerConfig?: unknown;
  conditions?: unknown;
  name?: string;
}) {
  return inB((db) =>
    seedStoredRule(db, {
      workspaceId: fixtures.b.workspaceId,
      brandId,
      name: input.name ?? `r5 ${randomUUID()}`,
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig ?? {},
      conditions: input.conditions ?? [],
      actionType: 'NOTIFY',
      actionConfig: { templateKey: 'automation.notice' },
      createdByUserId: fixtures.b.userId,
    }),
  );
}

/**
 * Exactly what `updateAutomationAction` does with a stored rule's TRIGGER
 * settings: decode them for the trigger the rule really has, then edit. This is
 * the door a schedule or a threshold still arrives by (an older automation's
 * edit form).
 */
async function editTrigger(
  rule: { id: string; version: number; triggerType: string },
  entries: Record<string, string | readonly string[]>,
): Promise<string> {
  try {
    const data = form(entries);
    const triggerConfig = triggerConfigFrom(data, rule.triggerType);
    await inB((db) =>
      engineOn(db).updateEditableRule({
        ruleId: rule.id,
        expectedVersion: rule.version,
        triggerConfig,
        actor: ACTOR(),
      }),
    );
    return 'OK';
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED: ${String(error)}`;
  }
}

/** The same composition on the update path. */
async function patch(
  ruleId: string,
  entries: Record<string, string | readonly string[]>,
): Promise<string> {
  try {
    const conditions = conditionsFrom(form(entries));
    await inB((db) =>
      engineOn(db).updateRule({ ruleId, conditions: conditions as never, actor: ACTOR() }),
    );
    return 'OK';
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED: ${String(error)}`;
  }
}

const rules = () =>
  inB((db) =>
    db.automationRule.findMany({
      where: { workspaceId: fixtures.b.workspaceId, brandId, deletedAt: null },
      select: { id: true, name: true, triggerConfig: true, conditions: true },
      orderBy: { createdAt: 'asc' },
    }),
  );

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  const brand = await inB((db) =>
    db.brand.create({
      data: {
        workspaceId: fixtures.b.workspaceId,
        slug: `r5-decoder-${randomUUID().slice(0, 8)}`,
        name: 'R5 decoder probe',
      },
    }),
  );
  brandId = brand.id;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
});

// ---------------------------------------------------------------------------
// A refused decode writes nothing
// ---------------------------------------------------------------------------

describe('R5: a request the decoder refuses leaves the database untouched', () => {
  /**
   * EVERY ONE OF THESE IS A REQUEST THE SCREEN CANNOT PRODUCE — a stale tab, a
   * replayed submission, a hand-made POST. The assertion is the same for all of
   * them: `VALIDATION_FAILED`, and not one new row.
   *
   * THE TRIGGER-CONFIG CASES STILL CARRY `conditionField: ''`, so each one is
   * refused for the reason it names rather than for a second one it happens to
   * share.
   */
  const malformed: readonly {
    readonly why: string;
    /** CONTENT_APPROVED goes through the create door; the others edit a stored rule. */
    readonly triggerType: 'CONTENT_APPROVED' | 'SCHEDULED_TIME' | 'METRIC_THRESHOLD_CROSSED';
    readonly entries: Record<string, string | readonly string[]>;
  }[] = [
    {
      why: 'no condition field at all — absent is not a choice',
      triggerType: 'CONTENT_APPROVED',
      entries: { conditionOperator: 'equals', conditionValue: 'APPROVED' },
    },
    {
      why: 'a request carrying nothing whatsoever',
      triggerType: 'CONTENT_APPROVED',
      entries: {},
    },
    {
      why: 'a condition field that does not exist',
      triggerType: 'CONTENT_APPROVED',
      entries: {
        conditionField: 'not.a.real.field',
        conditionOperator: 'equals',
        conditionValue: 'APPROVED',
      },
    },
    {
      why: 'a condition field of whitespace',
      triggerType: 'CONTENT_APPROVED',
      entries: { conditionField: '   ', conditionOperator: 'equals', conditionValue: 'x' },
    },
    {
      why: 'a condition field inherited from Object.prototype',
      triggerType: 'CONTENT_APPROVED',
      entries: { conditionField: '__proto__', conditionOperator: 'equals', conditionValue: 'x' },
    },
    {
      why: 'a numeric condition value left blank',
      triggerType: 'CONTENT_APPROVED',
      entries: {
        conditionField: 'content.platformCount',
        conditionOperator: 'greater_than',
        conditionValue: '',
      },
    },
    {
      why: 'a numeric condition value that is not a number',
      triggerType: 'CONTENT_APPROVED',
      entries: {
        conditionField: 'content.platformCount',
        conditionOperator: 'greater_than',
        conditionValue: 'Infinity',
      },
    },
    {
      why: 'an empty membership list',
      triggerType: 'CONTENT_APPROVED',
      entries: { conditionField: 'content.type', conditionOperator: 'in', conditionValue: '' },
    },
    {
      why: 'a threshold left blank',
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      entries: {
        conditionField: '',
        metricKey: 'followers',
        direction: 'above',
        threshold: '',
        windowDays: '7',
      },
    },
    {
      why: 'a window that is present and blank',
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      entries: {
        conditionField: '',
        metricKey: 'followers',
        direction: 'above',
        threshold: '100',
        windowDays: '',
      },
    },
    {
      why: 'a metric key left blank',
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      entries: {
        conditionField: '',
        metricKey: '',
        direction: 'above',
        threshold: '100',
        windowDays: '7',
      },
    },
    {
      why: 'an hour the form never carried',
      triggerType: 'SCHEDULED_TIME',
      entries: { conditionField: '' },
    },
    {
      why: 'an hour left blank',
      triggerType: 'SCHEDULED_TIME',
      entries: { conditionField: '', hourLocal: '' },
    },
    {
      why: 'a weekday that is not a day',
      triggerType: 'SCHEDULED_TIME',
      entries: { conditionField: '', hourLocal: '9', daysOfWeek: ['1', 'monday'] },
    },
  ];

  it('refuses every malformed payload — nothing is created, and nothing is widened', async () => {
    /*
     * A LEGITIMATE CONDITIONAL RULE FIRST, so the invariant at the end has
     * something to be true OF. "No rule on this brand is unconditional" over an
     * empty table is vacuous, and a vacuous assertion is worse than none: it
     * passes against the defect as happily as against the fix.
     */
    const anchor = `r5 anchor ${randomUUID()}`;
    expect(
      await submit(
        {
          conditionField: 'content.type',
          conditionOperator: 'in',
          conditionValue: ['POST'],
        },
        anchor,
      ),
    ).toBe('OK');
    // Stored rules whose trigger settings the other cases try to edit.
    const timed = await stored({
      triggerType: 'SCHEDULED_TIME',
      triggerConfig: { hourLocal: 9, daysOfWeek: [] },
      conditions: [{ field: 'brand.id', operator: 'equals', value: brandId }],
    });
    const threshold = await stored({
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      triggerConfig: { metricKey: 'followers', direction: 'above', threshold: 100 },
      conditions: [{ field: 'metric.value', operator: 'greater_than', value: 0 }],
    });

    const before = await rules();
    expect(before.length).toBe(3);
    expect(before.find((rule) => rule.name === anchor)?.conditions).toEqual([
      { field: 'content.type', operator: 'in', value: ['POST'] },
    ]);

    for (const testCase of malformed) {
      const outcome =
        testCase.triggerType === 'CONTENT_APPROVED'
          ? await submit(testCase.entries)
          : await editTrigger(
              testCase.triggerType === 'SCHEDULED_TIME' ? timed : threshold,
              testCase.entries,
            );
      expect({ why: testCase.why, outcome }).toEqual({
        why: testCase.why,
        outcome: 'VALIDATION_FAILED',
      });
    }

    // NOTHING WAS CREATED, AND NO STORED RULE MOVED. A refusal that still
    // wrote a row would be the same defect wearing an error message.
    const after = await rules();
    expect(after).toEqual(before);

    /*
     * AND NOTHING IS UNCONDITIONAL. This is the defect stated as an invariant
     * rather than as a count: `if (!contract) return []` and `?? ''` both
     * turned a request that meant "…when the status is APPROVED" into "…on
     * every approval", and both would have left a row here with an empty
     * condition list nobody asked for.
     */
    for (const rule of after) {
      expect({ name: rule.name, conditions: rule.conditions }).not.toEqual({
        name: rule.name,
        conditions: [],
      });
    }
  }, 90_000);
});

// ---------------------------------------------------------------------------
// The submissions the screen actually makes still work
// ---------------------------------------------------------------------------

describe('R5: an ordinary submission still creates exactly the rule it describes', () => {
  it('a scheduled rule stores the hour and days the customer chose', async () => {
    const name = `r5 scheduled ${randomUUID()}`;
    const rule = await stored({
      triggerType: 'SCHEDULED_TIME',
      triggerConfig: { hourLocal: 7, daysOfWeek: [] },
      name,
    });
    expect(
      await editTrigger(
        rule,
        // THE PICKER ALWAYS RENDERS, so a real submission always carries it.
        { conditionField: '', hourLocal: '9', daysOfWeek: ['1', '3'] },
      ),
    ).toBe('OK');

    const after = (await rules()).find((row) => row.name === name);
    expect(after?.triggerConfig).toEqual({ hourLocal: 9, daysOfWeek: [1, 3] });
  });

  it('a threshold rule with no window takes the registry default of seven', async () => {
    /*
     * THE ONE REAL DEFAULT. The decoder omits the key rather than repeating the
     * number, so this asserts the registry's `.default(7)` is what actually
     * lands — which is the only way the default stays in one place.
     */
    const name = `r5 threshold ${randomUUID()}`;
    const rule = await stored({
      triggerType: 'METRIC_THRESHOLD_CROSSED',
      triggerConfig: { metricKey: 'followers', direction: 'above', threshold: 100, windowDays: 30 },
      name,
    });
    expect(
      await editTrigger(rule, {
        conditionField: '',
        metricKey: 'followers',
        direction: 'below',
        threshold: '500',
      }),
    ).toBe('OK');

    const after = (await rules()).find((row) => row.name === name);
    expect(after?.triggerConfig).toEqual({
      metricKey: 'followers',
      direction: 'below',
      threshold: 500,
      windowDays: 7,
    });
  });

  it('a deliberate zero is stored as a zero', async () => {
    // Zero was never forbidden — it just has to be TYPED rather than inferred
    // from a blank box.
    // A number field is a stored rule's (Phase 2B-3 PR 2), so the zero is
    // typed into the edit of one.
    const name = `r5 zero ${randomUUID()}`;
    const rule = await stored({ triggerType: 'CONTENT_APPROVED', name });
    expect(
      await patch(rule.id, {
        conditionField: 'content.platformCount',
        conditionOperator: 'greater_than',
        conditionValue: '0',
      }),
    ).toBe('OK');

    const after = (await rules()).find((row) => row.name === name);
    expect(after?.conditions).toEqual([
      { field: 'content.platformCount', operator: 'greater_than', value: 0 },
    ]);
  });

  it('an empty picker is an intentional choice, and stores an unconditional rule', async () => {
    const name = `r5 unconditional ${randomUUID()}`;
    expect(await submit({ conditionField: '' }, name)).toBe('OK');

    const after = (await rules()).find((rule) => rule.name === name);
    expect(after?.conditions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The update path
// ---------------------------------------------------------------------------

describe('R5: a refused decode cannot widen a rule that already exists', () => {
  it('a malformed condition edit leaves the stored condition exactly as it was', async () => {
    /*
     * WHY THIS IS TESTED THOUGH NO SCREEN CALLS IT YET. `updateRule` accepts
     * conditions, and the dashboard's own toggle action already reaches it; the
     * moment an edit control exists it will compose these two halves in this
     * order. The defect being guarded against is not "the decoder is wrong", it
     * is "a refusal still moved the row" — and that has to be false before the
     * caller exists, not after.
     */
    const name = `r5 editable ${randomUUID()}`;
    await stored({
      triggerType: 'CONTENT_APPROVED',
      conditions: [{ field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] }],
      name,
    });

    const created = (await rules()).find((rule) => rule.name === name);
    if (!created) throw new Error('the rule was not created');
    const original = created.conditions;
    expect(original).toEqual([
      { field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] },
    ]);

    for (const entries of [
      { conditionField: 'not.a.real.field', conditionOperator: 'equals', conditionValue: 'x' },
      { conditionField: '__proto__', conditionOperator: 'equals', conditionValue: 'x' },
      {
        conditionField: 'content.platformCount',
        conditionOperator: 'greater_than',
        conditionValue: '',
      },
      { conditionField: 'content.status', conditionOperator: 'in', conditionValue: '' },
      { conditionField: 'content.pillar', conditionOperator: 'nope', conditionValue: 'x' },
    ]) {
      expect(await patch(created.id, entries)).toBe('VALIDATION_FAILED');

      // NOT WIDENED, NOT EMPTIED, NOT TOUCHED.
      const after = (await rules()).find((rule) => rule.id === created.id);
      expect(after?.conditions).toEqual(original);
    }
  }, 60_000);

  it('and an intentional empty picker CAN still clear a condition through the same path', async () => {
    // The distinction the whole round rests on: `''` is an answer, and it is
    // the only input that may make a rule unconditional.
    const name = `r5 clearable ${randomUUID()}`;
    await stored({
      triggerType: 'CONTENT_APPROVED',
      conditions: [{ field: 'content.pillar', operator: 'equals', value: 'education' }],
      name,
    });

    const created = (await rules()).find((rule) => rule.name === name);
    if (!created) throw new Error('the rule was not created');

    expect(await patch(created.id, { conditionField: '' })).toBe('OK');
    const after = (await rules()).find((rule) => rule.id === created.id);
    expect(after?.conditions).toEqual([]);
  }, 60_000);
});
