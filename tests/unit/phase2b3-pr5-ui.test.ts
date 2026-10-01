import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { messages, translator } from '../../apps/dashboard/src/i18n/messages';
import {
  requestLine,
  runPresentation,
  waitingHint,
} from '../../apps/dashboard/src/server/automation-run-display';
import { actionConfigFrom } from '../../apps/dashboard/src/server/automation-form';

/**
 * PHASE 2B-3 PR 5 — THE SCREEN OF THE RETRY AND THE PAUSE.
 *
 * The strings below are the owner-approved §6 copy of the PR 5 report,
 * exactly, in both languages; a lapsed request says so in words; the form
 * reads the campaign a pause names and nothing for a retry; and the confirm
 * action's gate is the floor, with only SUCCEEDED reported as done.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');
const en = translator('en');
const ar = translator('ar');

/** key → [English, Arabic], exactly as approved. */
const COPY: Record<string, readonly [string, string]> = {
  'automations.action.RETRY_PUBLISH': [
    'Retry the failed post',
    'إعادة محاولة نشر المنشور المتعثّر',
  ],
  'automations.action.PAUSE_CAMPAIGN': ['Pause a campaign', 'إيقاف حملة مؤقتًا'],
  'automations.approveRun': ['Approve', 'موافقة'],
  'automations.skipRun': ['Skip', 'تخطٍّ'],
  'automations.confirmRun': ['Confirm publish', 'تأكيد النشر'],
  'automations.needsYou.retry': ['Retry "{content}"', 'إعادة محاولة «{content}»'],
  'automations.needsYou.pause': [
    'Pause the campaign "{campaign}"',
    'إيقاف الحملة «{campaign}» مؤقتًا',
  ],
  'automations.pauseNote': [
    'Pausing marks the campaign as paused. Posts already scheduled still go out.',
    'الإيقاف يضع الحملة في حالة «متوقفة». المنشورات المجدولة تُنشر كما هي.',
  ],
  'automations.failure.confirmation_window_closed': [
    'Nobody approved this in the time allowed, so nothing was done.',
    'لم يوافق عليه أحد خلال المهلة، فلم يُنفَّذ شيء.',
  ],
  // Owner decisions on #63: the hint for a pause, and a campaign the reader cannot see.
  'automations.confirmNeedsCampaignPermission': [
    'Waiting for a member who may manage this campaign.',
    'في انتظار عضو يملك صلاحية إدارة هذه الحملة.',
  ],
  'automations.needsYou.pauseUnavailable': [
    'Pause a campaign (not available)',
    'إيقاف حملة (غير متاحة)',
  ],
  'automations.failure.rule_disabled': [
    'Not done — this automation was switched off or deleted before it was approved.',
    'لم يُنفَّذ — أُوقفت هذه الأتمتة أو حُذفت قبل الموافقة عليها.',
  ],
  'automations.approvedBy': ['Approved by {name}', 'وافق عليه {name}'],
  'automations.skippedBy': ['Skipped by {name}', 'تخطّاه {name}'],
  'activity.action.automation.run_confirmed': [
    'An automation request was approved',
    'تمت الموافقة على طلب أتمتة',
  ],
  'activity.action.automation.run_skipped': [
    'An automation request was skipped',
    'تم تخطي طلب أتمتة',
  ],
  'activity.action.automation.run_expired': [
    'An automation request lapsed',
    'انتهت مهلة طلب أتمتة',
  ],
};

describe('the approved copy, in both languages', () => {
  for (const [key, [english, arabic]] of Object.entries(COPY)) {
    it(key, () => {
      expect(en(key as never)).toBe(english);
      expect(ar(key as never)).toBe(arabic);
    });
  }
});

describe('en and ar parity for every PR 5 key', () => {
  it('each key exists, non-empty, in both languages', () => {
    const catalogue = messages as unknown as Record<'en' | 'ar', Record<string, string>>;
    for (const key of Object.keys(COPY)) {
      expect(catalogue.en[key], `en ${key}`).toEqual(expect.any(String));
      expect(catalogue.ar[key], `ar ${key}`).toEqual(expect.any(String));
      expect(catalogue.en[key]!.length, `en ${key}`).toBeGreaterThan(0);
      expect(catalogue.ar[key]!.length, `ar ${key}`).toBeGreaterThan(0);
    }
  });
});

describe('who a waiting request waits for (waitingHint)', () => {
  it('a pause: a member who may manage the campaign — its action’s campaigns.manage', () => {
    expect(waitingHint('PAUSE_CAMPAIGN')).toBe('automations.confirmNeedsCampaignPermission');
  });

  it('a publish or a retry: a member who may publish, as before', () => {
    expect(waitingHint('PROPOSE_PUBLISH')).toBe('automations.confirmNeedsPermission');
    expect(waitingHint('RETRY_PUBLISH')).toBe('automations.confirmNeedsPermission');
  });

  it('an action without a required permission, or an unknown one, gets no hint', () => {
    expect(waitingHint('NOTIFY_PERSON')).toBeNull();
    expect(waitingHint('NOT_AN_ACTION')).toBeNull();
  });

  it('the page shows it only to a reader who cannot decide the request', () => {
    const page = source('apps/dashboard/src/app/[locale]/automations/page.tsx');
    expect(page).toContain('proposals.has(run.id) && !mayDecide(run.actionType)');
    expect(page).toContain('waitingHint(run.actionType)');
    expect(page).not.toContain("t('automations.confirmNeedsPermission')");
  });
});

