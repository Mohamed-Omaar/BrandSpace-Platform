import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PlanDetail } from '@brandspace/entitlements';
import { simpleCopy } from '../../apps/admin/src/i18n/simple';
import {
  PLAN_AI_CAP_FIELDS,
  planAiCapValue,
  readPlanAiCap,
  readPlanAiCaps,
} from '../../apps/admin/src/server/plan-ai-cap';
import { describePlanChanges } from '../../apps/admin/src/server/plan-diff';

/**
 * PHASE 2B-3 PR 6 — THE AI AUTOMATION CAP IN CONTROL CENTER (D-458).
 *
 * The simple and the Advanced editor post the same two fields, and the save
 * action LEAVES OUT a cap that is not set: absent is off, `null` would not be.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('reading the cap from a form', () => {
  it('not set is undefined, so the field is left out', () => {
    expect(readPlanAiCap(form({}), 'automationAiActionsPerMonth')).toBeUndefined();
    expect(
      readPlanAiCap(
        form({ 'aiCap.automationAiActionsPerMonth.kind': '' }),
        'automationAiActionsPerMonth',
      ),
    ).toBeUndefined();
    expect(readPlanAiCaps(form({}))).toEqual({});
  });

  it('limited carries its number; unlimited carries none', () => {
    expect(
      readPlanAiCaps(
        form({
          'aiCap.automationAiActionsPerMonth.kind': 'limited',
          'aiCap.automationAiActionsPerMonth.value': '4',
          'aiCap.trialAutomationAiActionsPerMonth.kind': 'unlimited',
          'aiCap.trialAutomationAiActionsPerMonth.value': '7',
        }),
      ),
    ).toEqual({
      automationAiActionsPerMonth: { kind: 'limited', value: 4 },
      trialAutomationAiActionsPerMonth: { kind: 'unlimited' },
    });
  });

  it('a limited cap without a whole number, or an unknown kind, is refused', () => {
    for (const entries of [
      { 'aiCap.automationAiActionsPerMonth.kind': 'limited' },
      {
        'aiCap.automationAiActionsPerMonth.kind': 'limited',
        'aiCap.automationAiActionsPerMonth.value': '2.5',
      },
      { 'aiCap.automationAiActionsPerMonth.kind': 'some' },
    ]) {
      expect(() => readPlanAiCaps(form(entries))).toThrow();
    }
  });

  it('both editors post the same field names, and the save action spreads them', () => {
    const simple = read('apps/admin/src/components/simple/plans.tsx');
    const advanced = read('apps/admin/src/app/[locale]/console/plans/page.tsx');
    for (const source of [simple, advanced]) {
      expect(source).toContain('name={`aiCap.${field}.kind`}');
      expect(source).toContain('name={`aiCap.${field}.value`}');
    }
    expect(read('apps/admin/src/app/[locale]/console/plans/actions.ts')).toContain(
      '...readPlanAiCaps(formData)',
    );
  });
});

const plan = (quotas: Partial<PlanDetail['quotas']>): PlanDetail =>
  ({
    key: 'fixture',
    nameEn: 'Fixture',
    nameAr: 'تجريبية',
    status: 'active',
    visibility: 'public',
    prices: [],
    trialDays: 0,
    trialCredits: 0,
    monthlyCredits: 0,
    quotas: {
      seats: null,
      brands: null,
      socialAccounts: null,
      scheduledPostsPerMonth: null,
      storageGb: null,
      analyticsRetentionDays: null,
      workspaces: null,
      automationAiActionsPerMonth: null,
      trialAutomationAiActionsPerMonth: null,
      ...quotas,
    },
  }) as unknown as PlanDetail;

describe('the change list names cap changes, off distinct from unlimited', () => {
  it('reads a cap as a number, null (unlimited) or off', () => {
    expect(planAiCapValue(null)).toBe('off');
    expect(planAiCapValue(undefined)).toBe('off');
    expect(planAiCapValue({ kind: 'unlimited' })).toBeNull();
    expect(planAiCapValue({ kind: 'limited', value: 2 })).toBe(2);
  });

  it('off → limited, and limited → unlimited, are both reported', () => {
    const changes = describePlanChanges(
      [plan({ trialAutomationAiActionsPerMonth: { kind: 'limited', value: 2 } })],
      [
        plan({
          automationAiActionsPerMonth: { kind: 'limited', value: 4 },
          trialAutomationAiActionsPerMonth: { kind: 'unlimited' },
        }),
      ],
    );
    expect(changes[0]?.changes).toEqual([
      { field: 'automationAiActionsPerMonth', before: 'off', after: 4 },
      { field: 'trialAutomationAiActionsPerMonth', before: 2, after: null },
    ]);
  });

  it('an unchanged cap reports nothing', () => {
    const same = plan({ automationAiActionsPerMonth: { kind: 'limited', value: 4 } });
    expect(describePlanChanges([same], [same])).toEqual([]);
  });
});

describe('copy, en and ar', () => {
  it('every new key has both languages, and they differ', () => {
    const en = simpleCopy('en');
    const ar = simpleCopy('ar');
    for (const key of [
      ...PLAN_AI_CAP_FIELDS.map((field) => `quota.${field}` as const),
      'plans.aiCap.title',
      'plans.aiCap.hint',
      'plans.aiCap.off',
      'plans.aiCap.limited',
      'plans.aiCap.value',
    ] as const) {
      expect(en(key).length, key).toBeGreaterThan(0);
      expect(ar(key).length, key).toBeGreaterThan(0);
      expect(ar(key), key).not.toBe(en(key));
    }
    expect(en('plans.aiCap.off')).toBe('Not set (off)');
    expect(ar('plans.aiCap.off')).toBe('غير محدد (متوقف)');
  });
});
