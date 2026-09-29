import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELD_CONTRACTS,
  conditionFieldsFor,
  conditionRejection,
  evaluateCondition,
  type AutomationCondition,
} from '@brandspace/automation';
import { conditionsFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * B12 + G13 OPTION (a) (Phase 2B-2b) — the rules, as rules. The database half
 * is `tests/isolation/automations-v2.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

describe('campaign, format and person — the values a rule can name', () => {
  it('are offered on every content trigger, and on nothing else', () => {
    for (const trigger of ['CONTENT_APPROVED', 'CONTENT_SCHEDULED', 'POST_PUBLISHED'] as const) {
      expect(conditionFieldsFor(trigger)).toEqual(
        expect.arrayContaining(['content.campaignId', 'content.type', 'content.authorUserId']),
      );
    }
    for (const trigger of ['ANALYTICS_REFRESHED', 'SCHEDULED_TIME'] as const) {
      expect(conditionFieldsFor(trigger)).not.toContain('content.authorUserId');
    }
  });

  it('format is a closed set; campaign and person are catalogues', () => {
    expect(CONDITION_FIELD_CONTRACTS['content.type'].options).toEqual([
      'POST',
      'CAROUSEL',
      'STORY',
      'REEL',
      'VIDEO',
      'ARTICLE',
      'THREAD',
    ]);
    expect(CONDITION_FIELD_CONTRACTS['content.campaignId'].catalogue).toBe('campaigns');
    expect(CONDITION_FIELD_CONTRACTS['content.authorUserId'].catalogue).toBe('members');
    const reel: AutomationCondition = { field: 'content.type', operator: 'equals', value: 'REEL' };
    expect(conditionRejection(reel, 'CONTENT_APPROVED')).toBeNull();
    expect(
      conditionRejection({ ...reel, value: 'PODCAST' } as AutomationCondition, 'CONTENT_APPROVED'),
    ).toBe('value');
    expect(
      conditionRejection({ ...reel, operator: 'greater_than', value: 3 }, 'CONTENT_APPROVED'),
    ).toBe('operator');
  });

  it('the D-183 decoder reads them like every other field, and fails closed the same way', () => {
    expect(
      conditionsFrom(
        form({ conditionField: 'content.type', conditionOperator: 'in', conditionValue: ['REEL'] }),
      ),
    ).toEqual([{ field: 'content.type', operator: 'in', value: ['REEL'] }]);
    expect(() =>
      conditionsFrom(form({ conditionField: 'content.authorUserId', conditionOperator: 'equals' })),
    ).toThrow();
    expect(() =>
      conditionsFrom(
        form({
          conditionField: 'content.author',
          conditionOperator: 'equals',
          conditionValue: 'x',
        }),
      ),
    ).toThrow();
  });
});

describe('a person who cannot be resolved matches NOTHING', () => {
  const person = 'user-1';
  const operators: AutomationCondition[] = [
    { field: 'content.authorUserId', operator: 'equals', value: person },
    { field: 'content.authorUserId', operator: 'not_equals', value: person },
    { field: 'content.authorUserId', operator: 'in', value: [person] },
    { field: 'content.authorUserId', operator: 'not_in', value: [person] },
  ];

  it('under every operator, whether the fact is null or absent', () => {
    for (const condition of operators) {
      expect(evaluateCondition(condition, { 'content.authorUserId': null })).toBe(false);
      expect(evaluateCondition(condition, {})).toBe(false);
    }
  });

  it('while a resolved person still compares normally', () => {
    const facts = { 'content.authorUserId': 'user-2' };
    expect(operators.map((condition) => evaluateCondition(condition, facts))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  it('and no existing field changed meaning: a missing pillar still differs from "launch"', () => {
    expect(
      evaluateCondition(
        { field: 'content.pillar', operator: 'not_equals', value: 'launch' },
        { 'content.pillar': null },
      ),
    ).toBe(true);
  });
});

describe('the engine paths', () => {
  const engine = read('packages/automation/src/engine.ts');
  const body = (name: string) => {
    const start = engine.indexOf(`async ${name}(`);
    return engine.slice(start, engine.indexOf('\n  }\n', start));
  };

  it('updateEditableRule never takes `enabled`, and writes only against the version read', () => {
    const edit = body('updateEditableRule');
    const signature = edit.slice(0, edit.indexOf('}): Promise'));
    const write = edit.slice(edit.indexOf('updateMany({'), edit.indexOf('written.count'));
    expect(signature).not.toContain('enabled');
    expect(write).not.toContain('enabled');
    expect(edit).toContain('version: input.expectedVersion,');
    expect(edit).toContain('if (written.count !== 1) throw automationRuleVersionConflict();');
  });

  it('skipRun checks exactly what confirmRun checks, and writes CANCELLED', () => {
    const skip = body('skipRun');
    const confirm = body('confirmRun');
    for (const check of [
      // Phase 2B-3 (PR 1): the typed contract, through its one reader.
      'if (!satisfiesActionPermissions(input.actor.permissionKeys, action.permissions)) {',
      'if (!brandInScope(input.actor.brandScope, run.brandId)) throw automationConfirmationRejected();',
    ]) {
      expect(skip).toContain(check);
      expect(confirm).toContain(check);
    }
    expect(skip).toContain("status: 'CANCELLED',");
    expect(skip).toContain("status: 'AWAITING_CONFIRMATION',");
  });
});

describe('the screens', () => {
  it('Home counts only runs whose ACTION the member could take, under automation.read', () => {
    const source = read('apps/dashboard/src/server/command-center.ts');
    expect(source).toContain("{ permissions: ['automation.read'], run: automationsWaiting },");
    const body = source.slice(source.indexOf('async function automationsWaiting('));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain(
      'satisfiesActionPermissions(session.permissionKeys, action.permissions)',
    );
  });

  it('the edit action reads the STORED rule, keeps unshown conditions, and uses updateEditableRule', () => {
    const actions = read('apps/dashboard/src/app/[locale]/automations/actions.ts');
    const start = actions.indexOf('export async function updateAutomationAction');
    const body = actions.slice(start, actions.indexOf('\n}\n', start));
    expect(body).toContain('engine.getRule(ruleId, session.workspace.brandScope)');
    expect(body).toContain('triggerConfigFrom(formData, rule.triggerType)');
    expect(body).toContain("formData.get('conditionsMode') === 'keep' ? undefined");
    expect(body).toContain('engine.updateEditableRule({');
    expect(body).not.toContain('enabled');
  });

  it('Skip goes to the engine, which applies the action gate', () => {
    const actions = read('apps/dashboard/src/app/[locale]/automations/actions.ts');
    const start = actions.indexOf('export async function skipAutomationRunAction');
    const body = actions.slice(start, actions.indexOf('\n}\n', start));
    expect(body).toContain("requireWorkspace(locale, 'automation.read')");
    expect(body).toContain('engine.skipRun({');
  });

  it('a refused skip is audited on its own connection in the dashboard too', () => {
    expect(read('apps/dashboard/src/server/analytics-context.ts')).toContain(
      "action: 'automation.confirmation_refused',",
    );
  });
});
