import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DOMAINS, defaultPayload } from '@brandspace/config';
import { AUTOMATION_AI_ACTIONS_FEATURE, QUOTA_FEATURES } from '@brandspace/entitlements';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * FIX PR 2c (D-506) — the pure and source-level half of the screen fixes.
 */

const read = (file: string) => readFileSync(file, 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('B3.6 — reduced motion also stops the scripted smooth scrolls', () => {
  it("every 'smooth' scroll in the customer app and the design system asks first", () => {
    const offenders: string[] = [];
    for (const file of [...sources('apps/dashboard/src'), ...sources('packages/ui/src')]) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          if (!line.includes("'smooth'")) return;
          if (!line.includes("prefersReducedMotion() ? 'auto' : 'smooth'")) {
            offenders.push(`${file}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('Plan & billing — a plain name for every quota', () => {
  const page = read('apps/dashboard/src/app/[locale]/plan/page.tsx');

  it('names every `limit.*` quota the entitlements declare', () => {
    for (const property of Object.keys(QUOTA_FEATURES)) {
      expect(page).toContain(`[QUOTA_FEATURES.${property}]:`);
    }
    expect(page).toContain('[AUTOMATION_AI_ACTIONS_FEATURE]:');
    expect(AUTOMATION_AI_ACTIONS_FEATURE).toBe('limit.automation_ai_actions');
  });

  it('says each name, the storage unit and the new headers in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const m = messages[locale];
      for (const key of [
        'plan.quotaItem',
        'plan.featureAvailability',
        'plan.limitNotApplicable',
        'plan.limitSeats',
        'plan.limitAnalyticsRetention',
        'plan.limitAutomationAiActions',
        'plan.unitGb',
      ] as const) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
      expect(m['plan.unitGb']).toContain('{n}');
    }
    expect(messages.en['plan.quotaItem']).toBe('Allowance');
    expect(messages.en['plan.featureAvailability']).toBe('Availability');
  });
});

describe('Brand Brain — a configured short wording for the chip', () => {
  const schema = CONFIG_DOMAINS['brand-brain'].schema;
  const withShort = (short: unknown) => {
    const payload = structuredClone(defaultPayload('brand-brain')) as {
      questions: { areas: Record<string, Array<Record<string, unknown>>> };
    };
    const [area, list] = Object.entries(payload.questions.areas).find(
      ([, questions]) => questions.length > 0,
    )!;
    list[0] = { ...list[0], short };
    return { payload, area };
  };

  it('is optional: the shipped questions parse without one', () => {
    expect(schema.safeParse(defaultPayload('brand-brain')).success).toBe(true);
  });

  it('is kept when given, in both languages, up to 40 characters', () => {
    const { payload, area } = withShort({ en: 'Who buys', ar: 'من يشتري' });
    const parsed = schema.parse(payload) as typeof payload;
    expect(parsed.questions.areas[area]![0]!['short']).toEqual({ en: 'Who buys', ar: 'من يشتري' });
    expect(schema.safeParse(withShort({ en: 'x'.repeat(41), ar: 'y' }).payload).success).toBe(
      false,
    );
    expect(schema.safeParse(withShort({ en: 'Who buys' }).payload).success).toBe(false);
  });
});

describe('copy', () => {
  it('B3.5 — no automation failure reason repeats "Skipped"', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const [key, value] of Object.entries(messages[locale])) {
        if (!key.startsWith('automations.failure.')) continue;
        expect(value, `${locale} ${key}`).not.toMatch(/^(Skipped|تم التخطي)/);
      }
    }
  });

  it('the Notes card and the notifications bell say what their button does: Close', () => {
    const shell = read('apps/dashboard/src/components/workspace-shell.tsx');
    const notes = shell.slice(shell.indexOf('<NotesPopover'), shell.indexOf('</NotesPopover>'));
    expect(notes).toContain("close: t('common.close')");
    const bell = shell.slice(
      shell.indexOf('<NotificationsBell'),
      shell.indexOf('</NotificationsBell>'),
    );
    expect(bell).toContain("close: t('common.close')");
    expect(shell).not.toContain('notifications.dismiss');
    expect(messages.en['common.close']).toBe('Close');
    expect(messages.ar['common.close']).toBe('إغلاق');
  });

  it('Approvals: the note is the reason a change request needs', () => {
    expect(messages.en['approvals.decisionNote']).toBe('Reason (needed to request changes)');
    expect(messages.ar['approvals.decisionNote']).toBe('السبب (مطلوب لطلب تعديلات)');
  });

  it('Duplicate, the copy name, Pause and the new results exist in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const m = messages[locale];
      expect(m['automations.duplicate']).toBeTruthy();
      expect(m['automations.copyName']).toContain('{name}');
      expect(m['campaigns.card.pause']).toBeTruthy();
    }
  });
});
