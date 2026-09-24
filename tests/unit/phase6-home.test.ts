import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  ATTENTION_ACTIONS,
  HOME_RECOMMENDATIONS,
  RECOMMENDATION_INSIGHT_TYPES,
  attentionAction,
  greetingName,
  greetingPeriod,
  groupByDay,
  hourIn,
  relativeTime,
  safeZone,
  shouldInviteSetup,
} from '../../apps/dashboard/src/server/home';

/**
 * PHASE 6 FINAL · D-277 §7 — HOME.
 *
 * Home answers "what needs me now, what should I do next, what did BrandSpace
 * notice", in that order, from the modules that own each answer. These tests
 * pin the presentation rules (greeting, relative time, day groups, one action
 * per attention row, when setup is offered) and the page's composition.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const PAGE = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
const CENTER = read('apps/dashboard/src/server/command-center.ts');

describe('D-277 §7 · the greeting', () => {
  it('morning, afternoon and evening on the workspace clock', () => {
    expect(greetingPeriod(5)).toBe('morning');
    expect(greetingPeriod(11)).toBe('morning');
    expect(greetingPeriod(12)).toBe('afternoon');
    expect(greetingPeriod(17)).toBe('afternoon');
    expect(greetingPeriod(18)).toBe('evening');
    expect(greetingPeriod(2)).toBe('evening');
  });

  it('reads the hour in the workspace’s zone, and survives a bad zone', () => {
    const noonUtc = new Date('2026-09-24T12:00:00.000Z');
    expect(hourIn(noonUtc, 'UTC')).toBe(12);
    expect(hourIn(noonUtc, 'Asia/Riyadh')).toBe(15);
    expect(hourIn(noonUtc, 'Not/AZone')).toBe(12);
    expect(safeZone('Not/AZone')).toBe('UTC');
  });

  it('greets by first name, or not by name at all — never by an email address', () => {
    expect(greetingName('Mona Al Harbi')).toBe('Mona');
    expect(greetingName('  ')).toBeNull();
    expect(greetingName(null)).toBeNull();
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const period of ['morning', 'afternoon', 'evening']) {
        expect(dictionary[`home.greeting.${period}`]).toContain('{name}');
        expect(dictionary[`home.greeting.${period}.plain`]).not.toContain('{name}');
      }
    }
  });
});

describe('D-277 §7 · presentation helpers', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');

  it('relative time in the reader’s language', () => {
    expect(relativeTime(new Date('2026-09-24T11:57:00.000Z'), now, 'en')).toBe('3 minutes ago');
    expect(relativeTime(new Date('2026-09-23T12:00:00.000Z'), now, 'en')).toBe('yesterday');
    expect(relativeTime(new Date('2026-09-24T11:57:00.000Z'), now, 'ar')).toMatch(/[؀-ۿ]/);
  });

  it('groups the week by the day in the workspace’s zone, not UTC', () => {
    const rows = [
      new Date('2026-09-24T20:30:00.000Z'), // 23:30 in Riyadh
      new Date('2026-09-24T21:30:00.000Z'), // 00:30 the next day in Riyadh
    ];
    expect(groupByDay(rows, (d) => d, 'UTC')).toHaveLength(1);
    expect(groupByDay(rows, (d) => d, 'Asia/Riyadh')).toHaveLength(2);
  });
});

describe('D-277 §7 A · every attention row offers one action', () => {
  it('every kind the Command Center raises has a verb, in both languages', () => {
    const kinds = [
      ...CENTER.matchAll(/kind: '([a-z-]+)'/g),
      ...read('apps/dashboard/src/server/performance-patterns.ts').matchAll(
        /'(performance-[a-z]+)'/g,
      ),
    ].map((match) => match[1] as string);
    expect(kinds.length).toBeGreaterThan(10);
    for (const kind of new Set(kinds)) {
      expect(ATTENTION_ACTIONS[kind], kind).toBeDefined();
      for (const locale of ['en', 'ar'] as const) {
        const dictionary = messages[locale] as Record<string, string>;
        expect(
          dictionary[`home.action.${attentionAction(kind)}`],
          `${locale}:${kind}`,
        ).toBeTruthy();
      }
    }
  });

  it('failures and account health point at Publishing, and need its permission', () => {
    expect(CENTER).toMatch(/kind: 'publishing-failed'[^}]*href: '\/publishing\?tab=failed'/);
    expect(CENTER).toMatch(/kind: 'connection-reauth'[^}]*href: '\/publishing\?tab=accounts'/);
    expect(CENTER).toMatch(
      /permissions: \['content\.read', 'publishing\.read'\], run: publishingFailures/,
    );
    expect(CENTER).toMatch(
      /permissions: \['integrations\.read', 'publishing\.read'\], run: connectionsNeedingReauth/,
    );
  });
});

describe('D-277 §7 · setup is offered, and then it stops', () => {
  it('without a brand, always', () => {
    expect(shouldInviteSetup({ hasBrand: false, sources: 0, connections: 0, hasGoal: false })).toBe(
      true,
    );
  });
  it('with a brand and nothing after it, yes', () => {
    expect(shouldInviteSetup({ hasBrand: true, sources: 0, connections: 0, hasGoal: false })).toBe(
      true,
    );
  });
  it('once anything after the brand exists, never again', () => {
    expect(shouldInviteSetup({ hasBrand: true, sources: 1, connections: 0, hasGoal: false })).toBe(
      false,
    );
    expect(shouldInviteSetup({ hasBrand: true, sources: 0, connections: 1, hasGoal: false })).toBe(
      false,
    );
    expect(shouldInviteSetup({ hasBrand: true, sources: 0, connections: 0, hasGoal: true })).toBe(
      false,
    );
  });
});

describe('D-277 §7 · the page, in the owner’s order', () => {
  it('A needs → B recommended → C notes → D coming up → E performance', () => {
    const order = [
      'testId="attention-card"',
      'testId="home-recommended"',
      'testId="home-notes"',
      'testId="overview-upcoming"',
      'testId="overview-metrics"',
    ].map((marker) => PAGE.indexOf(marker));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('shows at most three recommendations, only of the recommendation kinds', () => {
    expect(HOME_RECOMMENDATIONS).toBeLessThanOrEqual(3);
    expect(RECOMMENDATION_INSIGHT_TYPES).toEqual(['RECOMMENDATION', 'OPPORTUNITY', 'CONTENT_GAP']);
    expect(PAGE).toMatch(/take: HOME_RECOMMENDATIONS/);
    expect(PAGE).toMatch(/status: \{ in: \['NEW', 'SEEN'\] \}/);
  });

  it('dismissing returns to Home only through a closed set', () => {
    const actions = read('apps/dashboard/src/app/[locale]/intelligence/actions.ts');
    expect(actions).toMatch(
      /formData\.get\('returnTo'\) === '\/overview' \? '\/overview' : '\/intelligence'/,
    );
  });

  it('account facts left Home: plan, credits, members, activity, notification count', () => {
    for (const gone of [
      'metric-plan',
      'metric-credits',
      'metric-members',
      'overview-activity',
      'overview-notifications',
      'overview-identity',
    ]) {
      expect(PAGE, gone).not.toContain(gone);
    }
  });

  it('the hero’s floating cards carry real figures, not a decorative chart', () => {
    expect(PAGE).not.toMatch(/HeroMiniChart/);
    expect(PAGE).not.toMatch(/overview\.metric\.laterPhase/);
  });
});
