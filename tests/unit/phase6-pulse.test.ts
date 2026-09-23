import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Anomaly } from '@brandspace/analytics';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  CALENDAR_GAP_HORIZON_DAYS,
  CREDIT_FORECAST_WINDOW_DAYS,
  creditForecast,
  rankAttention,
  type AttentionItem,
} from '../../apps/dashboard/src/server/command-center';
import {
  analyticsNextSteps,
  latestShift,
  performanceShiftItem,
} from '../../apps/dashboard/src/server/performance-patterns';
import { insightNarrative } from '../../apps/dashboard/src/server/insight-narrative';
import { analyticsEvidence, conflictNote } from '../../apps/dashboard/src/server/learning-review';

/**
 * PHASE 6 · P6-11 — ANALYTICS → INTELLIGENCE → LEARNINGS → PULSE, AS PURE RULES.
 *
 * Everything here is arithmetic or parsing that decides WHAT a reader is told,
 * and each rule has a way of becoming a fabricated claim if it is loosened:
 *
 *   - the credit forecast must say nothing it cannot derive — no renewal date,
 *     no usage, nothing spendable, or a renewal that arrives first;
 *   - a performance shift is the MOST RECENT anomaly inside the window, never a
 *     stale one resurfaced by a longer range;
 *   - a next step is offered only to a reader who may follow it;
 *   - an insight's narrative is re-parsed, never trusted, and a citation to
 *     evidence the reader cannot see is dropped;
 *   - an analytics learning's evidence is parsed or not shown at all.
 *
 * The isolation suite (`tests/isolation/phase6-pulse.test.ts`) pins the
 * queries; this file pins the decisions.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-20T12:00:00.000Z');

describe('P6-11 · the credit forecast says only what the ledger supports', () => {
  const base = {
    spendableMilliCredits: 10_000n,
    // 28 000 milli over 28 days = 1 000 a day → 10 days left.
    consumedInWindowMilliCredits: 28_000n,
    windowDays: CREDIT_FORECAST_WINDOW_DAYS,
    now: NOW,
  };

  it('forecasts a run-out that lands BEFORE the renewal', () => {
    const renewal = new Date(NOW.getTime() + 20 * DAY);
    const forecast = creditForecast({ ...base, nextResetAt: renewal });
    expect(forecast?.daysLeft).toBe(10);
    expect(forecast?.runOutAt.toISOString()).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
  });

  it('says NOTHING when the renewal arrives first — there is nothing to act on', () => {
    expect(creditForecast({ ...base, nextResetAt: new Date(NOW.getTime() + 5 * DAY) })).toBeNull();
    // Exactly on the renewal is not "before" it.
    expect(creditForecast({ ...base, nextResetAt: new Date(NOW.getTime() + 10 * DAY) })).toBeNull();
  });

  it('says nothing with no renewal date to compare against', () => {
    expect(creditForecast({ ...base, nextResetAt: null })).toBeNull();
  });

  it('says nothing with no consumption, or net REFUNDS, in the window', () => {
    const renewal = new Date(NOW.getTime() + 30 * DAY);
    expect(
      creditForecast({ ...base, consumedInWindowMilliCredits: 0n, nextResetAt: renewal }),
    ).toBeNull();
    expect(
      creditForecast({ ...base, consumedInWindowMilliCredits: -500n, nextResetAt: renewal }),
    ).toBeNull();
  });

  it('says nothing when nothing is spendable — that is the present, not a forecast', () => {
    const renewal = new Date(NOW.getTime() + 30 * DAY);
    expect(creditForecast({ ...base, spendableMilliCredits: 0n, nextResetAt: renewal })).toBeNull();
    expect(
      creditForecast({ ...base, spendableMilliCredits: -1n, nextResetAt: renewal }),
    ).toBeNull();
  });

  it('never rounds a positive balance down to "0 days"', () => {
    const renewal = new Date(NOW.getTime() + 30 * DAY);
    const forecast = creditForecast({ ...base, spendableMilliCredits: 100n, nextResetAt: renewal });
    expect(forecast?.daysLeft).toBe(1);
  });

  it('divides by the WHOLE window, so a young workspace is not extrapolated from one afternoon', () => {
    // 1 000 spent, all of it today. Over the full window the pace is ~36/day,
    // not 1 000/day — so with 10 000 spendable the run-out is ~280 days away,
    // after any monthly renewal, and nothing is raised.
    const renewal = new Date(NOW.getTime() + 30 * DAY);
    expect(
      creditForecast({
        ...base,
        consumedInWindowMilliCredits: 1_000n,
        nextResetAt: renewal,
      }),
    ).toBeNull();
  });
});

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    metricKey: 'engagements',
    unit: 'COUNT',
    direction: 'below',
    periodStart: new Date(NOW.getTime() - 2 * DAY),
    observedValue: 40n,
    baselineValue: 100n,
    baselinePeriods: 7,
    baselineStart: new Date(NOW.getTime() - 9 * DAY),
    baselineEnd: new Date(NOW.getTime() - 3 * DAY),
    deviationMilli: -600,
    thresholdMilli: 500,
    ...overrides,
  };
}

describe('P6-11 · a performance shift is the most recent one, inside the window', () => {
  it('picks the latest anomaly, not the largest', () => {
    const older = anomaly({ periodStart: new Date(NOW.getTime() - 5 * DAY), deviationMilli: -900 });
    const newer = anomaly({ periodStart: new Date(NOW.getTime() - 1 * DAY), deviationMilli: -550 });
    expect(latestShift([older, newer], { now: NOW, withinDays: 7 })).toBe(newer);
    expect(latestShift([newer, older], { now: NOW, withinDays: 7 })).toBe(newer);
  });

  it('ignores a shift outside the window, however large', () => {
    const stale = anomaly({
      periodStart: new Date(NOW.getTime() - 30 * DAY),
      deviationMilli: -990,
    });
    expect(latestShift([stale], { now: NOW, withinDays: 7 })).toBeNull();
  });

  it('returns nothing for nothing', () => {
    expect(latestShift([], { now: NOW, withinDays: 90 })).toBeNull();
    expect(performanceShiftItem(null)).toBeNull();
  });

  it('becomes a NOTICE on Home that carries the metric key and never the figure', () => {
    const item = performanceShiftItem(anomaly());
    expect(item).toMatchObject({
      kind: 'performance-below',
      severity: 'notice',
      href: '/analytics',
      detail: 'engagements',
    });
    // No observed or baseline value rides along — the number belongs on the
    // analytics screen under its freshness and scope checks.
    expect(JSON.stringify(item)).not.toContain('40');
    expect(performanceShiftItem(anomaly({ direction: 'above' }))?.kind).toBe('performance-above');
  });
});

describe('P6-11 · a next step is offered only to someone who can take it', () => {
  const everything = [
    'integrations.read',
    'content.read',
    'analytics.explain',
    'strategy.read',
  ] as const;

  it('maps each measured condition to where it is fixed, in unblock order', () => {
    const steps = analyticsNextSteps({
      absences: ['no_published_content', 'no_connection', 'metrics_pending', null],
      shift: anomaly(),
      unreviewedFindings: 2,
      permissionKeys: everything,
    });
    expect(steps.map((step) => step.key)).toEqual([
      'connect',
      'schedule',
      'wait-for-sync',
      'explain-shift',
      'review-findings',
    ]);
    expect(steps.find((step) => step.key === 'connect')?.href).toBe('/integrations');
    expect(steps.find((step) => step.key === 'schedule')?.href).toBe('/calendar');
  });

  it('drops every step whose destination the reader may not open', () => {
    const steps = analyticsNextSteps({
      absences: ['no_connection', 'connection_needs_reauthorization', 'no_published_content'],
      shift: anomaly(),
      unreviewedFindings: 3,
      permissionKeys: [],
    });
    expect(steps).toEqual([]);
  });

  it('offers nothing for conditions nobody here can act on', () => {
    const steps = analyticsNextSteps({
      absences: ['not_published_by_platform', 'components_missing'],
      shift: null,
      unreviewedFindings: 0,
      permissionKeys: everything,
    });
    expect(steps).toEqual([]);
  });

  it('has a sentence, and an action label where it links, in BOTH languages', () => {
    for (const key of [
      'connect',
      'reconnect',
      'schedule',
      'wait-for-sync',
      'explain-shift',
      'review-findings',
    ]) {
      for (const locale of ['en', 'ar'] as const) {
        const catalogue = messages[locale] as Record<string, string>;
        expect(catalogue[`analytics.next.${key}`], `${locale}:${key}`).toBeTruthy();
      }
    }
    for (const key of ['connect', 'reconnect', 'schedule', 'review-findings']) {
      for (const locale of ['en', 'ar'] as const) {
        const catalogue = messages[locale] as Record<string, string>;
        expect(catalogue[`analytics.next.${key}.action`], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});

describe('P6-11 · an insight narrative is parsed, and cites only what is shown', () => {
  const explanation = {
    summary: { en: 'Engagement fell after posting stopped.', ar: 'انخفض التفاعل بعد توقف النشر.' },
    claims: [{ evidenceRefs: [1, 2], text: { en: 'Engagement fell.', ar: 'انخفض التفاعل.' } }],
    notableChanges: [{ evidenceRefs: [9], text: { en: 'A change.', ar: 'تغيير.' } }],
    recommendations: [{ evidenceRefs: [2], text: { en: 'Post again.', ar: 'انشر مجددًا.' } }],
  };

  it('answers why / what happened / what next, in the reader’s language', () => {
    const en = insightNarrative({
      type: 'ANALYTICS_EXPLANATION',
      body: explanation,
      locale: 'en',
      shownEvidence: [1, 2, 3],
    });
    expect(en?.why).toBe('Engagement fell after posting stopped.');
    expect(en?.happened.map((line) => line.text)).toEqual(['Engagement fell.', 'A change.']);
    expect(en?.next.map((line) => line.text)).toEqual(['Post again.']);

    const ar = insightNarrative({
      type: 'ANALYTICS_EXPLANATION',
      body: explanation,
      locale: 'ar',
      shownEvidence: [1, 2, 3],
    });
    expect(ar?.why).toBe('انخفض التفاعل بعد توقف النشر.');
  });

  it('drops a citation to an evidence row the reader cannot see', () => {
    const narrative = insightNarrative({
      type: 'ANALYTICS_EXPLANATION',
      body: explanation,
      locale: 'en',
      shownEvidence: [1],
    });
    expect(narrative?.happened[0]?.evidence).toEqual([1]);
    // e9 is not among the rows shown, so the line keeps its text and loses the
    // reference rather than pointing at nothing.
    expect(narrative?.happened[1]?.evidence).toEqual([]);
  });

  it('narrates a content gap: the gap is what happened, the suggestion is what next', () => {
    const narrative = insightNarrative({
      type: 'CONTENT_GAP',
      body: {
        summary: { en: 'Pillars are uncovered.', ar: 'محاور غير مغطاة.' },
        gaps: [
          {
            title: { en: 'Sustainability', ar: 'الاستدامة' },
            rationale: {
              evidenceRefs: [1],
              text: { en: 'Nothing published.', ar: 'لا شيء منشور.' },
            },
            suggestedAction: { en: 'Plan two posts.', ar: 'خطّط منشورين.' },
          },
        ],
      },
      locale: 'en',
      shownEvidence: [1],
    });
    expect(narrative?.happened[0]?.text).toBe('Sustainability — Nothing published.');
    expect(narrative?.next[0]).toEqual({ text: 'Plan two posts.', evidence: [1] });
  });

  it('returns null — not a partial object — for a body that does not parse', () => {
    for (const body of [null, {}, 'prose', { summary: { en: 'x' } }, { claims: [] }]) {
      expect(
        insightNarrative({ type: 'ANALYTICS_EXPLANATION', body, locale: 'en', shownEvidence: [1] }),
      ).toBeNull();
    }
  });

  it('narrates nothing for a type it has no defined body for', () => {
    for (const type of ['ANOMALY', 'RECOMMENDATION', 'OPPORTUNITY', 'STRATEGY']) {
      expect(
        insightNarrative({ type, body: explanation, locale: 'en', shownEvidence: [1, 2] }),
      ).toBeNull();
    }
  });
});

describe('P6-11 · an analytics learning’s evidence is parsed or not shown', () => {
  const stored = {
    inferenceVersion: 'learning-rules-1',
    metricKey: 'engagements',
    observedValue: '412',
    baselineValue: '900',
    deviationMilli: -542,
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-09-15T00:00:00.000Z',
    baselineStart: '2026-08-01T00:00:00.000Z',
    baselineEnd: '2026-08-31T00:00:00.000Z',
    insightId: '6f1c2b8e-4c63-4d8e-9d55-2f4c9b1a7e10',
  };

  it('reads the object the learning rules write', () => {
    const parsed = analyticsEvidence(stored);
    expect(parsed?.metricKey).toBe('engagements');
    expect(parsed?.observedValue).toBe('412');
    expect(parsed?.deviationMilli).toBe(-542);
    expect(parsed?.periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses a document candidate’s array shape, a missing field and a non-integer value', () => {
    expect(analyticsEvidence([{ locator: 'p.1', quote: 'x' }])).toBeNull();
    expect(analyticsEvidence({ ...stored, observedValue: undefined })).toBeNull();
    expect(analyticsEvidence({ ...stored, observedValue: '4.12' })).toBeNull();
    expect(analyticsEvidence({ ...stored, deviationMilli: 1.5 })).toBeNull();
    expect(analyticsEvidence({ ...stored, periodStart: 'yesterday' })).toBeNull();
    // A metric key that could not be a message key is not rendered as one.
    expect(analyticsEvidence({ ...stored, metricKey: '<script>' })).toBeNull();
    expect(analyticsEvidence(null)).toBeNull();
  });

  it('reports a conflict whether or not the human fact is among the loaded items', () => {
    expect(conflictNote({ conflictsWithItemId: null, titleOf: () => 'x' })).toBeNull();
    expect(conflictNote({ conflictsWithItemId: 'a', titleOf: () => 'Tone of voice' })).toEqual({
      title: 'Tone of voice',
    });
    expect(conflictNote({ conflictsWithItemId: 'a', titleOf: () => null })).toEqual({
      title: null,
    });
  });
});

describe('P6-11 · Pulse is one ranked list with a sentence for every kind', () => {
  it('ranks blocked before waiting before notice, keeping source order within a level', () => {
    const item = (kind: string, severity: AttentionItem['severity']): AttentionItem => ({
      kind,
      severity,
      count: 1,
      href: '/overview',
    });
    const ranked = rankAttention([
      item('a-notice', 'notice'),
      item('b-waiting', 'waiting'),
      item('c-blocked', 'blocked'),
      item('d-notice', 'notice'),
    ]);
    expect(ranked.map((entry) => entry.kind)).toEqual([
      'c-blocked',
      'b-waiting',
      'a-notice',
      'd-notice',
    ]);
  });

  it('every kind the Command Center can emit has its sentence in BOTH languages', () => {
    const source = readFileSync('apps/dashboard/src/server/command-center.ts', 'utf8');
    const kinds = [...source.matchAll(/kind: '([a-z-]+)'/g)].map((match) => match[1] as string);
    const all = [...new Set([...kinds, 'performance-above', 'performance-below'])];
    // Every source the file declares — a guard that the regex is still finding them.
    expect(all.length).toBeGreaterThanOrEqual(15);
    const named = ['brand-brain-empty', 'campaign-empty', 'calendar-gap'];
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      for (const kind of all) {
        expect(catalogue[`attention.${kind}`], `${locale}:${kind}`).toBeTruthy();
      }
      for (const kind of named) {
        expect(catalogue[`attention.${kind}.many`], `${locale}:${kind}.many`).toBeTruthy();
      }
    }
  });

  it('states the horizons it presents, rather than hiding them in a query', () => {
    // Both are sentences on screen ("the next 7 days", "the last 28 days"), so
    // a change to either constant must be a change to the copy too.
    expect(messages.en['attention.calendar-gap.many']).toContain(
      `${CALENDAR_GAP_HORIZON_DAYS} days`,
    );
    expect(messages.en['attention.credits-forecast']).toContain(
      `${CREDIT_FORECAST_WINDOW_DAYS} days`,
    );
    expect(messages.ar['attention.credits-forecast']).toContain(`${CREDIT_FORECAST_WINDOW_DAYS}`);
  });
});
