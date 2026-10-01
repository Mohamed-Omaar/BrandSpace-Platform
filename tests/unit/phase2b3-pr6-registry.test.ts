import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import {
  ACTION_OUTCOME_STATUS,
  AUTOMATION_ACTIONS,
  entitledActionTypes,
  findAction,
  isAuthorablePair,
  parseAutomationPolicy,
} from '@brandspace/automation';
import {
  automationRuleCheck,
  automationRuleCheckFor,
} from '../../apps/api/src/routes/copilot-automation';
import { actionConfigFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * PHASE 2B-3 PR 6 — DRAFT_IDEAS IN THE REGISTRY, AND THE SAME OFFER FROM EVERY
 * DOOR (owner decisions 1 and 11).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const TRIGGERS = [
  'CAMPAIGN_STARTED',
  'WEEKLY_ENGAGEMENT_DROPPED',
  'SCHEDULE_GAP',
  'POST_TOP_10_PERCENT',
  'FACT_EXPIRING',
];

describe('the declaration', () => {
  it('internal, credit-spending, never asks first, no new permission key', () => {
    const action = findAction('DRAFT_IDEAS');
    expect(action).toMatchObject({
      actionClass: 'INTERNAL_REVERSIBLE',
      permissions: { allOf: ['content.create', 'copilot.use'], anyOf: [] },
      entitlements: ['limit.automation_ai_actions'],
      spendsCredits: true,
      asksFirst: false,
      authorable: true,
      executable: true,
      needsContentItem: false,
      catalogue: 'g13',
    });
    expect(action?.authoringTriggers).toEqual(TRIGGERS);
    expect(action?.config.parse({})).toEqual({});
  });

  it('it is the only action that spends credits', () => {
    expect(AUTOMATION_ACTIONS.filter((a) => a.spendsCredits).map((a) => a.type)).toEqual([
      'DRAFT_IDEAS',
    ]);
  });

  it('its six outcomes: four skips that charge nothing, two failures', () => {
    const codes = [
      'monthly_ai_cap_reached',
      'ai_credits_insufficient',
      'no_reviewed_facts',
      'brand_not_active',
      'ai_unavailable',
      'ai_output_unusable',
    ] as const;
    expect(codes.map((code) => ACTION_OUTCOME_STATUS[code])).toEqual([
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
      'FAILED',
      'FAILED',
    ]);
  });
});

describe('entitledActionTypes', () => {
  it('an action without an entitlement is always included; DRAFT_IDEAS only when entitled', async () => {
    const withIt = await entitledActionTypes(async () => true);
    const without = await entitledActionTypes(async (key) => key !== 'limit.automation_ai_actions');
    expect([...withIt]).toEqual(AUTOMATION_ACTIONS.map((a) => a.type));
    expect([...without]).toEqual(
      AUTOMATION_ACTIONS.map((a) => a.type).filter((type) => type !== 'DRAFT_IDEAS'),
    );
  });
});

describe('the Copilot offers and admits exactly what the plan includes', () => {
  const policy = parseAutomationPolicy({
    ...defaultPayload('automations'),
    events: {
      weeklyEngagementDrop: { minBaseline: 100 },
      topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
    },
  });
  const AUTHOR = ['automation.manage', 'content.create', 'copilot.use'];

  it('entitled: the five DRAFT_IDEAS pairs are offered and admitted', async () => {
    const check = automationRuleCheckFor(policy, await entitledActionTypes(async () => true));
    const offered = check
      .authorablePairs()
      .filter((pair) => pair.actionType === 'DRAFT_IDEAS')
      .map((pair) => pair.triggerType);
    expect([...offered].sort()).toEqual([...TRIGGERS].sort());
    for (const triggerType of TRIGGERS) {
      expect(
        check.admissible({ triggerType, actionType: 'DRAFT_IDEAS', permissionKeys: AUTHOR }),
      ).toBe(true);
      // A designer: copilot.use without content.create.
      expect(
        check.admissible({
          triggerType,
          actionType: 'DRAFT_IDEAS',
          permissionKeys: ['automation.manage', 'copilot.use'],
        }),
      ).toBe(false);
    }
  });

  it('not entitled: neither offered nor admitted; everything else unchanged', async () => {
    const entitled = await entitledActionTypes(async () => false);
    const check = automationRuleCheckFor(policy, entitled);
    expect(check.authorablePairs().some((pair) => pair.actionType === 'DRAFT_IDEAS')).toBe(false);
    for (const triggerType of TRIGGERS) {
      expect(isAuthorablePair(triggerType, 'DRAFT_IDEAS')).toBe(true);
      expect(
        check.admissible({ triggerType, actionType: 'DRAFT_IDEAS', permissionKeys: AUTHOR }),
      ).toBe(false);
    }
    expect(check.authorablePairs()).toEqual(
      automationRuleCheck.authorablePairs().filter((pair) => pair.actionType !== 'DRAFT_IDEAS'),
    );
  });

  it('the route and the screen ask the same plan question; createRule asks it too', () => {
    const route = read('apps/api/src/routes/copilot.ts');
    expect(route).toContain('await entitledActionTypes((featureKey) =>');
    expect(route).toContain('entitlements: entitlementGate(db, workspaceId)');
    const page = read('apps/dashboard/src/app/[locale]/automations/page.tsx');
    expect(page).toContain('entitledActions: await entitledActionTypes((featureKey) =>');
    expect(page).toContain('entitledActions.has(action.type)');
    const engine = read('packages/automation/src/engine.ts');
    expect(engine).toContain(
      'if (await this.#entitlementRefusal(action)) throw unknownTriggerOrAction();',
    );
  });
});

describe('the Automations form', () => {
  it('reads DRAFT_IDEAS as no settings, and every authorable action is handled', () => {
    expect(actionConfigFrom(new FormData(), 'DRAFT_IDEAS')).toEqual({});
    for (const action of AUTOMATION_ACTIONS.filter((entry) => entry.authorable)) {
      const form = new FormData();
      form.set('actionUserId', '00000000-0000-4000-8000-000000000001');
      form.set('actionCampaignId', '00000000-0000-4000-8000-000000000002');
      expect(() => actionConfigFrom(form, action.type), action.type).not.toThrow();
    }
  });
});
