import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AppError } from '@brandspace/shared';
import { PLANNED_POSTS_MAX, campaignFormFrom } from '../../apps/dashboard/src/server/campaign-form';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR E (D-496) — THE CAMPAIGN DIALOG, the pure half (Shell 7, Campaigns 1, 15,
 * 16, 21).
 */

const read = (path: string) => readFileSync(path, 'utf8');

function form(extra: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: 'Winter menu',
    objective: 'LAUNCH',
    briefAr: '',
    briefEn: '',
    description: '',
    startDate: '',
    endDate: '',
    ...extra,
  })) {
    data.set(key, value);
  }
  return data;
}

const options = { allowedChannels: ['instagram'], withStatus: false };

describe('Campaigns 1 — "Planned posts" is decoded, bounded and optional', () => {
  it('reads a whole number from one up', () => {
    expect(campaignFormFrom(form({ plannedPostCount: '8' }), options).plannedPostCount).toBe(8);
    expect(campaignFormFrom(form({ plannedPostCount: ' 1 ' }), options).plannedPostCount).toBe(1);
    expect(campaignFormFrom(form({ plannedPostCount: '999' }), options).plannedPostCount).toBe(
      PLANNED_POSTS_MAX,
    );
  });

  it('blank clears it; absent leaves it as it is', () => {
    expect(campaignFormFrom(form({ plannedPostCount: '' }), options).plannedPostCount).toBeNull();
    expect(campaignFormFrom(form(), options).plannedPostCount).toBeUndefined();
  });

  it('refuses zero, negatives, fractions, words and a fourth digit', () => {
    for (const bad of ['0', '-1', '2.5', 'eight', '1000', '1e2']) {
      expect(() => campaignFormFrom(form({ plannedPostCount: bad }), options), bad).toThrow(
        AppError,
      );
    }
  });
});

describe('Shell 7 — Create → Campaign opens the dialog over Campaigns', () => {
  it('links to ?new=1 and needs both the list and the manage permission', () => {
    const source = read('apps/dashboard/src/server/topbar.ts');
    expect(source).toMatch(
      /path: '\/campaigns\?new=1',\s*requires: \['campaigns\.read', 'campaigns\.manage'\]/,
    );
  });

  it('the old address carries everything to the dialog', () => {
    const page = read('apps/dashboard/src/app/[locale]/campaigns/new/page.tsx');
    expect(page).toContain("new URLSearchParams({ new: '1' })");
    expect(page).toContain('redirect(');
  });
});

describe('Campaigns 15, 16, 21 — chips, the stepper and the two-step Archive', () => {
  const view = read('apps/dashboard/src/app/[locale]/campaigns/campaign-form-view.tsx');
  const dialog = read('apps/dashboard/src/app/[locale]/campaigns/campaign-dialog.tsx');

  it('the objective is radios and the channels checkboxes, inside chips', () => {
    expect(view).toMatch(
      /className="bsp-chip bsp-lk-chip">\s*<input\s+type="radio"\s+name="objective"/,
    );
    expect(view).toMatch(
      /className="bsp-chip bsp-lk-chip">\s*<input\s+type="checkbox"\s+name="channels"/,
    );
  });

  it('the stepper never goes below one', () => {
    expect(dialog).toContain('Math.max(1, value - 1)');
    expect(dialog).toContain('name="plannedPostCount"');
  });

  it('Archive asks first, with two distinct buttons', () => {
    expect(dialog).toContain('key="ask"');
    expect(dialog).toContain('key="sure"');
    expect(dialog).toContain('data-testid="campaign-archive-sure"');
  });

  it('says every new word in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of [
        'campaigns.form.editTitle',
        'campaigns.form.namePh',
        'campaigns.form.brand',
        'campaigns.form.plannedPosts',
        'campaigns.form.fewer',
        'campaigns.form.more',
        'campaigns.form.cancel',
        'campaigns.form.archive',
        'campaigns.form.archiveSure',
      ]) {
        expect(dictionary[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
