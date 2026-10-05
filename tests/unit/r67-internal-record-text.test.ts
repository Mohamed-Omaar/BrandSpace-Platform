import { describe, expect, it } from 'vitest';
import { isInternalRecordText } from '@brandspace/shared';
import { renderEvidence, validateGrounding, type EvidencePackage } from '@brandspace/analytics';
import { parseExplanation } from '../../apps/dashboard/src/server/analytics-story';
import { insightNarrative } from '../../apps/dashboard/src/server/insight-narrative';
import { pick } from '../../apps/dashboard/src/server/strategy-view';

/**
 * REVIEW OF #67 — THE PERFORMANCE SCREEN PRINTED THE PLATFORM'S OWN EVIDENCE
 * RECORD: "Why might this matter?" read
 * `e | METRIC | metric.total | metric=clicks | value= | unit=COUNT | from=-- | to=--`.
 *
 * The record is how evidence is written for a model; the development double
 * copied it into its answer with the digits taken out, which passed every
 * numeral check. These tests hold the three layers that now keep it from a
 * customer: the grounding gate refuses it, and every display of stored model
 * prose drops it — rows stored before the gate included.
 */

const REPORTED =
  'e | METRIC | metric.total | metric=clicks | value= | unit=COUNT | from=-- | to=--';

/** A real evidence line, as the platform renders it for a model. */
const RENDERED = renderEvidence([
  {
    ordinal: 3,
    kind: 'METRIC',
    labelKey: 'metric.total',
    metricKey: 'clicks',
    value: 40n,
    unit: 'COUNT',
    periodStart: new Date('2026-09-01T00:00:00Z'),
    periodEnd: new Date('2026-09-28T00:00:00Z'),
  },
]);

const PROSE = [
  'Saves rose in the same weeks educational posts went out.',
  'Plan two more educational carousels next month.',
  'Reach grew 12% — mostly from Reels | see the posts table.',
  'Use the A/B result, e.g. the second caption.',
  'الحفظ زاد في نفس الأسابيع اللي نزلت فيها منشورات تعليمية.',
  'خطط لكاروسيلين تعليميين الشهر الجاي.',
];

describe('review of #67 · the evidence record is never prose', () => {
  it('recognises the reported text, a rendered evidence line, and one without its digits', () => {
    expect(isInternalRecordText(REPORTED)).toBe(true);
    expect(isInternalRecordText(RENDERED)).toBe(true);
    expect(isInternalRecordText(RENDERED.replace(/[0-9]/g, ''))).toBe(true);
  });

  it('does not mistake a sentence for a record, in either language', () => {
    for (const text of PROSE) expect(isInternalRecordText(text), text).toBe(false);
  });

  it('the grounding gate refuses a claim that copies a record, even a correctly cited one', () => {
    const evidence: EvidencePackage = {
      items: [{ ordinal: 3, kind: 'METRIC', labelKey: 'metric.total' }],
      allowedNumbers: new Set(),
      numbersByOrdinal: new Map([[3, new Set<string>()]]),
      contextText: '',
    };
    const violations = validateGrounding({
      text: REPORTED,
      citedOrdinals: [3],
      evidence,
    });
    expect(violations.map((violation) => violation.kind)).toContain('internal_text');
    // And a real sentence citing the same row passes.
    expect(validateGrounding({ text: PROSE[0] ?? '', citedOrdinals: [3], evidence })).toEqual([]);
  });

  it('Performance drops a stored line that is a record, and keeps the prose beside it', () => {
    const explained = parseExplanation({
      summary: { en: REPORTED, ar: REPORTED },
      notableChanges: [{ evidenceRefs: [1], text: { en: PROSE[0], ar: PROSE[4] } }],
      claims: [
        { evidenceRefs: [1], text: { en: REPORTED, ar: REPORTED } },
        { evidenceRefs: [1], text: { en: PROSE[1], ar: PROSE[5] } },
      ],
      recommendations: [{ evidenceRefs: [1], text: { en: RENDERED, ar: RENDERED } }],
    });
    expect(explained.summary).toBeNull();
    expect(explained.claims).toHaveLength(1);
    expect(explained.claims[0]?.text.en).toBe(PROSE[1]);
    expect(explained.recommendations).toHaveLength(0);
    expect(explained.notableChanges).toHaveLength(1);
    const shown = JSON.stringify(explained);
    expect(shown).not.toContain('unit=');
    expect(shown).not.toContain('| METRIC |');
  });

  it('Marketing Intelligence and Strategy never show a record as prose', () => {
    const narrative = insightNarrative({
      type: 'ANALYTICS_EXPLANATION',
      body: {
        summary: { en: REPORTED, ar: REPORTED },
        notableChanges: [],
        claims: [{ evidenceRefs: [1], text: { en: REPORTED, ar: REPORTED } }],
        recommendations: [],
      },
      locale: 'en',
      shownEvidence: [1],
    });
    expect(JSON.stringify(narrative ?? {})).not.toContain('unit=');
    expect(pick({ en: REPORTED, ar: REPORTED }, 'en')).toBe('');
    expect(pick({ en: PROSE[1] ?? '', ar: PROSE[5] ?? '' }, 'ar')).toBe(PROSE[5]);
  });
});
