import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_NOTIFY_TEMPLATES,
  NOTIFY_TEMPLATE_NOT_ALLOWED,
  findAction,
  isAutomationNotifyTemplate,
  type AutomationNotificationTemplate,
} from '@brandspace/automation';
import {
  NOTIFICATION_TEMPLATE_KEYS,
  categoryOf,
  mutedRecipients,
  type NotificationTemplateKey,
} from '@brandspace/notifications';
import { runPresentation } from '../../apps/dashboard/src/server/automation-run-display';
import { translator } from '../../apps/dashboard/src/i18n/messages';

/**
 * FIX PR 1 · F5 (D-412) — WHAT A NOTIFY RULE MAY SEND, AND WHY THE MUTE FILTER
 * CAN NO LONGER LOSE ITS CATEGORY.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// COMPILE-TIME: every template the automation engine can send is a real
// catalogue key. If this line stops compiling, a key outside the catalogue has
// entered the union — the exact thing `as never` used to hide.
const everyAutomationTemplateIsReal: NotificationTemplateKey =
  'automation.notice' as AutomationNotificationTemplate;

describe('F5 · the closed set', () => {
  it('is exactly automation.notice (owner decision A)', () => {
    expect([...AUTOMATION_NOTIFY_TEMPLATES]).toEqual(['automation.notice']);
    expect(everyAutomationTemplateIsReal).toBe('automation.notice');
  });

  it('every key in it is a catalogue template a person can mute', () => {
    for (const key of AUTOMATION_NOTIFY_TEMPLATES) {
      expect(NOTIFICATION_TEMPLATE_KEYS).toContain(key);
      expect(categoryOf(key)).toBe('automations');
    }
  });

  it("NOTIFY's settings schema refuses anything else", () => {
    const notify = findAction('NOTIFY');
    expect(notify).toBeTruthy();
    expect(notify!.config.safeParse({ templateKey: 'automation.notice' }).success).toBe(true);
    for (const templateKey of [
      'workspace.deletion_requested',
      'automation.confirmation_required',
      'approval.requested',
      'not.a.template',
      '',
    ]) {
      expect(notify!.config.safeParse({ templateKey }).success, templateKey).toBe(false);
    }
    expect(notify!.config.safeParse({}).success).toBe(false);
  });

  it('isAutomationNotifyTemplate agrees with the schema', () => {
    expect(isAutomationNotifyTemplate('automation.notice')).toBe(true);
    expect(isAutomationNotifyTemplate('automation.confirmation_required')).toBe(false);
    expect(isAutomationNotifyTemplate(undefined)).toBe(false);
    expect(isAutomationNotifyTemplate(42)).toBe(false);
  });
});

describe('F5 · the categoryOf() undefined case is unreachable', () => {
  it('mutedRecipients refuses a key the catalogue does not classify, before any query', async () => {
    const db = {
      notificationPreference: {
        findMany: () => {
          throw new Error('the query must never run for an unclassified key');
        },
      },
    };
    await expect(
      mutedRecipients(db as never, 'ws', ['u'], 'not.a.template' as NotificationTemplateKey),
    ).rejects.toThrow(/not in the catalogue/);
  });

  it('the worker passes the template with no cast', () => {
    const worker = readFileSync(
      path.join(root, 'apps/worker/src/processors/automation.ts'),
      'utf8',
    );
    expect(worker).not.toContain('templateKey: input.templateKey as never');
    expect(worker).toContain('templateKey: input.templateKey,');
  });

  it('the engine checks a stored NOTIFY rule before any action runs', () => {
    const engine = readFileSync(path.join(root, 'packages/automation/src/engine.ts'), 'utf8');
    const check = engine.indexOf("rule.actionType === 'NOTIFY' &&");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(engine.indexOf('const result = await this.#performInternal('));
    expect(engine).not.toContain("String(config['templateKey'])");
  });
});

describe('F5 · Run history says why, in both languages', () => {
  it('a FAILED notify_template_not_allowed run keeps its badge and gets the owner-approved reason', () => {
    const shown = runPresentation({ status: 'FAILED', failureCode: NOTIFY_TEMPLATE_NOT_ALLOWED });
    expect(shown.statusKey).toBe('automations.status.FAILED');
    expect(shown.reason).toEqual({
      kind: 'message',
      key: 'automations.failure.notify_template_not_allowed',
    });
    expect(translator('en')('automations.failure.notify_template_not_allowed')).toBe(
      "Not sent — this automation names a notification that automations can't send. Delete it and create it again.",
    );
    expect(translator('ar')('automations.failure.notify_template_not_allowed')).toBe(
      'لم يُرسل — تذكر هذه الأتمتة إشعارًا لا يمكن للأتمتة إرساله. احذفها وأنشئها من جديد.',
    );
  });

  it('any other FAILED run keeps its badge and reads the approved fallback, never the code', () => {
    // Phase 2B-3 PR 2 (D5-B): no raw code in Run history.
    expect(runPresentation({ status: 'FAILED', failureCode: 'unknown_action' })).toEqual({
      statusKey: 'automations.status.FAILED',
      reason: { kind: 'message', key: 'automations.failure.fallback' },
    });
  });
});
