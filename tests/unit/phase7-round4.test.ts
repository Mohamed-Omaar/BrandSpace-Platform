import { describe, expect, it } from 'vitest';
import type { AUTOMATION_TRIGGERS } from '@brandspace/automation';
import {
  CONDITION_FIELDS,
  CONDITION_FIELD_CONTRACTS,
  CONDITION_FIELD_TRIGGERS,
  CONDITION_OPERATORS,
  conditionFieldsFor,
  conditionOperatorsFor,
  conditionRejection,
  conditionSchema,
  evaluateCondition,
  nextTimedEvaluationAt,
  localMomentFor,
  timedRuleIsDue,
  type AutomationCondition,
  type ConditionField,
  type ConditionOperator,
} from '@brandspace/automation';

/**
 * PHASE 7 REMEDIATION, ROUND 4 — the condition value contract, and the
 * fair-work cursor's arithmetic.
 *
 * WHAT THESE TESTS ARE FOR. Both defects were the same shape: something the
 * product OFFERED and the runtime could never honour. A condition the customer
 * could author and that could never evaluate true; a rule the scheduler could
 * enumerate and never actually reach. Neither failed loudly, and that is what
 * made them expensive.
 */

// ---------------------------------------------------------------------------
// R4-1 — every authorable field/operator pair is SATISFIABLE
// ---------------------------------------------------------------------------

/** A fact of this field's declared kind, and a second, different one. */
function factPair(field: ConditionField): readonly [unknown, unknown] {
  const contract = CONDITION_FIELD_CONTRACTS[field];
  if (contract.kind === 'boolean') return [true, false];
  if (contract.kind === 'number') return [2, 1];
  if (contract.options !== null) {
    const [first, second] = contract.options;
    return [first, second];
  }
  return ['first-value', 'second-value'];
}

/**
 * A condition that SHOULD evaluate true for `fact`, for this field and operator.
 *
 * The point of building it here rather than listing expectations is that the
 * test cannot silently agree with a contract that has drifted: if an operator
 * appears whose value kind nothing here can construct, the walk fails.
 */
function satisfyingCondition(
  field: ConditionField,
  operator: ConditionOperator,
): { readonly condition: AutomationCondition; readonly fact: unknown } {
  const [match, other] = factPair(field);

  switch (operator) {
    case 'is_true':
      return { condition: { field, operator }, fact: true };
    case 'is_false':
      return { condition: { field, operator }, fact: false };
    case 'equals':
      return { condition: { field, operator, value: match as never }, fact: match };
    case 'not_equals':
      return { condition: { field, operator, value: other as never }, fact: match };
    case 'greater_than':
      return { condition: { field, operator, value: 1 }, fact: 2 };
    case 'less_than':
      return { condition: { field, operator, value: 2 }, fact: 1 };
    case 'in':
      return { condition: { field, operator, value: [match as string] }, fact: match };
    case 'not_in':
      return { condition: { field, operator, value: [other as string] }, fact: match };
  }
}

