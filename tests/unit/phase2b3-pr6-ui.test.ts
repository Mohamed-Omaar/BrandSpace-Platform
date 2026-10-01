import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  aiCapReached,
  ideasLine,
  runPresentation,
} from '../../apps/dashboard/src/server/automation-run-display';

/**
 * PHASE 2B-3 PR 6 — DRAFT_IDEAS ON THE AUTOMATIONS SCREEN (approved copy).
 *
 *   - Run history: the success line links to the brand's drafts; every reason
 *     reads in words; a run waiting for or held by the executor reads
 *     "Drafting ideas…".
 *   - The rule card: "Monthly AI limit reached — resumes next month", and no
 *     notification (owner decision 2a).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = readFileSync(
  path.join(root, 'apps/dashboard/src/app/[locale]/automations/page.tsx'),
  'utf8',
);
const en = messages.en as Record<string, string>;
const ar = messages.ar as Record<string, string>;

describe('the copy, exactly', () => {
  const COPY: Record<string, readonly [string, string]> = {
    'automations.action.DRAFT_IDEAS': ['Draft 3 ideas with AI', 'صياغة 3 أفكار بالذكاء الاصطناعي'],
    'automations.ideasDrafted': [
      'Drafted 3 ideas in your content library.',
      'تمت صياغة 3 أفكار في مكتبة المحتوى.',
    ],
    'automations.status.AWAITING_EXECUTION': ['Drafting ideas…', 'جارٍ صياغة الأفكار…'],
    'automations.status.EXECUTING': ['Drafting ideas…', 'جارٍ صياغة الأفكار…'],
    'automations.aiCapReached': [
      'Monthly AI limit reached — resumes next month',
      'بلغ الحد الشهري لإجراءات الأتمتة بالذكاء الاصطناعي — يُستأنف الشهر القادم',
    ],
  };
  it('en and ar, as approved', () => {
    for (const [key, [english, arabic]] of Object.entries(COPY)) {
      expect(en[key], key).toBe(english);
      expect(ar[key], key).toBe(arabic);
    }
  });
});

describe('Run history', () => {
  it('only a finished DRAFT_IDEAS run says where its ideas are', () => {
    expect(ideasLine({ actionType: 'DRAFT_IDEAS', status: 'SUCCEEDED' })).toBe(
      'automations.ideasDrafted',
    );
    for (const status of ['AWAITING_EXECUTION', 'EXECUTING', 'SKIPPED', 'FAILED']) {
      expect(ideasLine({ actionType: 'DRAFT_IDEAS', status }), status).toBeNull();
    }
    expect(ideasLine({ actionType: 'MAKE_DRAFT_COPY', status: 'SUCCEEDED' })).toBeNull();
    expect(page).toContain('href={`/${locale}/content?brand=${run.brandId}&status=DRAFT`}');
  });

  it('a waiting or executing run reads "Drafting ideas…", with no reason line', () => {
    for (const status of ['AWAITING_EXECUTION', 'EXECUTING']) {
      expect(runPresentation({ status, failureCode: null })).toEqual({
        statusKey: `automations.status.${status}`,
        reason: { kind: 'none' },
      });
    }
  });

  it('each DRAFT_IDEAS outcome reads under its own badge', () => {
    expect(runPresentation({ status: 'SKIPPED', failureCode: 'monthly_ai_cap_reached' })).toEqual({
      statusKey: 'automations.status.actionSkipped',
      reason: { kind: 'message', key: 'automations.failure.monthly_ai_cap_reached' },
    });
    expect(runPresentation({ status: 'FAILED', failureCode: 'ai_output_unusable' })).toEqual({
      statusKey: 'automations.status.FAILED',
      reason: { kind: 'message', key: 'automations.failure.ai_output_unusable' },
    });
    expect(runPresentation({ status: 'BLOCKED_BY_POLICY', failureCode: 'not_entitled' })).toEqual({
      statusKey: 'automations.status.BLOCKED_BY_POLICY',
      reason: { kind: 'message', key: 'automations.failure.not_entitled' },
    });
    // A code under the wrong status is the fallback, never a wrong sentence.
    expect(
      runPresentation({ status: 'FAILED', failureCode: 'monthly_ai_cap_reached' }).reason,
    ).toEqual({ kind: 'message', key: 'automations.failure.fallback' });
  });
});

describe('the rule card', () => {
  it('the cap is reached when this month used it all; unlimited never is', () => {
    expect(aiCapReached({ limit: 2, used: 2 })).toBe(true);
    expect(aiCapReached({ limit: 2, used: 1 })).toBe(false);
    expect(aiCapReached({ limit: 0, used: 0 })).toBe(true);
    expect(aiCapReached({ limit: null, used: 500 })).toBe(false);
  });

  it('shown on DRAFT_IDEAS rules only, and asked only when the plan includes it', () => {
    expect(page).toContain("rule.actionType === 'DRAFT_IDEAS' && aiCapIsReached");
    expect(page).toContain("aiCapIsReached: entitled.has('DRAFT_IDEAS')");
    expect(page).toContain('workspaceMonthLabel(zone?.timezone');
  });

  it('no notification is sent for the cap: no automation template is new', () => {
    const executor = readFileSync(
      path.join(root, 'apps/api/src/automation-ai-executor.ts'),
      'utf8',
    );
    expect(executor).not.toMatch(/templateKey|notify\(/);
  });
});