describe('what a request would do (requestLine)', () => {
  it('a pause names the campaign the reader can see', () => {
    expect(requestLine('PAUSE_CAMPAIGN', { content: null, campaign: 'Spring' })).toEqual({
      key: 'automations.needsYou.pause',
      token: '{campaign}',
      value: 'Spring',
    });
  });

  it('a campaign deleted or outside the reader’s brands: one neutral label, no name', () => {
    for (const proposal of [undefined, { content: null, campaign: null }]) {
      const line = requestLine('PAUSE_CAMPAIGN', proposal);
      expect(line).toEqual({ key: 'automations.needsYou.pauseUnavailable' });
      expect('value' in line).toBe(false);
    }
    expect(en('automations.needsYou.pauseUnavailable')).not.toContain('—');
  });

  it('the page reads campaigns through the reader’s scope and never prints a placeholder name', () => {
    const page = source('apps/dashboard/src/app/[locale]/automations/page.tsx');
    expect(page).toContain("run.resourceType === 'Campaign'");
    expect(page).not.toContain("proposal?.campaign ?? '—'");
  });

  it('a retry and a publish name their post, or say it is not available', () => {
    expect(requestLine('RETRY_PUBLISH', { content: 'Post', campaign: null })).toEqual({
      key: 'automations.needsYou.retry',
      token: '{content}',
      value: 'Post',
    });
    expect(requestLine('PROPOSE_PUBLISH', { content: 'Post', campaign: null })).toEqual({
      key: 'automations.previewContent',
      token: '{content}',
      value: 'Post',
    });
    expect(requestLine('RETRY_PUBLISH', { content: null, campaign: null })).toEqual({
      key: 'automations.previewUnknown',
    });
  });
});

describe('a lapsed request reads in words', () => {
  it('EXPIRED with confirmation_window_closed: its own reason, the Expired badge', () => {
    expect(
      runPresentation({ status: 'EXPIRED', failureCode: 'confirmation_window_closed' }),
    ).toEqual({
      statusKey: 'automations.status.EXPIRED',
      reason: { kind: 'message', key: 'automations.failure.confirmation_window_closed' },
    });
  });

  it('the same code under another status is not a lapse: the fallback', () => {
    expect(
      runPresentation({ status: 'FAILED', failureCode: 'confirmation_window_closed' }).reason,
    ).toEqual({ kind: 'message', key: 'automations.failure.fallback' });
  });
});

describe('the authoring form', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
  };

  it('a pause names the picked campaign; a blank pick is refused, never defaulted', () => {
    expect(actionConfigFrom(form({ actionCampaignId: 'c-1' }), 'PAUSE_CAMPAIGN')).toEqual({
      campaignId: 'c-1',
    });
    expect(() => actionConfigFrom(form({}), 'PAUSE_CAMPAIGN')).toThrow();
    expect(() => actionConfigFrom(form({ actionCampaignId: ' ' }), 'PAUSE_CAMPAIGN')).toThrow();
  });

  it('a retry has nothing to choose', () => {
    expect(actionConfigFrom(form({ actionCampaignId: 'c-1' }), 'RETRY_PUBLISH')).toEqual({});
  });

  it('the pause picker offers only PLANNED or ACTIVE campaigns', () => {
    const page = source('apps/dashboard/src/app/[locale]/automations/page.tsx');
    expect(page).toContain('actionPausableCampaignsByBrand=');
    expect(page).toContain(
      'PAUSABLE_CAMPAIGN_STATUSES as readonly string[]).includes(campaign.status)',
    );
  });
});

describe('the confirm action', () => {
  const actions = source('apps/dashboard/src/app/[locale]/automations/actions.ts');
  const body = actions.slice(actions.indexOf('export async function confirmAutomationRunAction'));

  it('is gated by the floor, automation.read — the engine checks the action’s permission', () => {
    expect(body).toMatch(/requireWorkspace\(locale, 'automation\.read'\)/);
    expect(body).not.toContain("'publishing.manage'");
  });

  it('reports done only for SUCCEEDED; an approval that ended the request is a conflict', () => {
    const check = body.indexOf("!== 'SUCCEEDED'");
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf('?error=CONFLICT', check)).toBeGreaterThan(check);
    expect(body.indexOf('?ok=AUTOMATION_CONFIRMED', check)).toBeGreaterThan(check);
  });
});
