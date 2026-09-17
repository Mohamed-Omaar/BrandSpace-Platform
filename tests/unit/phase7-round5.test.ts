import { describe, expect, it } from 'vitest';
import { isAppError } from '@brandspace/shared';
import { conditionRejection, type AutomationCondition } from '@brandspace/automation';
import { conditionsFrom, triggerConfigFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * PHASE 7 REMEDIATION, ROUND 5 — the form decoder must FAIL CLOSED.
 *
 * WHY THESE ARE UNIT TESTS AND NOT BROWSER TESTS. Every case below is a request
 * THE SCREEN WOULD NEVER PRODUCE: a field that does not exist, a required number
 * left blank, a control that never rendered. A Playwright test drives the screen,
 * so it can only ever assert that the screen behaves — it cannot assert what the
 * server does with a stale tab, a replayed submission or a hand-made POST, which
 * is the only place this defect lives. The decoder is its own module precisely so
 * these can be asserted directly.
 *
 * THE RULE: INVALID INPUT MUST NEVER BROADEN WHAT A RULE DOES. A decoder that
 * refuses something valid is noticed immediately; one that quietly turns
 * something invalid into a valid-looking rule that is WIDER than what was meant
 * is noticed by nobody.
 */

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

/** The refusal's stable code, or a description of whatever else happened. */
function refusal(decode: () => unknown): string {
  try {
    const decoded = decode();
    return `NO REFUSAL: ${JSON.stringify(decoded)}`;
  } catch (error: unknown) {
    return isAppError(error) ? error.code : `UNEXPECTED: ${String(error)}`;
  }
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe('R5: an unknown condition field is refused, never dropped', () => {
  it('an EMPTY field is intentionally no condition, and stays that way', () => {
    // The picker offers "no condition" as an option, so this is an answer.
    expect(conditionsFrom(form({ conditionField: '' }))).toEqual([]);
    expect(conditionsFrom(form({}))).toEqual([]);
  });

  it('a NON-EMPTY unknown field is refused, and never becomes []', () => {
    /*
     * THE DEFECT. `if (!contract) return []` turned a request that MEANT a
     * conditional rule into an UNCONDITIONAL one — a rule that fires on every
     * event instead of the narrow set somebody chose, stored and enabled, with
     * nothing anywhere saying the condition had been dropped.
     */
    for (const field of [
      'not.a.real.field',
      'content.STATUS',
      // WHITESPACE IS NOT "NO CONDITION". Folding it into the empty string
      // would hand a whitespace payload the same unconditional rule an unknown
      // field used to get — the identical defect, one character along.
      '   ',
      // Nor is a field name with a stray space a field.
      'brand.id ',
      '__proto__',
      'constructor',
      'toString',
      'metric.value; DROP TABLE',
    ]) {
      const decoded = refusal(() =>
        conditionsFrom(
          form({ conditionField: field, conditionOperator: 'equals', conditionValue: 'x' }),
        ),
      );
      expect({ field, decoded }).toEqual({ field, decoded: 'VALIDATION_FAILED' });
    }
  });

  it('and INHERITED object properties are not fields either', () => {
    /*
     * A CHECK AGAINST `undefined` IS NOT ENOUGH, and this test is why the
     * decoder uses `Object.hasOwn`. `CONDITION_FIELD_CONTRACTS` is an object
     * literal, so `['__proto__']` yields `Object.prototype` and `['toString']`
     * a function — neither is `undefined`, so both were admitted as fields, and
     * the decoder then read `contract.kind` off the prototype and built a
     * condition out of a name that is not one.
     */
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect({
        name,
        decoded: refusal(() =>
          conditionsFrom(
            form({ conditionField: name, conditionOperator: 'equals', conditionValue: 'x' }),
          ),
        ),
      }).toEqual({ name, decoded: 'VALIDATION_FAILED' });
    }
  });
});

describe('R5: a numeric condition value is never a coerced zero', () => {
  const numeric = (value?: string): (() => unknown) => {
    const entries: Record<string, string> = {
      conditionField: 'content.platformCount',
      conditionOperator: 'greater_than',
    };
    if (value !== undefined) entries['conditionValue'] = value;
    return () => conditionsFrom(form(entries));
  };

  it('a BLANK value is refused rather than stored as 0', () => {
    /*
     * `Number('')` IS `0`, and `content.platformCount greater_than 0` is a rule
     * somebody could legitimately mean — which is exactly why silently
     * producing it is so hard to spot.
     */
    expect(Number('')).toBe(0);
    expect(refusal(numeric(''))).toBe('VALIDATION_FAILED');
    expect(refusal(numeric('   '))).toBe('VALIDATION_FAILED');
    expect(refusal(numeric('\n\t'))).toBe('VALIDATION_FAILED');
  });

  it('a MISSING value is refused too', () => {
    expect(refusal(numeric())).toBe('VALIDATION_FAILED');
  });

  it('a NON-FINITE value is refused', () => {
    for (const value of ['abc', 'NaN', 'Infinity', '-Infinity', '1e999', '12px', '--3']) {
      expect({ value, decoded: refusal(numeric(value)) }).toEqual({
        value,
        decoded: 'VALIDATION_FAILED',
      });
    }
  });

  it('a real number still decodes, INCLUDING a deliberate zero', () => {
    // The point is not that zero is forbidden — it is that zero must be TYPED.
    expect(
      conditionsFrom(
        form({
          conditionField: 'content.platformCount',
          conditionOperator: 'greater_than',
          conditionValue: '0',
        }),
      ),
    ).toEqual([{ field: 'content.platformCount', operator: 'greater_than', value: 0 }]);

    expect(
      conditionsFrom(
        form({
          conditionField: 'metric.changeMilli',
          conditionOperator: 'less_than',
          conditionValue: '-2500',
        }),
      ),
    ).toEqual([{ field: 'metric.changeMilli', operator: 'less_than', value: -2500 }]);
  });
});

describe('R5: the remaining condition shapes are decoded or refused, never guessed', () => {
  it('an unrecognised operator is refused', () => {
    for (const operator of ['', 'EQUALS', 'matches', 'like']) {
      expect({
        operator,
        decoded: refusal(() =>
          conditionsFrom(
            form({
              conditionField: 'content.pillar',
              conditionOperator: operator,
              conditionValue: 'x',
            }),
          ),
        ),
      }).toEqual({ operator, decoded: 'VALIDATION_FAILED' });
    }
  });

  it('a blank STRING value is refused — no fact the gatherer emits is empty', () => {
    expect(
      refusal(() =>
        conditionsFrom(
          form({
            conditionField: 'content.pillar',
            conditionOperator: 'equals',
            conditionValue: '',
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('an EMPTY list is refused rather than sent on as a condition that is false for ever', () => {
    for (const value of [[], [''], [' , , '], [',']]) {
      expect({
        value,
        decoded: refusal(() =>
          conditionsFrom(
            form({
              conditionField: 'content.status',
              conditionOperator: 'in',
              conditionValue: value,
            }),
          ),
        ),
      }).toEqual({ value, decoded: 'VALIDATION_FAILED' });
    }
  });

  it('`is_true` / `is_false` take no value, and any supplied one is discarded', () => {
    expect(
      conditionsFrom(
        form({
          conditionField: 'content.hasCampaign',
          conditionOperator: 'is_true',
          conditionValue: 'whatever',
        }),
      ),
    ).toEqual([{ field: 'content.hasCampaign', operator: 'is_true' }]);
  });

  it('a multi-select and a comma-separated box produce the same real array', () => {
    const picker = conditionsFrom(
      form({
        conditionField: 'content.status',
        conditionOperator: 'in',
        conditionValue: ['APPROVED', 'SCHEDULED'],
      }),
    );
    const typed = conditionsFrom(
      form({
        conditionField: 'content.status',
        conditionOperator: 'in',
        conditionValue: [' APPROVED , SCHEDULED '],
      }),
    );
    expect(picker).toEqual([
      { field: 'content.status', operator: 'in', value: ['APPROVED', 'SCHEDULED'] },
    ]);
    expect(typed).toEqual(picker);
  });
});

// ---------------------------------------------------------------------------
// Trigger configuration
// ---------------------------------------------------------------------------

describe('R5: a required trigger parameter is never a coerced zero or an invented default', () => {
  const schedule =
    (entries: Record<string, string | readonly string[]>): (() => unknown) =>
    () =>
      triggerConfigFrom(form(entries), 'SCHEDULED_TIME');
  const threshold =
    (entries: Record<string, string>): (() => unknown) =>
    () =>
      triggerConfigFrom(form(entries), 'METRIC_THRESHOLD_CROSSED');

  const FULL_THRESHOLD = {
    metricKey: 'followers',
    direction: 'above',
    threshold: '1000',
    windowDays: '7',
  } as const;

  it('a BLANK threshold is refused rather than stored as "crosses zero"', () => {
    expect(refusal(threshold({ ...FULL_THRESHOLD, threshold: '' }))).toBe('VALIDATION_FAILED');
    expect(refusal(threshold({ ...FULL_THRESHOLD, threshold: '   ' }))).toBe('VALIDATION_FAILED');
  });

  it('a MISSING or NON-FINITE threshold is refused too', () => {
    const { threshold: _omitted, ...withoutThreshold } = FULL_THRESHOLD;
    expect(refusal(threshold(withoutThreshold))).toBe('VALIDATION_FAILED');
    for (const value of ['abc', 'NaN', 'Infinity']) {
      expect(refusal(threshold({ ...FULL_THRESHOLD, threshold: value }))).toBe('VALIDATION_FAILED');
    }
  });

  it('a blank or missing metric key and direction are refused, not defaulted to "above"', () => {
    expect(refusal(threshold({ ...FULL_THRESHOLD, metricKey: '' }))).toBe('VALIDATION_FAILED');
    expect(refusal(threshold({ ...FULL_THRESHOLD, direction: '' }))).toBe('VALIDATION_FAILED');

    const { direction: _dropped, ...withoutDirection } = FULL_THRESHOLD;
    expect(refusal(threshold(withoutDirection))).toBe('VALIDATION_FAILED');
  });

  it('an ABSENT window takes the registry default by omitting the key', () => {
    /*
     * A REAL PRODUCT DEFAULT, and the only one here. It is declared once, as
     * `.default(7)` on `metricThresholdConfigSchema`, so this decoder does not
     * repeat the number — it leaves the key out and lets the schema answer.
     */
    const { windowDays: _absent, ...withoutWindow } = FULL_THRESHOLD;
    const decoded = triggerConfigFrom(form(withoutWindow), 'METRIC_THRESHOLD_CROSSED');
    expect('windowDays' in decoded).toBe(false);
    expect(decoded).toEqual({ metricKey: 'followers', direction: 'above', threshold: 1000 });
  });

  it('but a window that is PRESENT and blank is refused rather than quietly restored', () => {
    expect(refusal(threshold({ ...FULL_THRESHOLD, windowDays: '' }))).toBe('VALIDATION_FAILED');
  });

  it('a blank or missing hour is refused rather than becoming midnight', () => {
    expect(Number('')).toBe(0);
    expect(refusal(schedule({ hourLocal: '' }))).toBe('VALIDATION_FAILED');
    expect(refusal(schedule({}))).toBe('VALIDATION_FAILED');
    expect(refusal(schedule({ hourLocal: 'nine' }))).toBe('VALIDATION_FAILED');
  });

  it('an unreadable weekday is refused, while NO weekday still means every day', () => {
    expect(refusal(schedule({ hourLocal: '9', daysOfWeek: ['1', 'monday'] }))).toBe(
      'VALIDATION_FAILED',
    );
    // The product default: an untouched set of checkboxes means every day.
    expect(triggerConfigFrom(form({ hourLocal: '9' }), 'SCHEDULED_TIME')).toEqual({
      hourLocal: 9,
      daysOfWeek: [],
    });
  });

  it('a trigger with no configuration of its own decodes to {}', () => {
    for (const trigger of ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED']) {
      expect(triggerConfigFrom(form({ hourLocal: '9' }), trigger)).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// The submissions the screen actually makes
// ---------------------------------------------------------------------------

describe('R5: an ordinary browser submission is unaffected', () => {
  it('a scheduled rule decodes its hour and its chosen days', () => {
    expect(
      triggerConfigFrom(form({ hourLocal: '9', daysOfWeek: ['1', '3', '5'] }), 'SCHEDULED_TIME'),
    ).toEqual({ hourLocal: 9, daysOfWeek: [1, 3, 5] });
  });

  it('a threshold rule decodes all four of its parameters', () => {
    expect(
      triggerConfigFrom(
        form({ metricKey: 'followers', direction: 'below', threshold: '500', windowDays: '30' }),
        'METRIC_THRESHOLD_CROSSED',
      ),
    ).toEqual({ metricKey: 'followers', direction: 'below', threshold: 500, windowDays: 30 });
  });

  it('every value kind the screen can post survives, and the ENGINE accepts it', () => {
    /*
     * DECODED AND THEN OFFERED TO THE ENGINE'S OWN VALIDATOR. The decoder
     * narrows; `conditionRejection` decides policy. A decoder that produced
     * something the engine refuses would be a screen that cannot save a rule
     * it just drew, which is the defect round 3 and round 4 each closed once.
     */
    const submissions: readonly {
      readonly entries: Record<string, string | readonly string[]>;
      readonly expected: AutomationCondition;
    }[] = [
      {
        entries: {
          conditionField: 'content.platformCount',
          conditionOperator: 'greater_than',
          conditionValue: '1',
        },
        expected: { field: 'content.platformCount', operator: 'greater_than', value: 1 },
      },
      {
        entries: { conditionField: 'content.hasCampaign', conditionOperator: 'is_true' },
        expected: { field: 'content.hasCampaign', operator: 'is_true' },
      },
      {
        entries: {
          conditionField: 'content.pillar',
          conditionOperator: 'equals',
          conditionValue: 'education',
        },
        expected: { field: 'content.pillar', operator: 'equals', value: 'education' },
      },
      {
        entries: {
          conditionField: 'content.status',
          conditionOperator: 'in',
          conditionValue: ['APPROVED', 'SCHEDULED'],
        },
        expected: {
          field: 'content.status',
          operator: 'in',
          value: ['APPROVED', 'SCHEDULED'],
        },
      },
    ];

    for (const submission of submissions) {
      const decoded = conditionsFrom(form(submission.entries));
      expect(decoded).toEqual([submission.expected]);
      expect(conditionRejection(submission.expected, 'CONTENT_APPROVED')).toBeNull();
    }
  });
});
