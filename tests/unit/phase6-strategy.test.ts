import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceLabel, messages } from '../../apps/dashboard/src/i18n/messages';
import {
  campaignHref,
  contentHref,
  leadingChannels,
  parseStrategyBody,
  pick,
} from '../../apps/dashboard/src/server/strategy-view';

/**
 * PHASE 6 FINAL · D-277 §13, D-292 — STRATEGY AS A PLAN.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const body = {
  summary: { en: 'Teach first, sell second.', ar: 'علّم أولًا ثم بِع.' },
  pillars: [
    {
      name: { en: 'Education', ar: 'تعليم' },
      sharePercent: 60,
      rationale: { evidenceRefs: [1, 2], text: { en: 'Saves rose.', ar: 'زادت الحفظات.' } },
    },
    { name: { en: 'Broken' }, sharePercent: 'forty' },
  ],
  channelMix: [
    { platformKey: 'linkedin', sharePercent: 20, rationale: { evidenceRefs: [], text: {} } },
    { platformKey: 'instagram', sharePercent: 80, rationale: { evidenceRefs: [3], text: {} } },
    { platformKey: 'Not A Key!', sharePercent: 5 },
  ],
  monthlyPlan: [
    {
      weekNumber: 2,
      theme: { en: 'Signs your cat is unwell', ar: 'علامات مرض قطتك' },
      postsPlanned: 3.4,
      rationale: { evidenceRefs: [1], text: { en: 'Top saves.', ar: 'أعلى حفظ.' } },
    },
    { weekNumber: 1, theme: { en: 'Meet the team', ar: '' }, postsPlanned: 2, rationale: {} },
  ],
};

describe('D-292 · a stored strategy is read defensively', () => {
  it('keeps what is well-formed and drops what is not — never guesses', () => {
    const parsed = parseStrategyBody(body);
    expect(parsed.pillars).toHaveLength(1);
    expect(parsed.channelMix.map((c) => c.platformKey)).toEqual(['linkedin', 'instagram']);
    expect(parsed.monthlyPlan.map((w) => w.weekNumber)).toEqual([1, 2]);
    expect(parsed.monthlyPlan[1]?.postsPlanned).toBe(3);
    expect(parsed.pillars[0]?.rationale.evidenceRefs).toEqual([1, 2]);
  });

  it('an empty or foreign body is an empty plan, not an error', () => {
    for (const value of [null, 'text', [], { pillars: 'x' }]) {
      const parsed = parseStrategyBody(value);
      expect(parsed.summary).toBeNull();
      expect(parsed.pillars).toEqual([]);
      expect(parsed.monthlyPlan).toEqual([]);
    }
  });

  it('reads in the reader’s language, falling back to the other', () => {
    const week = parseStrategyBody(body).monthlyPlan[0];
    expect(pick(week?.theme, 'ar')).toBe('Meet the team');
    expect(pick(week?.theme, 'en')).toBe('Meet the team');
  });
});

describe('D-292 · a week of the plan opens work, it does not create it', () => {
  const plan = parseStrategyBody(body);
  const week = plan.monthlyPlan[1]!;

  it('Create campaign pre-fills the form with the theme, goal and leading channels', () => {
    const href = new URL(
      campaignHref({ locale: 'en', week, channels: leadingChannels(plan), objective: 'AWARENESS' }),
      'http://x',
    );
    expect(href.pathname).toBe('/en/campaigns/new');
    expect(href.searchParams.get('name')).toBe('Signs your cat is unwell');
    expect(href.searchParams.get('objective')).toBe('AWARENESS');
    expect(href.searchParams.getAll('channels')).toEqual(['instagram', 'linkedin']);
  });

  it('Send to Content opens Create Post with the theme as the brief', () => {
    const href = new URL(contentHref({ locale: 'ar', week }), 'http://x');
    expect(href.pathname).toBe('/ar/content/compose');
    expect(href.searchParams.get('mode')).toBe('ai');
    expect(href.searchParams.get('brief')).toContain('علامات مرض قطتك');
  });

  it('the campaign form only accepts the prefill from closed sets', () => {
    const form = read('apps/dashboard/src/app/[locale]/campaigns/new/page.tsx');
    expect(form).toContain('CAMPAIGN_OBJECTIVES.includes');
    expect(form).toMatch(/platforms\.some\(\(platform\) => platform\.key === key\)/);
  });
});

describe('D-292 · the page', () => {
  const page = read('apps/dashboard/src/app/[locale]/strategy/page.tsx');

  it('draws the plan from the ACCEPTED strategy only; proposals are listed apart', () => {
    expect(page).toContain("type: 'STRATEGY', status: 'ACCEPTED'");
    expect(page).toContain("status: { in: ['NEW', 'SEEN'] }");
  });

  it('no screen prints an evidence labelKey as copy (§41)', () => {
    for (const file of [
      'apps/dashboard/src/app/[locale]/strategy/page.tsx',
      'apps/dashboard/src/app/[locale]/intelligence/page.tsx',
    ]) {
      expect(read(file)).not.toMatch(/:\s*row\.labelKey\}/);
    }
    for (const key of [
      'content.none_in_window',
      'content.pillar_unpublished',
      'content.platform_unused',
      'content.top_performer',
      'knowledge.approved',
      'metric.period_change',
      'metric.total',
      'metric.anomaly_above',
      'metric.anomaly_below',
    ]) {
      expect(evidenceLabel('en', key)).not.toBe(evidenceLabel('en', 'unknown'));
      expect(evidenceLabel('ar', key)).toBeTruthy();
    }
  });

  it('opens Copilot on the strategy surface', () => {
    expect(page).toContain("copilotHref(locale, 'strategy')");
  });

  it('every new Strategy string exists in both languages', () => {
    const keys = [...page.matchAll(/t\('(strategy\.[\w.]+)'\)/g)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect((messages.en as Record<string, string>)[key], key).toBeTruthy();
      expect((messages.ar as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});
