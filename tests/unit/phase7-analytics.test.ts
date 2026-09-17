import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import {
  DERIVED_METRICS,
  INGESTED_METRICS,
  METRIC_DEFINITIONS,
  buildEvidencePackage,
  changeInMilli,
  computeDerived,
  csvCell,
  csvRow,
  detectAnomalies,
  digitRuns,
  findMetric,
  foldDigits,
  freshnessFor,
  isAdditive,
  metricsForProvider,
  nextAttemptAfterFailure,
  observationKeyFor,
  parseAnalyticsPolicy,
  parseJsonResponse,
  providerSupportsMetric,
  renderEvidence,
  runIdempotencyKeyFor,
  explanationSchema,
  validateGrounding,
  type AnalyticsPolicy,
  type MetricValue,
} from '@brandspace/analytics';

/**
 * Phase 7 — the ARITHMETIC and the GROUNDING, with no database anywhere near it.
 *
 * These are the assertions that would still matter if every table were dropped:
 * whether a rate is computed or averaged, whether a missing figure is a zero,
 * whether an anomaly is found with hindsight, and whether a sentence the model
 * wrote is allowed to contain a number nobody measured.
 */

const policy: AnalyticsPolicy = parseAnalyticsPolicy(defaultPayload('analytics'));

describe('the canonical metric vocabulary', () => {
  it('every metric declares a unit, a kind, and whether it may be summed', () => {
    for (const metric of METRIC_DEFINITIONS) {
      expect(metric.key, 'key').toBeTruthy();
      expect(metric.unit, `${metric.key} unit`).toBeTruthy();
      expect(metric.kind, `${metric.key} kind`).toBeTruthy();
      expect(typeof metric.additive, `${metric.key} additive`).toBe('boolean');
    }
  });

  it('volumes are additive and rates are NOT — the distinction every total rests on', () => {
    expect(isAdditive('impressions')).toBe(true);
    expect(isAdditive('engagements')).toBe(true);
    // Summing a rate is the single most common analytics defect. Stated here so
    // a future metric cannot be added on the wrong side of it without failing.
    expect(isAdditive('engagement_rate')).toBe(false);
    for (const metric of METRIC_DEFINITIONS) {
      if (metric.unit === 'RATIO_MILLI') {
        expect(metric.additive, `${metric.key} is a rate and must not be additive`).toBe(false);
      }
    }
  });

  it('a derived metric names both of its components, and both are ingested', () => {
    expect(DERIVED_METRICS.length).toBeGreaterThan(0);
    const ingested = new Set(INGESTED_METRICS.map((m) => m.key));
    for (const metric of DERIVED_METRICS) {
      expect(metric.derivedFrom, `${metric.key} derivedFrom`).toBeTruthy();
      expect(ingested, `${metric.key} numerator`).toContain(metric.derivedFrom?.numerator);
      expect(ingested, `${metric.key} denominator`).toContain(metric.derivedFrom?.denominator);
    }
  });

  it('a derived metric is only offered where BOTH its components are reported', () => {
    /*
     * OTHERWISE THE RATE IS A PROMISE THE PLATFORM CANNOT KEEP. A provider that
     * reports engagements but not impressions has no engagement RATE, and
     * claiming one would produce a metric that is permanently "missing" on that
     * platform with no explanation a customer could act on.
     */
    for (const metric of DERIVED_METRICS) {
      const numerator = findMetric(metric.derivedFrom!.numerator)!;
      const denominator = findMetric(metric.derivedFrom!.denominator)!;
      for (const provider of metric.supportedBy) {
        expect(numerator.supportedBy, `${metric.key} numerator on ${provider}`).toContain(provider);
        expect(denominator.supportedBy, `${metric.key} denominator on ${provider}`).toContain(
          provider,
        );
      }
    }
  });

  it('a provider is only credited with the metrics it actually publishes', () => {
    expect(providerSupportsMetric('LINKEDIN', 'impressions')).toBe(true);
    expect(providerSupportsMetric('LINKEDIN', 'not_a_metric')).toBe(false);
    for (const metric of metricsForProvider('X')) {
      expect(metric.supportedBy, `${metric.key}`).toContain('X');
    }
  });

  it('an unknown key is not a metric, and does not become one by being asked for', () => {
    expect(findMetric('revenue')).toBeUndefined();
    expect(findMetric('')).toBeUndefined();
  });
});

