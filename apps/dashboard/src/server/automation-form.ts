import {
  CONDITION_FIELD_CONTRACTS,
  CONDITION_OPERATORS,
  conditionFieldMissing,
  conditionFieldUnknown,
  conditionOperatorNotAllowed,
  conditionValueInvalid,
  triggerConfigInvalid,
  type AutomationCondition,
  type ConditionField,
  type ConditionOperator,
} from '@brandspace/automation';

/**
 * THE AUTOMATION FORM'S DECODER, AND WHY IT IS ITS OWN MODULE.
 *
 * It lived inside `actions.ts`, which carries `'use server'` — and a
 * `'use server'` module may only export async server actions, so nothing there
 * could be called by a test without a browser and a running application. The
 * decoding rules below are exactly the kind of thing that must be asserted
 * directly: every one of them is about what happens to a request the SCREEN
 * WOULD NEVER PRODUCE.
 *
 * THE RULE THIS FILE KEEPS (R5):
 *
 *   INVALID INPUT MUST NEVER BROADEN WHAT A RULE DOES.
 *
 * A form decoder has two ways to be wrong, and only one of them is loud. It can
 * refuse something valid, which somebody notices immediately; or it can quietly
 * turn something invalid into something valid-looking and NARROWER OR WIDER than
 * what was meant, which nobody notices at all. The second kind is what this file
 * exists to prevent:
 *
 *   - AN UNRECOGNISED CONDITION FIELD USED TO BECOME NO CONDITION. So a stale or
 *     tampered request that meant "notify me when an APPROVED post goes out"
 *     created "notify me when ANY post goes out" — a rule that fires on
 *     everything, stored and enabled, with nothing anywhere saying the condition
 *     had been dropped. Conditional to unconditional is the most dangerous
 *     direction a decoder can move a rule in, and it is the one a silent
 *     fallback takes.
 *   - `Number('')` IS `0`, AND ZERO IS A VALID ANSWER. A blank threshold became
 *     "when this metric crosses zero"; a blank hour became "at midnight"; a
 *     blank platform count became "more than zero platforms". Every one of those
 *     is a rule somebody could have written and none of them is the rule they
 *     were writing.
 *
 * WHAT IS STILL THE ENGINE'S JOB. This narrows a request into a well-formed one
 * or refuses it. It does not decide POLICY: whether a field is produced by the
 * chosen trigger, whether an operator can answer that field, whether a value is
 * of the right kind — `conditionRejection` answers all three, in the engine, on
 * create AND on update. A decoder that also enforced policy would be a second
 * copy of it, and two copies drift.
 */

/** A number the form actually carried, or `null` when it carried nothing usable. */
function finiteNumber(raw: string): number | null {
  const trimmed = raw.trim();
  /*
   * BLANK IS NOT ZERO. This early return is the whole point: `Number('')`,
   * `Number(' ')` and `Number('\n')` are all `0`, so without it a missing value
   * arrives at the engine as a perfectly valid number and is stored.
   */
  if (trimmed === '') return null;
  const value = Number(trimmed);
  // `Number.isFinite` also refuses `NaN`, `Infinity` and `-Infinity`, each of
  // which a hand-made request can carry and none of which is a quantity.
  return Number.isFinite(value) ? value : null;
}

/** A required numeric parameter, refused rather than defaulted. */
function requiredNumber(formData: FormData, name: string, triggerType: string): number {
  const entry = formData.get(name);
  if (entry === null) throw triggerConfigInvalid(triggerType, name);
  const value = finiteNumber(String(entry));
  if (value === null) throw triggerConfigInvalid(triggerType, name);
  return value;
}

/** A required text parameter, refused rather than defaulted. */
function requiredText(formData: FormData, name: string, triggerType: string): string {
  const entry = formData.get(name);
  if (entry === null) throw triggerConfigInvalid(triggerType, name);
  const value = String(entry).trim();
  if (value === '') throw triggerConfigInvalid(triggerType, name);
  return value;
}

