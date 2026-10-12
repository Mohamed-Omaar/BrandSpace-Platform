import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { campaignTimeline } from '../../apps/dashboard/src/server/strategy-view';
import {
  OWN_GOAL_MAX,
  ownGoalKnowledge,
  ownGoalText,
} from '../../apps/dashboard/src/server/setup-wizard-state';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR E (D-496) — the pure halves of Strategy 6, Auth 8, Studio S9, Settings 3,
 * Shell 1–2 and the first-visit hints.
 */

const read = (path: string) => readFileSync(path, 'utf8');
const NOW = new Date('2026-10-11T12:00:00.000Z');
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('Strategy 6 — the three-month timeline keeps the prototype geometry', () => {
  const base = { deletedAt: null };
  const { months, rows } = campaignTimeline(
    [
      {
        ...base,
        id: 'run',
        name: 'Run',
        status: 'ACTIVE',
        startDate: d('2026-10-05'),
        endDate: d('2026-11-01'),
      },
      {
        ...base,
        id: 'early',
        name: 'Early',
        status: 'PAUSED',
        startDate: d('2026-09-05'),
        endDate: d('2026-12-26'),
      },
      {
        ...base,
        id: 'plan',
        name: 'Plan',
        status: 'PLANNED',
        startDate: d('2026-12-30'),
        endDate: d('2027-02-01'),
      },
      {
        ...base,
        id: 'done',
        name: 'Done',
        status: 'COMPLETED',
        startDate: d('2026-10-01'),
        endDate: d('2026-10-01'),
      },
      {
        ...base,
        id: 'out',
        name: 'Out',
        status: 'ACTIVE',
        startDate: d('2027-02-08'),
        endDate: d('2027-03-09'),
      },
      { ...base, id: 'nodate', name: 'No date', status: 'ACTIVE', startDate: null, endDate: null },
      {
        id: 'gone',
        name: 'Gone',
        status: 'ARCHIVED',
        startDate: d('2026-10-05'),
        endDate: d('2026-10-09'),
        deletedAt: d('2026-10-10'),
      },
    ],
    NOW,
  );

  it('spans this month and the next two', () => {
    expect(months.map((m) => m.toISOString().slice(0, 7))).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
  });

  it('draws only campaigns with both dates inside the window, archived never', () => {
    expect(rows.map((row) => row.id)).toEqual(['early', 'done', 'run', 'plan']);
  });

  it('left and width are the prototype formula (span 92 days), with a 3% floor', () => {
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    // The prototype's own first campaign: 5 Oct – 1 Nov → left 4%, width 30%.
    expect([by['run']!.left, by['run']!.width]).toEqual([4, 30]);
    // Clamped to the window's start.
    expect(by['early']!.left).toBe(0);
    // A one-day campaign is still visible.
    expect(by['done']!.width).toBe(3);
  });

  it('kinds follow the statuses', () => {
    expect(Object.fromEntries(rows.map((row) => [row.id, row.kind]))).toEqual({
      early: 'paused',
      done: 'always',
      run: 'run',
      plan: 'plan',
    });
  });
});

describe('Auth 8 — a typed goal', () => {
  it('is stored as its own words in both languages, inside the usual sentence', () => {
    const knowledge = ownGoalKnowledge('Open a second branch');
    expect(knowledge.title).toEqual({ en: 'Open a second branch', ar: 'Open a second branch' });
    expect(knowledge.body.en).toContain('Open a second branch');
    expect(knowledge.body.ar).toContain('Open a second branch');
  });

  it('is read back only when the stored goal is not one of ours', () => {
    expect(ownGoalText({ title: { en: 'Open a second branch' } }, null)).toBe(
      'Open a second branch',
    );
    expect(ownGoalText({ title: { en: 'Get more leads' } }, 'LEADS')).toBeNull();
    expect(ownGoalText({ title: { ar: 'فرع ثانٍ' } }, null)).toBe('فرع ثانٍ');
    expect(ownGoalText(null, null)).toBeNull();
  });

  it('the action takes `own` only with words, bounded like the field', () => {
    const action = read('apps/dashboard/src/app/[locale]/onboarding/actions.ts');
    expect(action).toContain('.slice(0, OWN_GOAL_MAX)');
    expect(action).toMatch(/formData\.get\('goal'\) === 'own'\s*\?\s*ownWords === ''\s*\?\s*null/);
    expect(OWN_GOAL_MAX).toBe(120);
  });
});

describe('Studio S9 — the recommended hashtag range is configuration', () => {
  const content = defaultPayload('content') as { platforms: Record<string, unknown>[] };
  const withRange = (range: unknown, maxHashtags = 30) => ({
    ...content,
    platforms: content.platforms.map((platform, index) =>
      index === 0 ? { ...platform, maxHashtags, recommendedHashtags: range } : platform,
    ),
  });

  it('is absent by default, so nothing is invented', () => {
    for (const platform of content.platforms)
      expect(platform['recommendedHashtags']).toBeUndefined();
  });

  it('accepts a range within the ceiling', () => {
    expect(() => parseConfigPayload('content', withRange({ min: 3, max: 5 }))).not.toThrow();
  });

  it('refuses an upside-down range or one above the ceiling', () => {
    expect(() => parseConfigPayload('content', withRange({ min: 6, max: 5 }))).toThrow();
    expect(() => parseConfigPayload('content', withRange({ min: 3, max: 40 }, 30))).toThrow();
  });
});

describe('every new word in both languages', () => {
  it('Settings 3, Strategy 6, Auth 8, Shell 1–2, the hints and S9', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of [
        'aiSettings.draftsToReview',
        'aiSettings.draftsToReviewHint',
        'strategy.timeline.title',
        'strategy.timeline.viewAll',
        'strategy.timeline.none',
        'setup.wz.goal.addOwn',
        'setup.wz.goal.ownPh',
        'setup.wz.goal.add',
        'notes.pop.all',
        'notes.pop.on',
        'notes.pop.empty',
        'hint.close',
        'hint.brain',
        'hint.strategy',
        'studio.tags.recommended',
      ]) {
        expect(dictionary[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});

describe('Settings 3 — new brands start on, existing brands keep the default', () => {
  it('brand creation writes the switch on; the column default stays off', () => {
    expect(read('apps/dashboard/src/server/brand-creation.ts')).toContain(
      'aiDraftsToReview: true,',
    );
    expect(read('packages/database/prisma/schema.prisma')).toMatch(
      /aiDraftsToReview\s+Boolean\s+@default\(false\)/,
    );
  });

  it('an AI draft goes to review only through the existing submit path, with content.submit', () => {
    const helper = read('apps/dashboard/src/server/ai-drafts-review.ts');
    expect(helper).toContain("resolveApiWorkspace('content.submit')");
    expect(helper).toContain('await services.approvals()');
    expect(helper).toContain("origin: 'AI_GENERATED'");
    expect(helper).toContain("status: 'DRAFT'");
  });
});