describe('derived metrics: missing and zero are different states', () => {
  it('a rate is computed from the TOTALS, in parts per mille, rounded half-up', () => {
    // 137 / 1000 = 13.7% = 137 per mille.
    expect(computeDerived('engagement_rate', { engagements: 137n, impressions: 1_000n })).toBe(
      137n,
    );
    // 1 / 3 = 33.33% -> 333 per mille.
    expect(computeDerived('engagement_rate', { engagements: 1n, impressions: 3n })).toBe(333n);
    // Half-up: 45.5 per mille stays 46 rather than 45 on one screen and 46 on another.
    expect(computeDerived('engagement_rate', { engagements: 91n, impressions: 2_000n })).toBe(46n);
  });

  it('a rate whose DENOMINATOR IS ZERO is null, never 0%', () => {
    /*
     * THE ASSERTION THIS WHOLE FILE EXISTS FOR. "0% engagement" is a claim about
     * PERFORMANCE; "we have no impressions to divide by" is a claim about DATA.
     * A product that renders the first when the second is true is lying quietly.
     */
    expect(computeDerived('engagement_rate', { engagements: 5n, impressions: 0n })).toBeNull();
  });

  it('a rate whose components are missing is null, not zero', () => {
    expect(computeDerived('engagement_rate', { engagements: 5n })).toBeNull();
    expect(computeDerived('engagement_rate', { impressions: 100n })).toBeNull();
    expect(computeDerived('engagement_rate', {})).toBeNull();
  });

  it('a genuine zero numerator IS zero — the provider measured nothing happening', () => {
    // Different from the cases above: the denominator exists, so the rate exists
    // and it really is 0. Missing is not zero, and zero is not missing.
    expect(computeDerived('engagement_rate', { engagements: 0n, impressions: 1_000n })).toBe(0n);
  });

  it('an unknown or non-derived key cannot be derived', () => {
    expect(computeDerived('impressions', { impressions: 10n })).toBeNull();
    expect(computeDerived('nonsense', {})).toBeNull();
  });
});

describe('comparison arithmetic', () => {
  it('a change is parts per mille against the baseline', () => {
    expect(changeInMilli(150n, 100n)).toBe(500); // +50%
    expect(changeInMilli(50n, 100n)).toBe(-500); // -50%
    expect(changeInMilli(100n, 100n)).toBe(0);
  });

  it('a change FROM ZERO is null, because it is not a percentage', () => {
    /*
     * "Up ∞%" and "up 100%" are both wrong, and both are what a naive division
     * produces. The honest answer is that there is no baseline to compare with.
     */
    expect(changeInMilli(150n, 0n)).toBeNull();
  });

  it('a change against a MISSING side is null on either side', () => {
    expect(changeInMilli(null, 100n)).toBeNull();
    expect(changeInMilli(100n, null)).toBeNull();
    expect(changeInMilli(null, null)).toBeNull();
  });
});

