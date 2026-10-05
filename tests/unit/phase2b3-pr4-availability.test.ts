import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPayload } from '@brandspace/config';
import { AUTOMATION_ACTIONS, parseAutomationPolicy } from '@brandspace/automation';
import {
  automationRuleCheck,
  automationRuleCheckFor,
} from '../../apps/api/src/routes/copilot-automation';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 2B-3 PR 4 — THE SCREEN AND THE COPILOT FOLLOW THE SAME AVAILABILITY AS
 * `createRule`.
 *
 * An analytics event with unset thresholds is refused by the engine, so the
 * Automations screen shows it but does not let it be chosen, and the Copilot
 * neither offers it nor admits a rule on it (the D-425 parity). The configured
 * screen is driven end to end in tests/e2e/phase2b3-pr4-analytics-authoring.
 */

const root = path.resolve(__dirname, '../..');
const ANALYTICS = ['WEEKLY_ENGAGEMENT_DROPPED', 'POST_TOP_10_PERCENT'];
const MANAGE = ['automation.manage'];

const unconfigured = parseAutomationPolicy(defaultPayload('automations'));
const configured = parseAutomationPolicy({
  events: {
    weeklyEngagementDrop: { minBaseline: 100 },
    topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
  },
});

// Phase 2B-3 PR 6 — the check also takes the actions the plan includes; these
// tests are about the thresholds, so the workspace is entitled to every action.
const ALL_ENTITLED: ReadonlySet<string> = new Set(AUTOMATION_ACTIONS.map((action) => action.type));

describe('automationRuleCheckFor', () => {
  it('unconfigured: the analytics events are neither offered nor admitted', () => {
    const check = automationRuleCheckFor(unconfigured, ALL_ENTITLED);
    const offered = check.authorablePairs();
    expect(offered.filter((pair) => ANALYTICS.includes(pair.triggerType))).toEqual([]);
    for (const triggerType of ANALYTICS) {
      expect(
        check.admissible({ triggerType, actionType: 'NOTIFY_PERSON', permissionKeys: MANAGE }),
      ).toBe(false);
    }
    // Everything else is exactly the registry's offer.
    expect(offered).toEqual(
      automationRuleCheck.authorablePairs().filter((pair) => !ANALYTICS.includes(pair.triggerType)),
    );
  });

  it('configured: exactly the registry check', () => {
    const check = automationRuleCheckFor(configured, ALL_ENTITLED);
    expect(check.authorablePairs()).toEqual(automationRuleCheck.authorablePairs());
    for (const pair of automationRuleCheck.authorablePairs()) {
      expect(check.admissible({ ...pair, permissionKeys: MANAGE })).toBe(
        automationRuleCheck.admissible({ ...pair, permissionKeys: MANAGE }),
      );
    }
    expect(
      check.admissible({
        triggerType: 'POST_TOP_10_PERCENT',
        actionType: 'MAKE_DRAFT_COPY',
        permissionKeys: MANAGE,
      }),
    ).toBe(
      automationRuleCheck.admissible({
        triggerType: 'POST_TOP_10_PERCENT',
        actionType: 'MAKE_DRAFT_COPY',
        permissionKeys: MANAGE,
      }),
    );
  });

  it('the route builds its check from the tenant automation policy', () => {
    const route = readFileSync(path.join(root, 'apps/api/src/routes/copilot.ts'), 'utf8');
    expect(route).toContain(
      'automationRuleCheckFor(\n    await new TenantAutomationPolicySource(db, currentEnvironment()).load(),',
    );
    expect(route).not.toMatch(
      /import \{[^}]*\bautomationRuleCheck\b[^}]*\} from '\.\/copilot-automation'/,
    );
  });
});

describe('the Automations screen', () => {
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

  it('marks a trigger unavailable by the same verdict `createRule` refuses on', () => {
    const page = read('apps/dashboard/src/app/[locale]/automations/page.tsx');
    expect(page).toContain('unavailable: !triggerAvailable(automationPolicy, trigger.type)');
    expect(page).toContain('automationPolicy: await services.automationPolicy()');
    expect(page).toContain("triggerUnavailable: t('automations.triggerUnavailable')");
  });

  it('shows an unavailable trigger, named, but not choosable', () => {
    const form = read('apps/dashboard/src/app/[locale]/automations/automation-form.tsx');
    expect(form).toContain('disabled={option.unavailable}');
    // Review of #67, round 3 — the tile is named in its own words where it has them.
    expect(form).toMatch(
      /props\.labels\.triggerUnavailable\.replace\(\s*'\{trigger\}',\s*option\.tileLabel \?\? option\.label,?\s*\)/,
    );
  });

  it('says so in both languages, naming the trigger', () => {
    expect(messages.en['automations.triggerUnavailable']).toBe('{trigger} (not available yet)');
    expect(messages.ar['automations.triggerUnavailable']).toBe('{trigger} (غير متاح بعد)');
  });
});