/**
 * THE TRIGGER'S OWN CONFIGURATION, READ FROM THE FORM THE CUSTOMER FILLED IN.
 *
 * IT USED TO BE `{}` — ALWAYS (R3-1). So a scheduled rule carried no hour and a
 * threshold rule carried no metric, no direction and no number, and `createRule`
 * refused both with a validation error naming fields the screen had never
 * rendered. Two of the six authorable triggers could not, in fact, be authored.
 *
 * AND THEN IT DEFAULTED WHAT IT COULD NOT READ (R5). `?? 0` for the hour, `??
 * 'above'` for the direction, `?? Number.NaN` for a threshold that was blank
 * rather than absent — each one invents an answer the customer never gave. A
 * control the screen renders is one a real submission always carries, so a
 * missing or blank one is not a default, it is a request this product cannot
 * honour.
 *
 * A DEFAULT SURVIVES ONLY WHERE THE PRODUCT DECLARES ONE, and then it lives in
 * the registry's own schema rather than here: an untouched set of weekday
 * checkboxes genuinely means "every day", and an absent window genuinely means
 * the registry's `.default(7)`. Both are choices the product makes; neither is a
 * gap being papered over.
 *
 * THE SHAPES ARE STILL THE ENGINE'S. Parsing happens in `createRule` against the
 * registry's own Zod schema; this only reads the named inputs the form posts, so
 * there is no path from a text box to behaviour.
 */
export function triggerConfigFrom(
  formData: FormData,
  triggerType: string,
): Record<string, unknown> {
  if (triggerType === 'SCHEDULED_TIME') {
    return {
      hourLocal: requiredNumber(formData, 'hourLocal', triggerType),
      /*
       * EMPTY MEANS EVERY DAY, which is what an untouched set of checkboxes
       * means to the person who left them alone — a product default, declared
       * as `.default([])` in the registry. A checkbox that IS present and
       * unreadable is a different matter and is refused.
       */
      daysOfWeek: formData.getAll('daysOfWeek').map((day) => {
        const value = finiteNumber(String(day));
        if (value === null) throw triggerConfigInvalid(triggerType, 'daysOfWeek');
        return value;
      }),
    };
  }

  if (triggerType === 'METRIC_THRESHOLD_CROSSED') {
    const config: Record<string, unknown> = {
      metricKey: requiredText(formData, 'metricKey', triggerType),
      direction: requiredText(formData, 'direction', triggerType),
      threshold: requiredNumber(formData, 'threshold', triggerType),
    };
    /*
     * THE ONE PARAMETER WITH A REAL DEFAULT. `metricThresholdConfigSchema`
     * declares `.default(7)`, so an ABSENT window takes it — by omitting the
     * key, which keeps the number in one place rather than repeating it here. A
     * window that is PRESENT and blank is still refused: the control rendered,
     * the customer emptied it, and silently restoring seven would tell them
     * their rule measures a period they had just cleared.
     */
    if (formData.get('windowDays') !== null) {
      config['windowDays'] = requiredNumber(formData, 'windowDays', triggerType);
    }
    return config;
  }

  return {};
}

/**
 * The one optional condition the authoring screen offers.
 *
 * IT USED TO BE `[]` UNCONDITIONALLY, so the condition half of the engine was
 * unreachable from the product (R3-1). Then the VALUE was guessed — a number if
 * it parsed as one and a string otherwise — so `content.hasCampaign equals`
 * posted the STRING `"true"` against a real boolean fact and `in` posted a lone
 * string where the engine requires `string[]` (R4-1).
 *
 * AND THEN AN UNKNOWN FIELD STILL BECAME `[]` (R5), which is the same defect a
 * third time and the worst of the three: a rule the customer wrote as
 * conditional was stored UNCONDITIONAL, and an automation that fires on
 * everything is not a smaller version of one that fires on something.
 *
 * SO THE THREE OUTCOMES ARE NOW DISTINCT AND NONE OF THEM IS A GUESS:
 *
 *   `''`        the picker's own "no condition" option — an intentional choice,
 *               and the only input that yields an unconditional rule.
 *   a real field decoded against `CONDITION_FIELD_CONTRACTS`, which is the same
 *               table the screen rendered from and the engine refuses against.
 *   anything else REFUSED, so the customer is told rather than quietly given a
 *               different rule.
 */