describe('observation identity and run identity', () => {
  const base = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    socialConnectionId: '22222222-2222-4222-8222-222222222222',
    subjectType: 'ACCOUNT' as const,
    subjectExternalId: 'acct-1',
    metricKey: 'impressions',
    granularity: 'DAY' as const,
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
  };

  it('the same measurement produces the same key, so a re-fetch is free', () => {
    expect(observationKeyFor(base)).toBe(observationKeyFor({ ...base }));
  });

  it('GRANULARITY is part of the identity: a day and a week are different observations', () => {
    expect(observationKeyFor({ ...base, granularity: 'WEEK' })).not.toBe(observationKeyFor(base));
  });

  it('the workspace is part of the identity, so two tenants cannot collide', () => {
    expect(
      observationKeyFor({ ...base, workspaceId: '33333333-3333-4333-8333-333333333333' }),
    ).not.toBe(observationKeyFor(base));
  });

  it('every distinguishing field changes the key', () => {
    const variants = [
      { socialConnectionId: '44444444-4444-4444-8444-444444444444' },
      { subjectType: 'POST' as const },
      { subjectExternalId: 'acct-2' },
      { metricKey: 'reach' },
      { periodStart: new Date('2026-09-02T00:00:00.000Z') },
    ];
    for (const variant of variants) {
      expect(observationKeyFor({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(
        observationKeyFor(base),
      );
    }
  });

  it('a run key is the same for the same window and differs for a backfill', () => {
    const run = {
      cursorId: '55555555-5555-4555-8555-555555555555',
      windowStart: new Date('2026-09-01T00:00:00.000Z'),
      windowEnd: new Date('2026-09-02T00:00:00.000Z'),
    };
    expect(runIdempotencyKeyFor({ ...run, kind: 'SCHEDULED' })).toBe(
      runIdempotencyKeyFor({ ...run, kind: 'SCHEDULED' }),
    );
    expect(runIdempotencyKeyFor({ ...run, kind: 'BACKFILL' })).not.toBe(
      runIdempotencyKeyFor({ ...run, kind: 'SCHEDULED' }),
    );
  });
});

describe('freshness and backoff', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('a connection never synced is UNAVAILABLE, not STALE', () => {
    expect(freshnessFor(policy, null, { now: () => now })).toBe('UNAVAILABLE');
  });

  it('a recent sync is FRESH and an old one is STALE', () => {
    const recent = new Date(now.getTime() - 60_000);
    expect(freshnessFor(policy, recent, { now: () => now })).toBe('FRESH');

    const old = new Date(now.getTime() - (policy.freshness.staleAfterMinutes + 60) * 60_000);
    expect(freshnessFor(policy, old, { now: () => now })).toBe('STALE');

    // AND THE STATE BETWEEN THEM IS ITS OWN STATE. "Aging" is not "fresh" and
    // not "stale"; collapsing it into either would make the banner lie in one
    // direction or nag in the other.
    const aging = new Date(now.getTime() - (policy.freshness.freshWithinMinutes + 1) * 60_000);
    expect(freshnessFor(policy, aging, { now: () => now })).toBe('AGING');
  });

  it('backoff grows with consecutive failures and is capped', () => {
    const clock = { now: () => now };
    const first = nextAttemptAfterFailure(policy, 1, clock, () => 0.5);
    const second = nextAttemptAfterFailure(policy, 2, clock, () => 0.5);
    const far = nextAttemptAfterFailure(policy, 50, clock, () => 0.5);

    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(far.getTime() - now.getTime()).toBeLessThanOrEqual(
      policy.retry.maxBackoffSeconds * 1_000 * (1 + policy.retry.jitterRatio),
    );
  });

  it('every retry is in the FUTURE, whatever the jitter draws', () => {
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(
        nextAttemptAfterFailure(policy, 3, { now: () => now }, () => draw).getTime(),
      ).toBeGreaterThan(now.getTime());
    }
  });
});

