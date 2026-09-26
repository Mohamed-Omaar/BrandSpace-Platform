import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TEMPLATE_KEYS,
  categoryOf,
} from '@brandspace/notifications';
import { brandLocaleAtCreation } from '../../apps/dashboard/src/server/brand-ai-language';
import { settingsLandingPath } from '../../apps/dashboard/src/server/settings-nav';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * A10 / G2 / G3 (prototype v94 Phase 2B-1, D-331) — notification preferences
 * and the AI writing language, as rules. The database half is
 * `tests/isolation/phase2b1-notification-preferences.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('A10 · every notification is classified, and the workspace’s own notices never switch off', () => {
  it('the four categories the approved design names, in order', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual([
      'approvals',
      'publishing',
      'automations',
      'brand_brain_reviews',
    ]);
  });

  it('each category covers at least one real template, and the templates map where they say', () => {
    const covered = new Set(NOTIFICATION_TEMPLATE_KEYS.map((key) => categoryOf(key)));
    for (const category of NOTIFICATION_CATEGORIES) expect(covered.has(category)).toBe(true);
    expect(categoryOf('approval.requested')).toBe('approvals');
    expect(categoryOf('publishing.connection_needs_reauth')).toBe('publishing');
    expect(categoryOf('automation.confirmation_required')).toBe('automations');
    expect(categoryOf('automation.notice')).toBe('automations');
    expect(categoryOf('brand_brain.learning_proposed')).toBe('brand_brain_reviews');
  });

  it('a notice about the workspace itself belongs to no category', () => {
    expect(categoryOf('workspace.deletion_requested')).toBeNull();
    expect(categoryOf('workspace.deletion_cancelled')).toBeNull();
  });

  it('the database CHECK allows exactly these categories', () => {
    const sql = read(
      'packages/database/prisma/migrations/20260930090000_notification_preference/migration.sql',
    );
    const list = /CHECK \("category" IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
    expect(list.split(',').map((entry) => entry.trim().replace(/'/g, ''))).toEqual([
      ...NOTIFICATION_CATEGORIES,
    ]);
  });

  it('the filter is inside NotificationService.create — the one writer', () => {
    const service = read('packages/notifications/src/service.ts');
    expect(service).toMatch(/const muted = await mutedRecipients\(/);
    expect(service).toContain('addressed.filter((id) => !muted.has(id))');
  });

  it('every switch has a label and a line saying what it covers, in both languages', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const key of [`notificationPrefs.${category}`, `notificationPrefs.${category}.hint`]) {
        expect(optionalMessage('en', key), key).toBeTruthy();
        expect(optionalMessage('ar', key), key).toMatch(/[؀-ۿ]/);
      }
    }
    expect(optionalMessage('en', 'notificationPrefs.automations')).toBe(
      'An automation notifies me or needs my OK',
    );
    expect(optionalMessage('en', 'notificationPrefs.brand_brain_reviews')).toBe(
      'Brand Brain facts wait for my review',
    );
  });

  it('a member with no gated row still opens Settings on Roles & permissions (D-277)', () => {
    expect(settingsLandingPath([])).toBe('/permissions');
  });

  it('Notifications and AI are under the save bar', () => {
    for (const file of [
      'apps/dashboard/src/app/[locale]/settings/notifications/page.tsx',
      'apps/dashboard/src/app/[locale]/settings/ai/page.tsx',
    ]) {
      expect(read(file), file).toMatch(/<DraftForm\s+key=/);
    }
  });
});

describe('G3 · the brand’s AI writing language starts as its creator’s interface language (amends D-277)', () => {
  it('the form’s explicit choice wins; otherwise the creator’s interface language', () => {
    expect(brandLocaleAtCreation('EN', 'ar')).toBe('EN');
    expect(brandLocaleAtCreation('AR', 'en')).toBe('AR');
    expect(brandLocaleAtCreation('', 'ar')).toBe('AR');
    expect(brandLocaleAtCreation('', 'en')).toBe('EN');
    expect(brandLocaleAtCreation('fr', 'de')).toBe('EN');
  });

  it('both creation paths start from it', () => {
    const brands = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    expect(brands).toMatch(
      /defaultLocale: brandLocaleAtCreation\(String\(formData\.get\('defaultLocale'\) \?\? ''\), locale\)/,
    );
    // The wizard's language fields moved into `SetupBrandLanguages` (D-335),
    // which starts the select at the value the page hands it.
    const wizard = read('apps/dashboard/src/app/[locale]/onboarding/page.tsx');
    expect(wizard).toMatch(
      /<SetupBrandLanguages\s+initialDefault=\{locale === 'ar' \? 'AR' : 'EN'\}/,
    );
    const fields = read('apps/dashboard/src/components/setup-brand-languages.tsx');
    expect(fields).toContain('useState<Code>(initialDefault)');
    expect(fields).toMatch(/name="defaultLocale"[\s\S]{0,400}value=\{defaultLocale\}/);
  });
});
