import { describe, expect, it } from 'vitest';
import { ACTION_OUTCOME_STATUS } from '@brandspace/automation';
import { messages, translator } from '../../apps/dashboard/src/i18n/messages';
import {
  EXISTING_REACHABLE_CODES,
  runPresentation,
} from '../../apps/dashboard/src/server/automation-run-display';
import { actionConfigFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * PHASE 2B-3, PR 2 — RUN HISTORY IN WORDS (owner decision D5-B), AND THE
 * AUTHORING SCREEN'S NEW COPY.
 *
 * The strings below are the owner-approved §13 copy of the PR 2 report,
 * exactly. Every code a PR 2 rule can end with reads in the reader's
 * language; any other code reads the fallback; no reason line prints a code.
 */

/** code → [English, Arabic], exactly as approved. */
const COPY: Record<string, readonly [string, string]> = {
  already_has_time: [
    "Skipped — this post already has a date and time, so it wasn't moved.",
    'تم التخطي — لهذا المنشور موعد محدد بالفعل، لذلك لم يُنقل.',
  ],
  already_in_campaign: [
    'Skipped — this post is already in a campaign. Automations only add posts that have none.',
    'تم التخطي — هذا المنشور ضمن حملة بالفعل. تضيف الأتمتة فقط المنشورات التي ليست ضمن أي حملة.',
  ],
  content_in_review: [
    "Skipped — this post is waiting for review, so it wasn't changed.",
    'تم التخطي — هذا المنشور بانتظار المراجعة، لذلك لم يُعدَّل.',
  ],
  content_not_editable: [
    "Skipped — this post is publishing or already published and can't be changed.",
    'تم التخطي — هذا المنشور قيد النشر أو منشور بالفعل ولا يمكن تعديله.',
  ],
  content_unavailable: [
    'Skipped — the post this event is about is no longer available.',
    'تم التخطي — المنشور المعني بهذا الحدث لم يعد متاحًا.',
  ],
  no_free_day: [
    'Not scheduled — no free day was found within the scheduling window.',
    'لم تتم الجدولة — لم يُعثر على يوم متاح ضمن نافذة الجدولة.',
  ],
  approval_required: [
    "Not scheduled — this brand requires approval before scheduling, and the post isn't approved.",
    'لم تتم الجدولة — تتطلب هذه العلامة التجارية الاعتماد قبل الجدولة، والمنشور غير معتمد.',
  ],
  schedule_quota_reached: [
    "Not scheduled — your plan's limit on scheduled posts has been reached.",
    'لم تتم الجدولة — تم بلوغ حد المنشورات المجدولة في خطتك.',
  ],
  channel_disconnected: [
    "Not scheduled — one of this post's channels has no connected account.",
    'لم تتم الجدولة — إحدى قنوات هذا المنشور ليس لها حساب متصل.',
  ],
  not_schedulable: [
    "Not scheduled — the post isn't in a state that can be scheduled.",
    'لم تتم الجدولة — حالة المنشور لا تسمح بجدولته.',
  ],
  recipient_unavailable: [
    'Not sent — the person this automation notifies is no longer an active member with access to this brand. Edit the rule to choose someone else.',
    'لم يُرسل — الشخص الذي تنبّهه هذه الأتمتة لم يعد عضوًا نشطًا له صلاحية على هذه العلامة التجارية. عدّل القاعدة واختر شخصًا آخر.',
  ],
  campaign_unavailable: [
    "Not added — the campaign this automation adds posts to no longer exists or isn't in this brand. Edit the rule to choose a current one.",
    'لم تتم الإضافة — الحملة التي تضيف إليها هذه الأتمتة المنشورات لم تعد موجودة أو ليست ضمن هذه العلامة التجارية. عدّل القاعدة واختر حملة حالية.',
  ],
  source_campaign_unavailable: [
    "No copy made — the original post's campaign no longer exists.",
    'لم تُنشأ نسخة — حملة المنشور الأصلي لم تعد موجودة.',
  ],
  draft_limit_reached: [
    'No copy made — this brand has reached its limit of drafts.',
    'لم تُنشأ نسخة — بلغت هذه العلامة التجارية الحد الأقصى للمسودات.',
  ],
  // Phase 2B-3 PR 3 — approved as written (owner decision D).
  occurrence_stale: [
    'Skipped — what started this automation had changed by the time it ran.',
    'تم التخطي — تغيّر ما أطلق هذه الأتمتة قبل تشغيلها.',
  ],
  no_eligible_reviewer: [
    'Not sent — no one who can review this post is available right now.',
    'لم يُرسل — لا يوجد حاليًا من يمكنه مراجعة هذا المنشور.',
  ],
  creator_no_longer_a_member: [
    'Not run — the person who created this automation is no longer a member of the workspace.',
    'لم تُشغَّل — منشئ هذه الأتمتة لم يعد عضوًا في مساحة العمل.',
  ],
  creator_lost_permission: [
    'Not run — the person who created this automation no longer has permission for this action.',
    'لم تُشغَّل — منشئ هذه الأتمتة لم تعد لديه صلاحية هذا الإجراء.',
  ],
  creator_lost_brand_scope: [
    'Not run — the person who created this automation no longer has access to this brand.',
    'لم تُشغَّل — منشئ هذه الأتمتة لم يعد لديه وصول إلى هذه العلامة التجارية.',
  ],
  workspace_pending_deletion: [
    'Not run — this workspace is scheduled for deletion.',
    'لم تُشغَّل — مساحة العمل هذه مجدولة للحذف.',
  ],
  daily_ceiling_reached: [
    'Not run — this automation reached its daily limit of runs.',
    'لم تُشغَّل — بلغت هذه الأتمتة حدها اليومي من مرات التشغيل.',
  ],
  // Phase 2B-3 PR 5 (owner decision D2).
  rule_disabled: [
    'Not done — this automation was switched off or deleted before it was approved.',
    'لم يُنفَّذ — أُوقفت هذه الأتمتة أو حُذفت قبل الموافقة عليها.',
  ],
  fallback: ['Something went wrong running this automation.', 'حدث خطأ أثناء تشغيل هذه الأتمتة.'],
};

const LABELS: Record<string, readonly [string, string]> = {
  'automations.trigger.POST_FAILED': ['When a post fails to publish', 'عند فشل نشر منشور'],
  'automations.action.SCHEDULE_NEXT_FREE_SLOT': [
    'Schedule in the next free slot',
    'جدولة في أول موعد متاح',
  ],
  'automations.action.NOTIFY_PERSON': ['Notify a chosen person', 'تنبيه شخص محدد'],
  'automations.action.ADD_TO_CAMPAIGN': ['Add to a campaign', 'إضافة إلى حملة'],
  'automations.action.MAKE_DRAFT_COPY': ['Make a draft copy', 'إنشاء نسخة مسودة'],
  'automations.actionPersonLabel': ['Person to notify', 'الشخص المراد تنبيهه'],
  'automations.actionCampaignLabel': ['Campaign', 'الحملة'],
  'automations.status.actionSkipped': ['Skipped', 'تم التخطي'],
};

describe('the approved copy, in English and Arabic', () => {
  it('every run-history reason, exactly', () => {
    for (const [code, [en, ar]] of Object.entries(COPY)) {
      expect(translator('en')(`automations.failure.${code}` as never), code).toBe(en);
      expect(translator('ar')(`automations.failure.${code}` as never), code).toBe(ar);
      for (const text of [en, ar]) expect(text, code).not.toContain('_');
    }
  });

  it('every new label, exactly', () => {
    for (const [key, [en, ar]] of Object.entries(LABELS)) {
      expect((messages.en as Record<string, string>)[key], key).toBe(en);
      expect((messages.ar as Record<string, string>)[key], key).toBe(ar);
    }
  });

  it('covers every typed outcome and the existing reachable codes, and nothing is left raw', () => {
    expect(Object.keys(COPY).sort()).toEqual(
      [...Object.keys(ACTION_OUTCOME_STATUS), ...EXISTING_REACHABLE_CODES, 'fallback'].sort(),
    );
  });
});

describe('runPresentation (D5-B)', () => {
  it('an action-level SKIPPED reads "Skipped" — never "Conditions did not hold" — with its reason', () => {
    for (const [code, status] of Object.entries(ACTION_OUTCOME_STATUS)) {
      const shown = runPresentation({ status, failureCode: code });
      expect(shown.reason, code).toEqual({ kind: 'message', key: `automations.failure.${code}` });
      expect(shown.statusKey, code).toBe(
        status === 'SKIPPED' ? 'automations.status.actionSkipped' : `automations.status.${status}`,
      );
    }
    expect(messages.en['automations.status.actionSkipped']).not.toBe(
      messages.en['automations.status.SKIPPED'],
    );
  });

  it('the existing reachable codes keep their badges and gain their words', () => {
    for (const [code, status] of [
      ['creator_no_longer_a_member', 'BLOCKED_BY_AUTHORIZATION'],
      ['creator_lost_permission', 'BLOCKED_BY_AUTHORIZATION'],
      ['creator_lost_brand_scope', 'BLOCKED_BY_AUTHORIZATION'],
      ['workspace_pending_deletion', 'BLOCKED_BY_POLICY'],
      ['daily_ceiling_reached', 'BLOCKED_BY_POLICY'],
    ] as const) {
      expect(runPresentation({ status, failureCode: code })).toEqual({
        statusKey: `automations.status.${status}`,
        reason: { kind: 'message', key: `automations.failure.${code}` },
      });
    }
  });

  it('any other code reads the fallback; a typed outcome under the wrong status too', () => {
    for (const [status, code] of [
      ['FAILED', 'validation_failed'],
      ['FAILED', 'internal'],
      ['EXPIRED', 'confirmation_expired'],
      ['FAILED', 'no_free_day'],
    ] as const) {
      expect(runPresentation({ status, failureCode: code }).reason).toEqual({
        kind: 'message',
        key: 'automations.failure.fallback',
      });
    }
  });

  it('no code, a condition that did not hold, and a member’s own skip have no reason line', () => {
    expect(runPresentation({ status: 'SUCCEEDED', failureCode: null }).reason).toEqual({
      kind: 'none',
    });
    expect(runPresentation({ status: 'SKIPPED', failureCode: null })).toEqual({
      statusKey: 'automations.status.SKIPPED',
      reason: { kind: 'none' },
    });
    expect(
      runPresentation({ status: 'CANCELLED', failureCode: 'skipped_by_member' }).reason,
    ).toEqual({
      kind: 'none',
    });
  });
});

describe('the authoring screen’s action settings (actionConfigFrom)', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  it('reads the picked person and campaign, and nothing for the setting-free actions', () => {
    expect(actionConfigFrom(form({ actionUserId: 'u-1' }), 'NOTIFY_PERSON')).toEqual({
      userId: 'u-1',
    });
    expect(actionConfigFrom(form({ actionCampaignId: 'c-1' }), 'ADD_TO_CAMPAIGN')).toEqual({
      campaignId: 'c-1',
    });
    expect(actionConfigFrom(form({}), 'SCHEDULE_NEXT_FREE_SLOT')).toEqual({});
    expect(actionConfigFrom(form({}), 'MAKE_DRAFT_COPY')).toEqual({});
  });

  it('refuses a missing or blank pick rather than defaulting it', () => {
    expect(() => actionConfigFrom(form({}), 'NOTIFY_PERSON')).toThrow();
    expect(() => actionConfigFrom(form({ actionUserId: '  ' }), 'NOTIFY_PERSON')).toThrow();
    expect(() => actionConfigFrom(form({}), 'ADD_TO_CAMPAIGN')).toThrow();
  });

  it('refuses every action a new rule cannot take', () => {
    for (const type of [
      'NOTIFY',
      'SUBMIT_FOR_APPROVAL',
      'PLACE_ON_CALENDAR',
      'PROPOSE_PUBLISH',
      'X',
    ]) {
      expect(() => actionConfigFrom(form({}), type), type).toThrow();
    }
  });
});
