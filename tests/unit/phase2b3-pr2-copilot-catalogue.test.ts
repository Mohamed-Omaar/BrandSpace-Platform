import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AutomationActionType, AutomationTrigger } from '@prisma/client';
import { findAction, findTrigger, isAuthorablePair } from '@brandspace/automation';
import { automationRuleCatalogueLines } from '@brandspace/copilot';
import { ALL_PERMISSIONS } from '@brandspace/shared';
import { automationRuleCheck } from '../../apps/api/src/routes/copilot-automation';

/**
 * PHASE 2B-3 PR 2 — THE COPILOT'S RULE TOOL OFFERS AND ACCEPTS EXACTLY THE
 * REGISTRY'S AUTHORABLE CATALOGUE.
 *
 * The reference set is computed here from `isAuthorablePair` over EVERY value
 * of both database enums — legacy, G13, planned and retired alike — so the
 * test fails if the Copilot's offer, its acceptance, or the registry drifts
 * from the others, in either direction.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const key = (triggerType: string, actionType: string) => `${triggerType} -> ${actionType}`;

const REGISTRY_PAIRS = new Set(
  Object.values(AutomationTrigger).flatMap((trigger) =>
    Object.values(AutomationActionType)
      .filter((action) => isAuthorablePair(trigger, action))
      .map((action) => key(trigger, action)),
  ),
);

const EVERY_PERMISSION = ALL_PERMISSIONS.map((permission) => permission.key);

describe('the offer is the registry’s authorable set', () => {
  const offered = automationRuleCheck.authorablePairs();

  it('equals the isAuthorablePair set, pair for pair', () => {
    expect(new Set(offered.map((pair) => key(pair.triggerType, pair.actionType)))).toEqual(
      REGISTRY_PAIRS,
    );
    // No pair is offered twice.
    expect(offered).toHaveLength(REGISTRY_PAIRS.size);
  });

  it('is not empty, and offers no retired legacy half', () => {
    expect(REGISTRY_PAIRS.size).toBeGreaterThan(0);
    for (const pair of offered) {
      expect(findTrigger(pair.triggerType)?.authorable).toBe(true);
      expect(findAction(pair.actionType)?.authorable).toBe(true);
    }
  });

  it('after the PR 2 flip: no legacy pair, and the G13 pairs are there', () => {
    const offeredKeys = offered.map((pair) => key(pair.triggerType, pair.actionType));
    for (const legacyAction of [
      'NOTIFY',
      'SUBMIT_FOR_APPROVAL',
      'PLACE_ON_CALENDAR',
      'PROPOSE_PUBLISH',
    ]) {
      expect(offeredKeys.some((entry) => entry.endsWith(` -> ${legacyAction}`))).toBe(false);
    }
    for (const legacyTrigger of [
      'CONTENT_SCHEDULED',
      'ANALYTICS_REFRESHED',
      'METRIC_THRESHOLD_CROSSED',
      'SCHEDULED_TIME',
    ]) {
      expect(offeredKeys.some((entry) => entry.startsWith(`${legacyTrigger} -> `))).toBe(false);
    }
    expect(offeredKeys).toContain('CONTENT_APPROVED -> SCHEDULE_NEXT_FREE_SLOT');
    expect(offeredKeys).toContain('POST_FAILED -> NOTIFY_PERSON');
  });
});

describe('the acceptance is the same set, and still asks the caller’s authority', () => {
  it('with every permission, admissible is true for exactly the registry’s pairs', () => {
    const accepted = new Set<string>();
    for (const trigger of Object.values(AutomationTrigger)) {
      for (const action of Object.values(AutomationActionType)) {
        if (
          automationRuleCheck.admissible({
            triggerType: trigger,
            actionType: action,
            permissionKeys: EVERY_PERMISSION,
          })
        ) {
          accepted.add(key(trigger, action));
        }
      }
    }
    expect(accepted).toEqual(REGISTRY_PAIRS);
  });

  it('an offered pair is refused to a caller without the action’s own permission', () => {
    for (const pair of automationRuleCheck.authorablePairs()) {
      expect(
        automationRuleCheck.admissible({ ...pair, permissionKeys: ['automation.manage'] }),
      ).toBe(false);
    }
  });

  it('unknown names are refused', () => {
    expect(
      automationRuleCheck.admissible({
        triggerType: 'NOT_A_TRIGGER',
        actionType: 'NOTIFY_PERSON',
        permissionKeys: EVERY_PERMISSION,
      }),
    ).toBe(false);
  });
});

describe('the prompt offers the same pairs, and the Copilot holds no names of its own', () => {
  it('one catalogue line per offered pair, from the injected check', () => {
    const lines = automationRuleCatalogueLines(automationRuleCheck);
    const listed = lines.slice(1).map((line) => line.trim());
    expect(new Set(listed)).toEqual(REGISTRY_PAIRS);
    expect(listed).toHaveLength(REGISTRY_PAIRS.size);
    expect(automationRuleCatalogueLines(undefined)).toEqual([]);
  });

  it('the orchestrator prints the catalogue under the rule tool, and the API injects it', () => {
    const orchestrator = readFileSync(
      path.join(root, 'packages/copilot/src/orchestrator.ts'),
      'utf8',
    );
    expect(orchestrator).toContain('automationRuleCatalogueLines(this.#automationRules)');
    const route = readFileSync(path.join(root, 'apps/api/src/routes/copilot.ts'), 'utf8');
    const constructions = route.match(/new CopilotOrchestrator\(\{[^}]*\}\)/g) ?? [];
    expect(constructions.length).toBeGreaterThan(0);
    for (const construction of constructions) {
      expect(construction).toContain('automationRules: automationRuleCheck');
    }
  });

  it('no trigger or action name is written as a string anywhere in the Copilot package', () => {
    const names = [...Object.values(AutomationTrigger), ...Object.values(AutomationActionType)];
    const directory = path.join(root, 'packages/copilot/src');
    for (const file of readdirSync(directory).filter((entry) => entry.endsWith('.ts'))) {
      const source = readFileSync(path.join(directory, file), 'utf8');
      for (const name of names) {
        expect(source, `${file}: ${name}`).not.toMatch(new RegExp(`['"]${name}['"]`));
      }
    }
  });
});