describe('R4-1: the condition contract is closed, and every pair it offers works', () => {
  it('declares a contract for every field, and for nothing else', () => {
    expect(Object.keys(CONDITION_FIELD_CONTRACTS).sort()).toEqual([...CONDITION_FIELDS].sort());
  });

  it('offers only operators the registry declares', () => {
    for (const field of CONDITION_FIELDS) {
      for (const operator of conditionOperatorsFor(field)) {
        expect(CONDITION_OPERATORS).toContain(operator);
      }
      expect(conditionOperatorsFor(field).length).toBeGreaterThan(0);
    }
  });

  /**
   * THE WALK. Every field, every operator the contract offers, on every trigger
   * that produces the field: a value the schema accepts, the engine's validator
   * accepts, and `evaluateCondition` returns TRUE for.
   *
   * This is the assertion the product was missing. An operator that parses and
   * can never be satisfied is a control the customer can set and the platform
   * silently ignores.
   */
  it('every authorable field/operator/trigger combination is satisfiable', () => {
    let walked = 0;
    for (const field of CONDITION_FIELDS) {
      for (const operator of conditionOperatorsFor(field)) {
        const { condition, fact } = satisfyingCondition(field, operator);

        // The literal survives the schema unchanged — no coercion in between.
        expect(conditionSchema.parse(condition)).toEqual(condition);

        for (const trigger of CONDITION_FIELD_TRIGGERS[field]) {
          expect(conditionRejection(condition, trigger)).toBeNull();
          walked += 1;
        }

        expect(evaluateCondition(condition, { [field]: fact })).toBe(true);
      }
    }
    // A guard against a refactor that quietly empties the tables.
    expect(walked).toBeGreaterThan(40);
  });

  it('refuses every operator a field does NOT declare', () => {
    for (const field of CONDITION_FIELDS) {
      const allowed = new Set<string>(conditionOperatorsFor(field));
      const trigger = CONDITION_FIELD_TRIGGERS[field][0];
      if (trigger === undefined) throw new Error(`${field} has no trigger`);

      for (const operator of CONDITION_OPERATORS) {
        if (allowed.has(operator)) continue;
        // Built as if it were legal: a plausible value of the right shape.
        const { condition } = satisfyingCondition(field, operator);
        expect(conditionRejection(condition, trigger)).toBe('operator');
      }
    }
  });

  it('refuses a field the trigger does not produce, before looking at anything else', () => {
    const produced = new Set(conditionFieldsFor('SCHEDULED_TIME'));
    for (const field of CONDITION_FIELDS) {
      if (produced.has(field)) continue;
      const operator = conditionOperatorsFor(field)[0];
      if (operator === undefined) throw new Error(`${field} has no operator`);
      const { condition } = satisfyingCondition(field, operator);
      expect(conditionRejection(condition, 'SCHEDULED_TIME')).toBe('field');
    }
  });
});

