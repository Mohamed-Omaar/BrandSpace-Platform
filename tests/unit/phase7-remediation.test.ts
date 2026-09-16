import { describe, expect, it } from 'vitest';
import {
  brandIdQueryFilter,
  brandQueryFilter,
  brandScopeFilter,
  nullableBrandIdScopeFilter,
} from '@brandspace/shared';
import {
  aggregationFor,
  buildEvidencePackage,
  isLevelMetric,
  validateGroundedDocument,
  validateGrounding,
  type MetricValue,
} from '@brandspace/analytics';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  actionSupportsTrigger,
  findAction,
  findTrigger,
  runBucketFor,
  runIdempotencyKeyFor,
} from '@brandspace/automation';

/**
 * PHASE 7 REMEDIATION — the pure half.
 *
 * WHAT THIS FILE IS. An independent review of the Phase 7 pull request found ten
 * blocking defects. Six of them have a decidable core that needs no database:
 * how a scope predicate composes, which bucket a run key carries, whether a
 * trigger and an action can reach each other, what "latest" means for a level
 * metric, and which numbers a claim is allowed to contain. Those are here.
 *
 * EVERY TEST BELOW FAILS AGAINST THE CODE AS IT WAS. That is the bar for a
 * regression test, and it is worth saying explicitly because several of the
 * defects had passing tests over them — the automation de-duplication suite went
 * green while a redelivery an hour later ran the rule twice, because the test
 * computed the key exactly the way the defect did.
 */

// ---------------------------------------------------------------------------
// P7-R1 — the scope predicate composes by INTERSECTION, never by replacement
// ---------------------------------------------------------------------------

describe('P7-R1: a brand admission predicate intersects, it does not replace', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('THE DEFECT: spreading brandScopeFilter beside an id REPLACES the id', () => {
    /*
     * This is not a test of our code; it is a test of the JavaScript that made
     * the wrong composition look right, kept here so the reason the helper
     * exists cannot be forgotten. Both fragments set `id`, and the LATER one
     * wins — so an admission check for brand A, by a member scoped to A and B,
     * silently became "any brand in {A, B}".
     */
    const wrong = { id: A, ...brandScopeFilter([A, B]) };
    expect(wrong.id).toEqual({ in: [A, B] });
    expect(wrong.id).not.toBe(A);
  });

  it('brandQueryFilter keeps BOTH clauses, so the brand and the scope must agree', () => {
    expect(brandQueryFilter({ brandId: A, brandScope: [A, B] })).toEqual({
      AND: [{ id: A }, { id: { in: [A, B] } }],
    });
  });

  it('an out-of-scope brand yields a predicate that can match nothing', () => {
    const filter = brandQueryFilter({ brandId: B, brandScope: [A] });
    expect(filter.AND).toEqual([{ id: B }, { id: { in: [A] } }]);
    // `id = B AND id IN (A)` is unsatisfiable, which is the masked-empty refusal
    // CLAUDE.md §2.1 asks for: the caller cannot tell B from a brand that never
    // existed.
  });

  it('an EMPTY scope is UNRESTRICTED, and contributes no clause', () => {
    expect(brandQueryFilter({ brandId: A, brandScope: [] })).toEqual({ AND: [{ id: A }] });
    expect(brandQueryFilter({ brandScope: [] })).toEqual({ AND: [] });
  });

  it('a NULLABLE brand reference keeps the brand-less rows a restricted member owns', () => {
    /*
     * A Copilot session may have no brand. `brandIdScopeFilter` would exclude
     * every general conversation from a restricted member, which is not a
     * security property — it is a broken product. The rule is "no brand, or a
     * brand in scope".
     */
    expect(nullableBrandIdScopeFilter([A])).toEqual({
      OR: [{ brandId: null }, { brandId: { in: [A] } }],
    });
    expect(nullableBrandIdScopeFilter([])).toEqual({});
    expect(nullableBrandIdScopeFilter(null)).toEqual({});
  });

  it('the child-row helper and the brand-table helper agree on the semantics', () => {
    // Same table of answers, different column. A reader checking one has checked
    // both.
    expect(brandIdQueryFilter({ brandId: A, brandScope: [A, B] })).toEqual({
      AND: [{ brandId: A }, { brandId: { in: [A, B] } }],
    });
  });
});

