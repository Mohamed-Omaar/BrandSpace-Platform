import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAppError } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { actionConfigFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * PHASE 2B-3 PR 2 — A NEW RULE HAS NO SILENT DEFAULT.
 *
 * The form used to preselect the first trigger and the trigger's first
 * action. After the G13 flip that action is SCHEDULE_NEXT_FREE_SLOT, so a rule
 * saved and switched on without looking at the action scheduled every post it
 * matched — which is how an E2E suite's rule scheduled another suite's post.
 * Both pickers now start on an empty "Choose …" option and are required, and
 * the server refuses a post that names no action.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const form = readFileSync(
  path.join(root, 'apps/dashboard/src/app/[locale]/automations/automation-form.tsx'),
  'utf8',
);

describe('the form starts with nothing chosen', () => {
  it('a new rule’s trigger and action start empty', () => {
    expect(form).toContain("useState(initial?.triggerType ?? '')");
    expect(form).toContain("useState(initial?.actionType ?? '')");
    // No fallback to the first trigger, or to the trigger's first action.
    expect(form).not.toMatch(/props\.triggers\[0\]/);
    expect(form).not.toMatch(/actionTypes\[0\]/);
  });

  it('both choice groups are required, and nothing in them starts chosen', () => {
    // D-468: the event and the action are the prototype's grids of radio
    // choices; no empty "Choose …" option leads them, so nothing is checked.
    for (const [testId, name, checked] of [
      ['automation-trigger', 'triggerType', 'checked={triggerType === option.type}'],
      ['automation-action', 'actionType', 'checked={actionType === type}'],
    ] as const) {
      const start = form.indexOf(`data-testid="${testId}"`);
      expect(start).toBeGreaterThan(0);
      const group = form.slice(start, form.indexOf('</div>', start));
      expect(group).toContain(`name="${name}"`);
      expect(group).toMatch(/\brequired\b/);
      expect(group).toContain(checked);
      expect(group).not.toContain('defaultChecked');
    }
  });

  it('the browser’s refusal is said in the page’s language', () => {
    expect(form).toContain("setCustomValidity(triggerType === '' ? props.labels.chooseTrigger");
    expect(form).toContain("setCustomValidity(actionType === '' ? props.labels.chooseAction");
  });
});

describe('the words, in both languages', () => {
  it('"Choose an action" / «اختر إجراءً», and the trigger’s own', () => {
    const en = messages.en as Record<string, string>;
    const ar = messages.ar as Record<string, string>;
    expect(en['automations.chooseAction']).toBe('Choose an action');
    expect(ar['automations.chooseAction']).toBe('اختر إجراءً');
    expect(en['automations.chooseTrigger']).toBe('Choose an event');
    expect(ar['automations.chooseTrigger']).toBe('اختر حدثًا');
  });
});

describe('the server refuses a rule that names no action', () => {
  it('an empty action is refused before the engine is asked, never defaulted', () => {
    let refused: unknown;
    try {
      actionConfigFrom(new FormData(), '');
    } catch (error: unknown) {
      refused = error;
    }
    expect(isAppError(refused)).toBe(true);
    expect((refused as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('the create action decodes the action before it reaches the engine', () => {
    const actions = readFileSync(
      path.join(root, 'apps/dashboard/src/app/[locale]/automations/actions.ts'),
      'utf8',
    );
    const create = actions.slice(
      actions.indexOf('export async function createAutomationAction'),
      actions.indexOf('await engine.createRule'),
    );
    expect(create).toContain('actionConfigFrom(formData, actionType)');
  });
});