describe('anomaly detection states its own basis and never uses hindsight', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n));

  function series(values: (number | null)[]) {
    return values.map((value, index) => ({
      periodStart: day(index + 1),
      value: value === null ? null : BigInt(value),
    }));
  }

  const shortBaseline: AnalyticsPolicy = {
    ...policy,
    anomaly: { ...policy.anomaly, baselinePeriods: 3, minimumBaselineValue: 10 },
  };

  it('a steady series has no anomalies', () => {
    const found = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([100, 100, 100, 100, 100, 100]),
      policy: shortBaseline,
    });
    expect(found).toHaveLength(0);
  });

  it('a spike is found, and the finding names its baseline, window and change', () => {
    const found = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([100, 100, 100, 1_000]),
      policy: shortBaseline,
    });
    expect(found).toHaveLength(1);
    const anomaly = found[0]!;
    /*
     * "NO MYSTERIOUS 'AI DETECTED A PROBLEM' LABEL." Every field a person needs
     * to check the finding themselves is on it: what was observed, what it is
     * being compared with, how many periods that baseline came from, when those
     * periods were, and the threshold the rule used.
     */
    expect(anomaly.direction).toBe('above');
    expect(anomaly.observedValue).toBe(1_000n);
    expect(anomaly.baselineValue).toBe(100n);
    expect(anomaly.baselinePeriods).toBe(3);
    expect(anomaly.baselineStart).toEqual(day(1));
    expect(anomaly.baselineEnd).toEqual(day(3));
    expect(anomaly.deviationMilli).toBeGreaterThan(0);
    expect(anomaly.thresholdMilli).toBe(shortBaseline.anomaly.deviationThresholdMilli);
    expect(anomaly.metricKey).toBe('impressions');
  });

  it('a drop is found and is reported as below', () => {
    const found = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([1_000, 1_000, 1_000, 10]),
      policy: shortBaseline,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.direction).toBe('below');
  });

  it('it walks FORWARD: the candidate never contributes to its own baseline', () => {
    /*
     * A baseline computed over the whole series would include the spike, raising
     * the mean and hiding it. An anomaly found with hindsight also CHANGES ITS
     * MIND as more data arrives, which makes it useless as a trigger.
     */
    const found = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([100, 100, 100, 5_000, 100, 100]),
      policy: shortBaseline,
    });
    expect(found.some((a) => a.observedValue === 5_000n)).toBe(true);
  });

  it('a GAP is excluded from the baseline rather than treated as a zero', () => {
    const withGap = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([100, null, 100, 100, 1_000]),
      policy: shortBaseline,
    });
    // Baseline is the mean of the three OBSERVED 100s, not of 100, 0, 100, 100.
    expect(withGap[0]?.baselineValue).toBe(100n);
  });

  it('a tiny baseline is ignored, so noise on a quiet account is not an alarm', () => {
    const found = detectAnomalies({
      metricKey: 'impressions',
      unit: 'COUNT',
      points: series([1, 1, 1, 40]),
      policy: shortBaseline,
    });
    // A move from 1 to 40 is a 3,900% change and means nothing at all.
    expect(found).toHaveLength(0);
  });

  it('a series shorter than the baseline produces nothing', () => {
    expect(
      detectAnomalies({
        metricKey: 'impressions',
        unit: 'COUNT',
        points: series([100, 100]),
        policy: shortBaseline,
      }),
    ).toHaveLength(0);
  });
});