export function conditionsFrom(formData: FormData): readonly AutomationCondition[] {
  /*
   * MISSING IS NOT EMPTY, AND ONLY EMPTY IS AN ANSWER.
   *
   * `String(formData.get(...) ?? '')` collapses the two, and they are not the
   * same request. A form the picker rendered ALWAYS carries the entry, because
   * the "no condition" option carries `value=""` — so a request with the entry
   * present and empty is a person choosing no condition, and a request with the
   * entry ABSENT is one that never went through the screen at all. Folding the
   * second into the first hands a stale, truncated or hand-made payload the
   * unconditional rule an unknown field used to get, which is this round's
   * defect surviving in the one shape still left for it.
   */
  const entry = formData.get('conditionField');
  if (entry === null) throw conditionFieldMissing();

  const name = String(entry);
  /*
   * INTENTIONALLY NO CONDITION, and EXACTLY the empty string.
   *
   * NOT TRIMMED FIRST, deliberately. Trimming would fold `'   '` into `''` and
   * hand a whitespace payload that same unconditional rule — the identical
   * defect, one character along. Anything that is not the empty string goes
   * through the contract lookup and is refused if it is not a field.
   */
  if (name === '') return [];

  /*
   * AN OWN-PROPERTY CHECK, NOT A TRUTHINESS OR `undefined` ONE.
   *
   * `CONDITION_FIELD_CONTRACTS` is an object literal, so a lookup of
   * `__proto__` returns `Object.prototype` and one of `toString` or
   * `constructor` returns a function — none of them `undefined`. A check
   * against `undefined` therefore ADMITS those three names as fields, and the
   * decoder then reads `contract.kind` off the prototype, gets `undefined`, and
   * builds a condition out of a name that is not one. `Object.hasOwn` asks the
   * question that was meant: is this a field this registry declares?
   */
  if (!Object.hasOwn(CONDITION_FIELD_CONTRACTS, name)) throw conditionFieldUnknown(name);
  const field = name as ConditionField;
  const contract = CONDITION_FIELD_CONTRACTS[field];

  const rawOperator = String(formData.get('conditionOperator') ?? '').trim();
  /*
   * NARROWED TO THE REGISTRY'S OWN LIST, and no further. Whether THIS field can
   * answer THIS operator is policy, and policy belongs to `conditionRejection`
   * in the engine — asked on create and on update, against the rule's own
   * trigger. This only refuses an operator that is not an operator at all,
   * which is what stops a malformed string reaching a typed comparison.
   */
  if (!CONDITION_OPERATORS.includes(rawOperator as ConditionOperator)) {
    throw conditionOperatorNotAllowed(field, rawOperator);
  }
  const operator = rawOperator as ConditionOperator;

  // THESE TAKE NO VALUE AT ALL, and sending one would be a rule whose text says
  // one thing and whose behaviour does another.
  if (operator === 'is_true' || operator === 'is_false') return [{ field, operator }];

  if (operator === 'in' || operator === 'not_in') {
    /*
     * A REAL `string[]`. A `<select multiple>` posts one entry per choice; a
     * free-text field (a pillar has no enum to close it against) posts one
     * entry the customer separated with commas. Both end up here as the same
     * de-duplicated list, and an EMPTY one is refused here rather than sent on
     * as a condition that is false for ever.
     */
    const members = [
      ...new Set(
        formData
          .getAll('conditionValue')
          .flatMap((entry) => String(entry).split(','))
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
      ),
    ];
    if (members.length === 0) throw conditionValueInvalid(field, operator);
    return [{ field, operator, value: members }];
  }

  const raw = String(formData.get('conditionValue') ?? '').trim();

  if (contract.kind === 'number') {
    const value = finiteNumber(raw);
    // BLANK IS NOT ZERO, and `greater_than 0` is a rule somebody could mean.
    if (value === null) throw conditionValueInvalid(field, operator);
    return [{ field, operator, value }];
  }

  // A STRING FACT HAS NO EMPTY ANSWER EITHER: nothing the gatherer produces is
  // `''`, so an empty comparison is false for ever whichever operator it wears.
  if (raw === '') throw conditionValueInvalid(field, operator);
  return [{ field, operator, value: raw }];
}