describe('R4-1: a value of the wrong kind is refused', () => {
  const cases: readonly {
    readonly why: string;
    readonly condition: AutomationCondition;
    readonly trigger: (typeof AUTOMATION_TRIGGERS)[number]['type'];
    readonly reason: 'operator' | 'value';
    /**
     * A few of these WOULD evaluate true for some fact, and are refused for a
     * different reason: the rule's text would say something it does not do, or
     * a closed set would silently accept a member that can never appear.
     * Flagged rather than hidden, so the second assertion below stays honest.
     */
    readonly stillMatches?: true;
  }[] = [
    {
      why: 'text where a number is compared',
      condition: { field: 'content.platformCount', operator: 'greater_than', value: 'three' },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      why: 'a number where a string is compared',
      condition: { field: 'content.pillar', operator: 'equals', value: 4 },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      // The strongest outcome available: a boolean field does not offer
      // `equals` AT ALL, so the pair is refused before its value is looked at.
      why: 'the string "true" against a boolean fact',
      condition: { field: 'content.hasCampaign', operator: 'equals', value: 'true' },
      trigger: 'CONTENT_APPROVED',
      reason: 'operator',
    },
    {
      why: 'a lone string where a list is required',
      condition: { field: 'content.status', operator: 'in', value: 'APPROVED' },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      why: 'an empty list, which is false for ever',
      condition: { field: 'content.status', operator: 'in', value: [] },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      why: 'a member that is not in the closed set',
      condition: { field: 'content.status', operator: 'in', value: ['APPROVED', 'NOT_A_STATUS'] },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
      stillMatches: true,
    },
    {
      why: 'a status that does not exist',
      condition: { field: 'content.status', operator: 'equals', value: 'NEARLY_APPROVED' },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      why: 'an empty string, which no fact equals',
      condition: { field: 'content.pillar', operator: 'equals', value: '' },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
    },
    {
      why: 'no value at all where one is compared',
      condition: { field: 'metric.value', operator: 'greater_than' },
      trigger: 'METRIC_THRESHOLD_CROSSED',
      reason: 'value',
    },
    {
      why: 'a value beside an operator that takes none',
      condition: { field: 'content.hasCampaign', operator: 'is_true', value: true },
      trigger: 'CONTENT_APPROVED',
      reason: 'value',
      stillMatches: true,
    },
    {
      why: 'NaN, which compares false against everything',
      condition: { field: 'metric.value', operator: 'greater_than', value: Number.NaN },
      trigger: 'METRIC_THRESHOLD_CROSSED',
      reason: 'value',
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.why}`, () => {
      expect(conditionRejection(testCase.condition, testCase.trigger)).toBe(testCase.reason);
    });
  }

  it('and all but the flagged ones were inert — false against a matching fact', () => {
    const facts = {
      'content.platformCount': 3,
      'content.pillar': 'education',
      'content.hasCampaign': true,
      'content.status': 'APPROVED',
      'metric.value': 500,
    };
    let inert = 0;
    for (const testCase of cases) {
      if (testCase.stillMatches) continue;
      expect(evaluateCondition(testCase.condition, facts)).toBe(false);
      inert += 1;
    }
    expect(inert).toBe(cases.length - 2);
  });
});

// ---------------------------------------------------------------------------
// R4-2 — the fair-work cursor's arithmetic
// ---------------------------------------------------------------------------

describe('R4-2: nextTimedEvaluationAt parks early, and never past the cap', () => {
  const now = new Date('2026-09-17T09:05:00.000Z');
  const moment = localMomentFor(now, 'UTC');
  const hour = 3_600 * 1_000;

  const park = (config: unknown, maxAheadSeconds = 24 * 3_600): number =>
    nextTimedEvaluationAt({ config, moment, now, maxAheadSeconds }).getTime() - now.getTime();

  it('parks a rule that has just fired forward, not backward', () => {
    // 09:00 daily, and it is 09:05 — the next occurrence is ~24h away.
    expect(park({ hourLocal: 9, daysOfWeek: [] })).toBeGreaterThan(20 * hour);
  });

  it('wakes half an hour before the next occurrence, never after it', () => {
    // 11:00 daily at 09:05 — just under two hours out, less the safety bias.
    const ahead = park({ hourLocal: 11, daysOfWeek: [] });
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThan(2 * hour);
    // The occurrence starts at 11:00, which is 1h55m away.
    expect(ahead).toBeLessThan(115 * 60 * 1_000);
  });

  it('never parks past the cap, whatever the arithmetic says', () => {
    for (let hourLocal = 0; hourLocal < 24; hourLocal += 1) {
      expect(park({ hourLocal, daysOfWeek: [] }, 3_600)).toBeLessThanOrEqual(hour);
      expect(park({ hourLocal, daysOfWeek: [0, 3] }, 3_600)).toBeLessThanOrEqual(hour);
    }
  });

  it('never parks into the past', () => {
    for (let hourLocal = 0; hourLocal < 24; hourLocal += 1) {
      for (const days of [[], [0], [1, 2, 3], [0, 1, 2, 3, 4, 5, 6]]) {
        expect(park({ hourLocal, daysOfWeek: days })).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('parks a rule whose configuration will not parse, so it cannot hold the queue', () => {
    expect(park({ hourLocal: 'nine' }, 3_600)).toBe(hour);
    expect(park(null, 3_600)).toBe(hour);
    // And it is never due, so parking it costs nothing.
    expect(timedRuleIsDue({ config: { hourLocal: 'nine' }, moment }).due).toBe(false);
  });

  it('honours the weekday set the same way the due test does', () => {
    // 2026-09-17 is a Thursday (day 4). A Monday-only rule at the same hour is
    // four days out; the cap is what keeps the park short.
    const ahead = park({ hourLocal: 9, daysOfWeek: [1] }, 30 * 24 * 3_600);
    expect(ahead).toBeGreaterThan(3 * 24 * hour);
    expect(ahead).toBeLessThan(5 * 24 * hour);
  });

  it('a rule woken at its park is still inside its occurrence window', () => {
    // Walk every hour of a week: park from here, then check the rule is due
    // within the hour that follows the park.
    for (let offset = 0; offset < 24 * 7; offset += 1) {
      const instant = new Date(now.getTime() + offset * hour);
      const here = localMomentFor(instant, 'UTC');
      const config = { hourLocal: 14, daysOfWeek: [2, 5] };
      const at = nextTimedEvaluationAt({
        config,
        moment: here,
        now: instant,
        maxAheadSeconds: 7 * 24 * 3_600,
      });
      if (at.getTime() - instant.getTime() >= 7 * 24 * hour) continue;
      // Woken at `at`, or at any point in the hour after it, the rule is due at
      // some sample inside that hour — the park never overshoots the window.
      const woke = localMomentFor(new Date(at.getTime() + 31 * 60 * 1_000), 'UTC');
      const dueSoon =
        timedRuleIsDue({ config, moment: localMomentFor(at, 'UTC') }).due ||
        timedRuleIsDue({ config, moment: woke }).due ||
        at.getTime() - instant.getTime() < hour;
      expect(dueSoon).toBe(true);
    }
  });
});
