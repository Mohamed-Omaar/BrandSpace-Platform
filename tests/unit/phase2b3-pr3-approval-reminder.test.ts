import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_KEYS,
  categoryOf,
} from '@brandspace/notifications';
import { AUTOMATION_NOTIFY_TEMPLATES, findAction } from '@brandspace/automation';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 2B-3 PR 3 — THE `approval.reminder` TEMPLATE (owner decisions B and D).
 *
 * One more review notice, in the approvals category a person mutes with the
 * others, with the approved words in both languages. It is NOT a template a
 * NOTIFY rule may send: D-412's list stays `['automation.notice']`.
 */

describe('approval.reminder', () => {
  it('is in the closed catalogue, informational, and muted with the other review notices', () => {
    expect(NOTIFICATION_TEMPLATE_KEYS).toContain('approval.reminder');
    expect(NOTIFICATION_TEMPLATES['approval.reminder']).toEqual({ severity: 'info' });
    expect(categoryOf('approval.reminder')).toBe('approvals');
  });

  it('carries the approved English and Arabic', () => {
    expect(messages.en['notifications.template.approval.reminder']).toBe(
      'A post is still waiting for your review',
    );
    expect(messages.ar['notifications.template.approval.reminder']).toBe(
      'لا يزال منشور بانتظار مراجعتك',
    );
  });

  it('is not a template a NOTIFY rule may send (D-412 unchanged, decision B)', () => {
    expect(AUTOMATION_NOTIFY_TEMPLATES).toEqual(['automation.notice']);
    expect(
      findAction('NOTIFY')!.config.safeParse({ templateKey: 'approval.reminder' }).success,
    ).toBe(false);
  });
});