describe('the evidence package: what the model may say', () => {
  const period = {
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-09-08T00:00:00.000Z'),
  };

  function metric(overrides: Partial<MetricValue> = {}): MetricValue {
    return {
      metricKey: 'impressions',
      value: 12_345n,
      unit: 'COUNT',
      absent: null,
      previousValue: 10_000n,
      changeMilli: 234,
      observationCount: 7,
      ...overrides,
    };
  }

  it('a metric with NO VALUE contributes no evidence row', () => {
    /*
     * A null row is not evidence of zero and not evidence of anything else —
     * and a model handed one will reason about it enthusiastically.
     */
    const built = buildEvidencePackage({
      period,
      metrics: [metric({ value: null, absent: 'metrics_pending', previousValue: null })],
      maxItems: 10,
    });
    expect(built.items).toHaveLength(0);
  });

  it('ordinals are 1-based, contiguous, and the handle the model cites', () => {
    const built = buildEvidencePackage({
      period,
      metrics: [metric(), metric({ metricKey: 'reach', value: 900n })],
      maxItems: 10,
    });
    expect(built.items.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it('the package is bounded by maxItems', () => {
    const built = buildEvidencePackage({
      period,
      metrics: [metric(), metric({ metricKey: 'reach' }), metric({ metricKey: 'engagements' })],
      maxItems: 2,
    });
    expect(built.items).toHaveLength(2);
  });

  it('every measured value appears in the allowed-number set', () => {
    const built = buildEvidencePackage({ period, metrics: [metric()], maxItems: 10 });
    expect(built.allowedNumbers.has('12345')).toBe(true);
  });

  it('the rendered evidence is a table, and carries no ids a customer cannot check', () => {
    const built = buildEvidencePackage({
      period,
      metrics: [metric()],
      topPosts: [
        {
          contentItemId: '66666666-6666-4666-8666-666666666666',
          title: 'A post',
          provider: 'LINKEDIN',
          value: 500n,
          unit: 'COUNT',
        },
      ],
      maxItems: 10,
    });
    const rendered = renderEvidence(built.items);
    expect(rendered).toContain('impressions');
    // THE INTERNAL ROW ID IS NOT IN THE PROMPT. The model cites an ORDINAL; the
    // binding back to the row is ours to keep, not the model's to restate.
    expect(rendered).not.toContain('66666666-6666-4666-8666-666666666666');
  });
});

describe('grounding validation makes a fabricated citation structurally impossible', () => {
  const period = {
    start: new Date('2026-09-01T00:00:00.000Z'),
    end: new Date('2026-09-08T00:00:00.000Z'),
  };
  const evidence = buildEvidencePackage({
    period,
    metrics: [
      {
        metricKey: 'impressions',
        value: 12_345n,
        unit: 'COUNT',
        absent: null,
        previousValue: 10_000n,
        changeMilli: 234,
        observationCount: 7,
      },
    ],
    maxItems: 10,
  });

  it('a claim citing a row that exists, with numbers from it, passes', () => {
    const violations = validateGrounding({
      text: 'Impressions reached 12345 this week.',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations).toHaveLength(0);
  });

  it('a citation to a row that does not exist is an unknown_citation', () => {
    const violations = validateGrounding({
      text: 'Impressions reached 12345.',
      citedOrdinals: [1, 9],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toContain('unknown_citation');
    expect(violations.find((v) => v.kind === 'unknown_citation')?.detail).toBe('e9');
  });

  it('a number nowhere in the evidence is an ungrounded_number, EVEN WITH A VALID CITATION', () => {
    /*
     * THE DANGEROUS ONE. The citation makes the sentence look checked, and the
     * number in it was never measured by anybody.
     */
    const violations = validateGrounding({
      text: 'Impressions reached 98765 this week.',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toContain('ungrounded_number');
    expect(violations.find((v) => v.kind === 'ungrounded_number')?.detail).toBe('98765');
  });

  it('a claim with NO citation at all is a violation — a mood is not an explanation', () => {
    const violations = validateGrounding({
      text: 'Performance was strong.',
      citedOrdinals: [],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toContain('no_citation');
  });

  it('single digits are allowed, because a model cannot write without small integers', () => {
    const violations = validateGrounding({
      text: 'The top 3 posts drove 12345 impressions.',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations).toHaveLength(0);
  });

  it('ARABIC-INDIC NUMERALS ARE FOLDED, so the check is not bypassed by a different script', () => {
    /*
     * A model writing Arabic will write ٩٨٧٦٥, and a naive digit scan sees no
     * ASCII digits at all and passes it. Folding is what makes the check hold in
     * both languages rather than in one.
     */
    expect(foldDigits('٩٨٧٦٥')).toBe('98765');
    expect(digitRuns('بلغ الظهور ٩٨٧٦٥')).toContain('98765');

    const violations = validateGrounding({
      text: 'بلغ الظهور ٩٨٧٦٥ هذا الأسبوع.',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations.map((v) => v.kind)).toContain('ungrounded_number');
  });

  it('an Arabic sentence quoting a MEASURED figure passes', () => {
    const violations = validateGrounding({
      text: 'بلغ الظهور ١٢٣٤٥ هذا الأسبوع.',
      citedOrdinals: [1],
      evidence,
    });
    expect(violations).toHaveLength(0);
  });

  it('a caller-supplied allowance (a year, say) is honoured and nothing else is', () => {
    expect(
      validateGrounding({
        text: 'In 2026 impressions reached 12345.',
        citedOrdinals: [1],
        evidence,
        extraAllowedNumbers: new Set(['2026']),
      }),
    ).toHaveLength(0);

    expect(
      validateGrounding({
        text: 'In 2025 impressions reached 12345.',
        citedOrdinals: [1],
        evidence,
        extraAllowedNumbers: new Set(['2026']),
      }).map((v) => v.detail),
    ).toContain('2025');
  });
});

describe('parsing a model response', () => {
  it('parses clean JSON', () => {
    const parsed = parseJsonResponse(
      explanationSchema,
      JSON.stringify({
        summary: { ar: 'ملخص', en: 'Summary' },
        claims: [{ evidenceRefs: [1], text: { ar: 'ادعاء', en: 'Claim' } }],
      }),
    );
    expect(parsed.claims).toHaveLength(1);
  });

  it('parses JSON wrapped in a code fence, because models add them', () => {
    const parsed = parseJsonResponse(
      explanationSchema,
      '```json\n' +
        JSON.stringify({
          summary: { ar: 'ملخص', en: 'Summary' },
          claims: [{ evidenceRefs: [2], text: { ar: 'ادعاء', en: 'Claim' } }],
        }) +
        '\n```',
    );
    expect(parsed.claims[0]?.evidenceRefs).toEqual([2]);
  });

  it('refuses a response that is not the declared shape', () => {
    expect(() => parseJsonResponse(explanationSchema, '{"summary":"not an object"}')).toThrow();
    expect(() => parseJsonResponse(explanationSchema, 'not json at all')).toThrow();
  });

  it('refuses a claim with no evidence reference at the SCHEMA level', () => {
    // Before any validator runs: the shape itself does not admit an uncited claim.
    expect(() =>
      parseJsonResponse(
        explanationSchema,
        JSON.stringify({
          summary: { ar: 'ملخص', en: 'Summary' },
          claims: [{ evidenceRefs: [], text: { ar: 'ادعاء', en: 'Claim' } }],
        }),
      ),
    ).toThrow();
  });
});

describe('CSV export is not a spreadsheet attack', () => {
  it('every cell is quoted, unconditionally', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell(42)).toBe('"42"');
    expect(csvCell(null)).toBe('""');
  });

  it('an embedded quote is doubled rather than breaking the file', () => {
    expect(csvCell('a "quoted" word')).toBe('"a ""quoted"" word"');
  });

  it('EVERY formula prefix is neutralised with a leading apostrophe', () => {
    /*
     * THE ONE CSV RULE THAT IS A SECURITY CONTROL. A cell beginning `=`, `+`,
     * `-`, `@`, a tab or a carriage return is EXECUTED by Excel, Numbers and
     * Google Sheets, and provider-supplied text reaches these cells.
     */
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${prefix}CMD|'/c calc'!A1`), prefix).toBe(`"'${prefix}CMD|'/c calc'!A1"`);
    }
  });

  it('a value that merely CONTAINS a formula character is left alone', () => {
    expect(csvCell('brand-space=great')).toBe('"brand-space=great"');
  });

  it('a row is CRLF-free and comma-joined', () => {
    expect(csvRow(['a', 'b'])).toBe('"a","b"');
  });

  it('a Date becomes an ISO instant, not a locale string', () => {
    expect(csvCell(new Date('2026-09-01T00:00:00.000Z'))).toBe('"2026-09-01T00:00:00.000Z"');
  });

  it('a bigint survives without precision loss', () => {
    expect(csvCell(9_007_199_254_740_993n)).toBe('"9007199254740993"');
  });
});
