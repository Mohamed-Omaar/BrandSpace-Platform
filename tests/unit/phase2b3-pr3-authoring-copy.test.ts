import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { actionConfigFrom } from '../../apps/dashboard/src/server/automation-form';
import { runPresentation } from '../../apps/dashboard/src/server/automation-run-display';

/**
 * PHASE 2B-3 PR 3 — THE AUTHORING SCREEN'S NEW WORDS AND SETTINGS.
 *
 * Every string approved as written (owner decision D), in both languages, and
 * the two run outcomes REMIND_REVIEWER adds reading as decided: "Skipped" for
 * a review decided first, BLOCKED for nobody able to decide it.
 */

const APPROVED: Record<string, readonly [string, string]> = {
  'automations.trigger.REVIEW_WAITING_24H': [
    // Round 4 (5.2): the prototype's title ('A post waits for review over 24 hours').
    'When a post waits for review over 24 hours',
    'عند انتظار منشور للمراجعة أكثر من 24 ساعة',
  ],
  'automations.trigger.CAMPAIGN_STARTED': ['When a campaign starts', 'عند بدء حملة'],
  'automations.trigger.CAMPAIGN_ENDED': ['When a campaign ends', 'عند انتهاء حملة'],
  'automations.trigger.SCHEDULE_GAP': [
    'When nothing is scheduled for the next 3 days',
    'عند عدم جدولة أي منشور للأيام الثلاثة القادمة',
  ],
  'automations.trigger.FACT_EXPIRING': [
    'When a Brand Brain fact expires within 7 days',
    'عند اقتراب انتهاء صلاحية معلومة في عقل العلامة خلال 7 أيام',
  ],
  'automations.action.REMIND_REVIEWER': ['Remind the reviewer', 'تذكير المراجِع'],
  'automations.field.campaign.id': ['Campaign', 'الحملة'],
  'notifications.template.approval.reminder': [
    'A post is still waiting for your review',
    'لا يزال منشور بانتظار مراجعتك',
  ],
  'automations.failure.occurrence_stale': [
    'Skipped — what started this automation had changed by the time it ran.',
    'تم التخطي — تغيّر ما أطلق هذه الأتمتة قبل تشغيلها.',
  ],
  'automations.failure.no_eligible_reviewer': [
    'Not sent — no one who can review this post is available right now.',
    'لم يُرسل — لا يوجد حاليًا من يمكنه مراجعة هذا المنشور.',
  ],
};

describe('the approved copy (decision D)', () => {
  it('every new string, exactly, in English and Arabic', () => {
    for (const [key, [en, ar]] of Object.entries(APPROVED)) {
      expect((messages.en as Record<string, string>)[key], key).toBe(en);
      expect((messages.ar as Record<string, string>)[key], key).toBe(ar);
    }
  });
});

describe('how the two reminder outcomes read in run history', () => {
  it('a review decided first: the "Skipped" badge, with its reason', () => {
    expect(runPresentation({ status: 'SKIPPED', failureCode: 'occurrence_stale' })).toEqual({
      statusKey: 'automations.status.actionSkipped',
      reason: { kind: 'message', key: 'automations.failure.occurrence_stale' },
    });
  });

  it('nobody able to decide it: BLOCKED, with its reason', () => {
    expect(
      runPresentation({ status: 'BLOCKED_BY_POLICY', failureCode: 'no_eligible_reviewer' }),
    ).toEqual({
      statusKey: 'automations.status.BLOCKED_BY_POLICY',
      reason: { kind: 'message', key: 'automations.failure.no_eligible_reviewer' },
    });
  });
});

describe('REMIND_REVIEWER on the authoring screen', () => {
  it('takes no settings: who is reminded is decided when it runs', () => {
    expect(actionConfigFrom(new FormData(), 'REMIND_REVIEWER')).toEqual({});
  });
});
