import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import { parseAutomationPolicy, triggerAvailable } from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 4 — THE ANALYTICS EVENTS' THRESHOLDS ARE CONFIGURATION WITH NO
 * DEFAULT (report §30), AND AN EVENT IS AVAILABLE ONLY WHEN EVERY THRESHOLD IT
 * READS IS SET.
 */

describe('the automations `events` block', () => {
  it('has no default threshold: a fresh installation evaluates neither event', () => {
    const policy = parseAutomationPolicy(defaultPayload('automations'));
    expect(policy.events).toEqual({ weeklyEngagementDrop: {}, topPost: {} });
    expect(triggerAvailable(policy, 'WEEKLY_ENGAGEMENT_DROPPED')).toBe(false);
    expect(triggerAvailable(policy, 'POST_TOP_10_PERCENT')).toBe(false);
  });

  it('accepts whole positive thresholds and refuses anything else', () => {
    const ok = parseConfigPayload('automations', {
      events: {
        weeklyEngagementDrop: { minBaseline: 50 },
        topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
      },
    });
    expect(ok).toMatchObject({
      events: {
        weeklyEngagementDrop: { minBaseline: 50 },
        topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
      },
    });
    for (const bad of [
      { weeklyEngagementDrop: { minBaseline: 0 } },
      { weeklyEngagementDrop: { minBaseline: 1.5 } },
      { topPost: { populationDays: 0 } },
      { topPost: { populationDays: 366 } },
      { topPost: { minImpressions: -1 } },
      { topPost: { minPopulation: 0 } },
    ]) {
      expect(
        () => parseConfigPayload('automations', { events: bad }),
        JSON.stringify(bad),
      ).toThrow();
    }
  });
});

describe('triggerAvailable', () => {
  const policy = (events: unknown) => parseAutomationPolicy({ events });

  it('the weekly drop needs its baseline', () => {
    expect(
      triggerAvailable(
        policy({ weeklyEngagementDrop: { minBaseline: 1 } }),
        'WEEKLY_ENGAGEMENT_DROPPED',
      ),
    ).toBe(true);
  });

  it('the top 10% needs all three of its thresholds', () => {
    const all = { populationDays: 30, minImpressions: 100, minPopulation: 10 };
    expect(triggerAvailable(policy({ topPost: all }), 'POST_TOP_10_PERCENT')).toBe(true);
    for (const missing of ['populationDays', 'minImpressions', 'minPopulation'] as const) {
      const partial: Record<string, number> = { ...all };
      delete partial[missing];
      expect(triggerAvailable(policy({ topPost: partial }), 'POST_TOP_10_PERCENT'), missing).toBe(
        false,
      );
    }
  });

  it('every other trigger is always available', () => {
    const none = policy({});
    for (const type of [
      'CONTENT_APPROVED',
      'REVIEW_WAITING_24H',
      'SCHEDULE_GAP',
      'FACT_EXPIRING',
    ]) {
      expect(triggerAvailable(none, type), type).toBe(true);
    }
  });
});