// ---------------------------------------------------------------------------
// P7-R5 — only a TIMED trigger carries a clock
// ---------------------------------------------------------------------------

describe('P7-R5: an event-driven run key does not expire', () => {
  const base = {
    ruleId: '33333333-3333-4333-8333-333333333333',
    refId: '44444444-4444-4444-8444-444444444444',
  } as const;

  const keyAt = (
    triggerType: Parameters<typeof runBucketFor>[0]['triggerType'],
    localDate: string,
  ) =>
    runIdempotencyKeyFor({
      ...base,
      triggerType,
      bucket: runBucketFor({ triggerType, localDate, hourLocal: 9 }),
    });

  it('THE DEFECT: a redelivery on a LATER DAY is the same run for every event trigger', () => {
    /*
     * The old bucket was `now.toISOString().slice(0, 13)` — the wall-clock hour —
     * for EVERY trigger. A BullMQ redelivery after a worker restart, a backoff,
     * or a queue drained after an incident hashed to a different key, so the
     * unique constraint that exists to make redelivery safe never saw a
     * duplicate and the rule ran again. For PROPOSE_PUBLISH that is a second
     * confirmation request for a post already awaiting one.
     */
    for (const trigger of AUTOMATION_TRIGGERS) {
      if (trigger.timeBucketed) continue;
      expect(keyAt(trigger.type, '2026-09-16'), `${trigger.type} must converge across days`).toBe(
        keyAt(trigger.type, '2027-04-02'),
      );
    }
  });

  it('the bucket for an event trigger contains no date at all', () => {
    expect(
      runBucketFor({ triggerType: 'POST_PUBLISHED', localDate: '2026-09-16', hourLocal: 9 }),
    ).toBe('event');
  });

  it('SCHEDULED_TIME is the ONLY trigger that buckets by the clock', () => {
    const timed = AUTOMATION_TRIGGERS.filter((trigger) => trigger.timeBucketed);
    expect(timed.map((trigger) => trigger.type)).toEqual(['SCHEDULED_TIME']);
  });

  it('a timed bucket is the CONFIGURED occurrence, not the sweep instant', () => {
    /*
     * Two sweeps of the same scheduled occurrence — one that ran at 09:04 and a
     * delayed delivery that arrived at 10:58 — are ONE run, because the bucket
     * is the rule's own `hourLocal` on that local date rather than whatever hour
     * the sweep happened to land in.
     */
    const occurrence = runBucketFor({
      triggerType: 'SCHEDULED_TIME',
      localDate: '2026-09-16',
      hourLocal: 9,
    });
    expect(occurrence).toBe('2026-09-16T09');
    // The NEXT day's occurrence is a different run, which is what a daily rule
    // means.
    expect(
      runBucketFor({ triggerType: 'SCHEDULED_TIME', localDate: '2026-09-17', hourLocal: 9 }),
    ).not.toBe(occurrence);
    // And a rule configured for a different hour is a different occurrence.
    expect(
      runBucketFor({ triggerType: 'SCHEDULED_TIME', localDate: '2026-09-16', hourLocal: 17 }),
    ).not.toBe(occurrence);
  });

  it('a nonsense hour is clamped rather than producing a key nothing collides with', () => {
    expect(
      runBucketFor({ triggerType: 'SCHEDULED_TIME', localDate: '2026-09-16', hourLocal: 99 }),
    ).toBe('2026-09-16T23');
    expect(
      runBucketFor({
        triggerType: 'SCHEDULED_TIME',
        localDate: '2026-09-16',
        hourLocal: Number.NaN,
      }),
    ).toBe('2026-09-16T00');
  });

  it('two different rules on one event still produce different keys', () => {
    // The de-duplication is per RULE. Two rules listening to the same publish
    // must both run.
    expect(keyAt('POST_PUBLISHED', '2026-09-16')).not.toBe(
      runIdempotencyKeyFor({
        ruleId: '55555555-5555-4555-8555-555555555555',
        refId: base.refId,
        triggerType: 'POST_PUBLISHED',
        bucket: 'event',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Trigger / action compatibility — an action cannot be aimed at the wrong id
// ---------------------------------------------------------------------------

describe('an action that needs a content item may only be paired with a trigger that has one', () => {
  it('every content action is refused against every reference-less trigger', () => {
    const contentActions = AUTOMATION_ACTIONS.filter((action) => action.needsContentItem);
    // A guard against the registry quietly losing the flag.
    expect(contentActions.map((action) => action.type)).toEqual([
      'SUBMIT_FOR_APPROVAL',
      'PLACE_ON_CALENDAR',
      'PROPOSE_PUBLISH',
    ]);

    for (const action of contentActions) {
      for (const trigger of AUTOMATION_TRIGGERS) {
        expect(
          actionSupportsTrigger(action.type, trigger.type),
          `${action.type} × ${trigger.type}`,
        ).toBe(trigger.contentItemVia !== null);
      }
    }
  });

  it('the four triggers whose reference is NOT a content item are named explicitly', () => {
    const unreachable = AUTOMATION_TRIGGERS.filter((t) => t.contentItemVia === null).map(
      (t) => t.type,
    );
    expect(unreachable).toEqual([
      'ANALYTICS_REFRESHED',
      'ANOMALY_DETECTED',
      'METRIC_THRESHOLD_CROSSED',
      'SCHEDULED_TIME',
    ]);
    // Their reference types are what made the old code dangerous: an Insight id
    // or a MetricObservation id passed to `placeOnCalendar` as a content item.
    expect(findTrigger('ANOMALY_DETECTED')?.refType).toBe('Insight');
    expect(findTrigger('METRIC_THRESHOLD_CROSSED')?.refType).toBe('MetricObservation');
    expect(findTrigger('ANALYTICS_REFRESHED')?.refType).toBe('AnalyticsIngestionRun');
    expect(findTrigger('SCHEDULED_TIME')?.refType).toBeNull();
  });

  it('NOTIFY is reachable from everything, because it points at whatever fired', () => {
    expect(findAction('NOTIFY')?.needsContentItem).toBe(false);
    for (const trigger of AUTOMATION_TRIGGERS) {
      expect(actionSupportsTrigger('NOTIFY', trigger.type)).toBe(true);
    }
  });

  it('an unknown pair FAILS CLOSED', () => {
    expect(actionSupportsTrigger('NOT_AN_ACTION' as never, 'POST_PUBLISHED')).toBe(false);
    expect(actionSupportsTrigger('NOTIFY', 'NOT_A_TRIGGER' as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P7-R7 — a level metric declares its own combination rule
// ---------------------------------------------------------------------------

describe('P7-R7: "latest" is a declared semantic, not MAX(value)', () => {
  it('followers is the one LEVEL metric, and says so', () => {
    expect(aggregationFor('followers')).toBe('LATEST_PER_SUBJECT_SUM');
    expect(isLevelMetric('followers')).toBe(true);
  });

  it('a flow is SUM and a rate is DERIVED', () => {
    expect(aggregationFor('impressions')).toBe('SUM');
    // A movement adds up even though a level does not — that distinction is the
    // whole reason `follower_change` exists beside `followers`.
    expect(aggregationFor('follower_change')).toBe('SUM');
    expect(aggregationFor('engagement_rate')).toBe('DERIVED');
    expect(isLevelMetric('impressions')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P7-R8 — a claim is grounded in what IT cited, not in the document
// ---------------------------------------------------------------------------

describe('P7-R8: grounding is claim-to-cited-evidence', () => {
  const period = {
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-09-08T00:00:00.000Z'),
  };

  const metric = (over: Partial<MetricValue> = {}): MetricValue => ({
    metricKey: 'impressions',
    value: 12_345n,
    unit: 'COUNT',
    absent: null,
    previousValue: null,
    changeMilli: null,
    observationCount: 7,
    ...over,
  });

  /** Two unrelated figures on one table — the shape that made the old check useless. */
  const evidence = buildEvidencePackage({
    period,
    metrics: [
      metric(),
      metric({ metricKey: 'reach', value: 98_765n }),
      metric({ metricKey: 'engagements', value: 4_242n }),
    ],
    maxItems: 10,
  });

  const claim = (text: string, refs: number[]) => ({
    evidenceRefs: refs,
    text: { ar: text, en: text },
  });

  it('THE DEFECT: a number from ANOTHER row used to pass because it was on the table', () => {
    /*
     * "Impressions fell to 98765" citing e1 (impressions = 12345). The figure is
     * real — it is the REACH — and attaching it to the wrong metric is exactly
     * the mistake a customer cannot catch and would act on. The document-wide
     * check said yes, because 98765 appeared SOMEWHERE in the package.
     */
    expect(evidence.allowedNumbers.has('98765')).toBe(true);

    const violations = validateGroundedDocument({
      claims: [claim('Impressions fell to 98765', [1])],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toEqual(['ungrounded_number']);
    expect(violations[0]?.detail).toBe('98765');
  });

  it('the SAME sentence is accepted when it cites the row the number came from', () => {
    expect(
      validateGroundedDocument({ claims: [claim('Reach reached 98765', [2])], evidence }),
    ).toEqual([]);
  });

  it('the check does not get WEAKER as a customer accumulates evidence', () => {
    // One claim, one citation, three unrelated rows on the table. Under the old
    // rule every one of those rows licensed its numbers for every claim.
    const violations = validateGroundedDocument({
      claims: [claim('Engagements were 12345', [3])],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toEqual(['ungrounded_number']);
  });

  it('an UNKNOWN ordinal stays a hard rejection AND licenses no numbers', () => {
    /*
     * A model must not be able to launder a fabricated figure by citing an
     * ordinal that does not exist: it gets the citation violation AND still the
     * number violation.
     */
    const violations = validateGroundedDocument({
      claims: [claim('Impressions were 55555', [99])],
      evidence,
    });
    expect(violations.map((v) => v.kind).sort()).toEqual(['ungrounded_number', 'unknown_citation']);
  });

  it('the SUMMARY cites nothing, so it may not state a measured figure', () => {
    const violations = validateGroundedDocument({
      claims: [claim('Impressions were 12345', [1])],
      uncited: [{ ar: 'وصلت الظهور إلى 12345', en: 'Impressions reached 12345' }],
      evidence,
    });
    // The CLAIM is fine; the summary is not. ONE violation for the two locales,
    // because the numeral set is de-duplicated — the figure is reported once
    // rather than once per language, which is what a reader of the audit row
    // wants.
    expect(violations.map((v) => v.kind)).toEqual(['ungrounded_number']);
    expect(violations[0]?.detail).toBe('12345');
  });

  it('an uncited summary is not refused merely for citing nothing', () => {
    expect(
      validateGroundedDocument({
        claims: [claim('Impressions were 12345', [1])],
        uncited: [{ ar: 'أداء قوي هذا الأسبوع', en: 'A strong week' }],
        evidence,
      }),
    ).toEqual([]);
  });

  it('ARABIC-INDIC DIGITS ARE FOLDED, per claim as well as per document', () => {
    const violations = validateGroundedDocument({
      claims: [claim('بلغ الوصول ٩٨٧٦٥', [1])],
      evidence,
    });
    expect(violations.map((v) => v.detail)).toEqual(['98765']);
  });

  it('single digits stay allowed — a model cannot write without small integers', () => {
    expect(
      validateGroundedDocument({ claims: [claim('The top 3 posts, in week 2', [1])], evidence }),
    ).toEqual([]);
  });

  it('a claim citing nothing is still a no_citation violation', () => {
    expect(
      validateGroundedDocument({ claims: [claim('Performance was strong', [])], evidence }).map(
        (v) => v.kind,
      ),
    ).toEqual(['no_citation']);
  });

  it('per-ordinal numbers include the row that ordinal renders, and no other', () => {
    expect([...(evidence.numbersByOrdinal.get(1) ?? [])]).toContain('12345');
    expect([...(evidence.numbersByOrdinal.get(1) ?? [])]).not.toContain('98765');
    expect([...(evidence.numbersByOrdinal.get(2) ?? [])]).toContain('98765');
  });

  it('validateGrounding on its own now scopes to the cited ordinals too', () => {
    // The document helper is the entry point, but the primitive underneath must
    // not be a back door for the old behaviour.
    const violations = validateGrounding({
      text: 'Impressions were 98765',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toEqual(['ungrounded_number']);
  });
});
