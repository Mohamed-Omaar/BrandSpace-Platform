import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import { parseAnalyticsPolicy } from '@brandspace/analytics';
import { suggestedFormatOf } from '../../apps/dashboard/src/server/home';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { CONTENT_TYPES } from '../../apps/dashboard/src/app/[locale]/content/content-types';

/**
 * PR E (D-496) — HOME 1, 2 AND 4, the pure half.
 */

const read = (path: string) => readFileSync(path, 'utf8');

describe('Home 4 — the noticed card names the format it suggests (Q4)', () => {
  it('reads a format the Studio offers, and nothing else', () => {
    expect(suggestedFormatOf({ suggestedFormat: 'REEL' })).toBe('REEL');
    expect(suggestedFormatOf({ suggestedFormat: 'CAROUSEL', other: 1 })).toBe('CAROUSEL');
    for (const body of [
      null,
      undefined,
      'REEL',
      {},
      { suggestedFormat: 'reel' },
      { suggestedFormat: 'GIF' },
    ]) {
      expect(suggestedFormatOf(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('has a button for every format, and "Make a post" for none, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const format of CONTENT_TYPES) {
        expect(dictionary[`home.recommended.make.${format}`], `${locale}:${format}`).toBeTruthy();
      }
    }
    expect((messages.en as Record<string, string>)['home.recommended.make.POST']).toBe(
      'Make a post',
    );
    expect((messages.en as Record<string, string>)['home.recommended.make.REEL']).toBe(
      'Make a reel',
    );
  });
});

describe('Home 4 — "Not now" lasts a configured number of days', () => {
  it('defaults to a week, the prototype\'s "We will remind you in a week"', () => {
    expect(parseAnalyticsPolicy(defaultPayload('analytics')).insightSnoozeDays).toBe(7);
  });

  it('is bounded to 1–90 days', () => {
    expect(() => parseAnalyticsPolicy({ insightSnoozeDays: 0 })).toThrow();
    expect(() => parseAnalyticsPolicy({ insightSnoozeDays: 91 })).toThrow();
    expect(parseAnalyticsPolicy({ insightSnoozeDays: 30 }).insightSnoozeDays).toBe(30);
  });

  it('is a decision the review API accepts, under the same confirmation gate', () => {
    const route = read('apps/api/src/routes/analytics.ts');
    expect(route).toContain("decision: z.enum(['accept', 'dismiss', 'seen', 'snooze'])");
    const service = read('packages/analytics/src/insights.ts');
    expect(service).toContain("action: 'insight.snoozed'");
    expect(service).toContain('this.#policy.insightSnoozeDays * 86_400_000');
  });

  it('leaves a snoozed finding out of Home and out of the "insights-new" count', () => {
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    const center = read('apps/dashboard/src/server/command-center.ts');
    for (const source of [home, center]) {
      expect(source).toMatch(/\{ snoozedUntil: null \}, \{ snoozedUntil: \{ lte: /);
    }
  });
});

describe('Home 1, 2 — the named rows and Retry in place', () => {
  it('says each named row in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of [
        'attention.entry.publishing-failed',
        'attention.entry.publishing-failed.bare',
        'attention.entry.schedule-overdue',
        'attention.entry.content-in-review',
        'attention.more',
        'activity.action.insight.snoozed',
      ]) {
        expect(dictionary[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('Retry returns to Home only through the closed set, and asks the pipeline first', () => {
    const actions = read('apps/dashboard/src/app/[locale]/integrations/actions.ts');
    expect(actions).toContain("if (requested === '/overview') return { path: '/overview' };");
    expect(actions).toContain("formData.getAll('jobId').map(String).slice(0, MAX_RETRY_JOBS)");
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toContain('publishRetryRefusal({');
    expect(home).toContain("may('publishing.manage')");
  });
});
