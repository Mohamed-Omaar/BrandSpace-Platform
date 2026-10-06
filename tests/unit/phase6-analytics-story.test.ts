import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  measuredChanges,
  parseExplanation,
  pickText,
} from '../../apps/dashboard/src/server/analytics-story';

/**
 * PHASE 6 FINAL · D-277 §34-§36, D-293.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('D-293 · what changed is measured, not written', () => {
  it('reports the largest movements first, and ignores noise and the incomparable', () => {
    const changes = measuredChanges([
      { metricKey: 'reach', changeMilli: 40 },
      { metricKey: 'engagements', changeMilli: -310 },
      { metricKey: 'impressions', changeMilli: 120 },
      { metricKey: 'engagement_rate', changeMilli: null },
    ]);
    expect(changes).toEqual([
      { metricKey: 'engagements', changeMilli: -310 },
      { metricKey: 'impressions', changeMilli: 120 },
    ]);
  });
});

describe('D-293 · a stored explanation is read defensively', () => {
  it('keeps cited lines and drops malformed ones', () => {
    const parsed = parseExplanation({
      summary: { en: 'Education led.' },
      notableChanges: [{ evidenceRefs: [1, 'x', 0], text: { en: 'Saves up.' } }, { text: {} }],
      claims: 'nope',
      recommendations: [{ evidenceRefs: [2], text: { ar: 'جرّب' } }],
    });
    expect(parsed.notableChanges).toHaveLength(1);
    expect(parsed.notableChanges[0]?.evidenceRefs).toEqual([1]);
    expect(parsed.claims).toEqual([]);
    expect(pickText(parsed.recommendations[0]?.text, 'en')).toBe('جرّب');
    expect(parseExplanation(null).summary).toBeNull();
  });
});

describe('D-293 · the screens', () => {
  const analytics = read('apps/dashboard/src/app/[locale]/analytics/page.tsx');
  const intelligence = read('apps/dashboard/src/app/[locale]/intelligence/page.tsx');

  /*
   * REPLACED (D-468, batch 4): the story still comes before the figures; the
   * export, which D-293 put last, now sits in the prototype's head row with
   * the views and the period (`Main.dc.html` line 670).
   */
  /*
   * REPLACED (review of #67): the prototype's Numbers tab opens on the KPI
   * cards, and its layout wins over D-293's order — the story now follows the
   * figures. Export stays in the head row.
   */
  it('Analytics draws the story on the Insights tab, and Export in the head row', () => {
    // Round 4 (5.6): the Numbers tab draws only the numbers; the story leads
    // the Insights tab (and stays under the numbers for a member who cannot
    // read insights).
    const story = analytics.indexOf('analytics-what-changed');
    const metrics = analytics.indexOf('analytics-metric-');
    const head = analytics.indexOf('data-testid="analytics-filters"');
    const exported = analytics.lastIndexOf('data-testid="analytics-export"');
    expect(story).toBeGreaterThan(0);
    expect(metrics).toBeGreaterThan(0);
    expect(analytics).toContain('{mayReadInsights ? null : story}');
    expect(analytics).toMatch(/<>\s*\{story\}/);
    expect(exported).toBeGreaterThan(head);
    expect(exported).toBeLessThan(metrics);
  });

  it('Analytics says correlation, not cause', () => {
    expect(analytics).toContain("t('analytics.story.correlation')");
    expect(messages.en['analytics.story.correlation']).toMatch(/not proof/);
  });

  it('Intelligence shows confidence only where one was computed', () => {
    expect(intelligence).toMatch(/insight\.confidenceMilli === null\s*\?\s*\[\]/);
  });

  it('every new string exists in both languages', () => {
    const keys = [
      ...analytics.matchAll(/'(analytics\.story\.[\w]+)'/g),
      ...intelligence.matchAll(/'(intelligence\.(?:scope|confidence|loopStep)[\w.]*)'/g),
    ].map((match) => match[1]!);
    for (const step of ['detected', 'evidence', 'proposed', 'reviewed', 'remembered']) {
      keys.push(`intelligence.loopStep.${step}`);
    }
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect((messages.en as Record<string, string>)[key], key).toBeTruthy();
      expect((messages.ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
