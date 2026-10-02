import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashtagsIntoFirstComment } from '@brandspace/content';
import { KNOWN_PAGE_PERMISSIONS } from '../../apps/dashboard/src/server/known-routes';
import { SETTINGS_NAV_ROUTES } from '../../apps/dashboard/src/server/settings-nav';
import { templateFieldsFrom } from '../../apps/dashboard/src/server/template-form';
import { LOCAL_TIME } from '../../apps/dashboard/src/server/publishing-defaults';

/**
 * SETTINGS → PUBLISHING DEFAULTS (A8 / A10 / B2, Phase 2B-2), the rules as
 * rules. The database half is `tests/isolation/publishing-defaults.test.ts`
 * and the screens are `tests/e2e/prototype-v90-phase2b2.spec.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('the tab', () => {
  it('is gated on brand.manage — an existing key — in the nav and on the route', () => {
    const route = SETTINGS_NAV_ROUTES.find((entry) => entry.key === 'publishing');
    expect(route).toMatchObject({ path: '/settings/publishing', permission: 'brand.manage' });
    expect(KNOWN_PAGE_PERMISSIONS['/settings/publishing']).toBe('brand.manage');
  });

  it('holds the defaults under the shared save bar, and the templates behind templates.manage', () => {
    const page = read('apps/dashboard/src/app/[locale]/settings/publishing/page.tsx');
    expect(page).toContain('<DraftForm');
    expect(page).toContain("requireWorkspacePage(locale, '/settings/publishing')");
    expect(page).toContain("workspace.permissionKeys.includes('templates.manage')");
    // Link tracking stays out (Q15).
    expect(page).not.toMatch(/linkTracking/i);
    const actions = read('apps/dashboard/src/app/[locale]/settings/publishing/actions.ts');
    expect(
      actions.match(/requireWorkspaceAction\(locale, TEMPLATES_MANAGE_PERMISSION\)/g),
    ).toHaveLength(3);
    expect(actions).toContain("requireWorkspaceAction(locale, 'brand.manage')");
  });

  it('the migration only adds columns with constant defaults, and bounds the time', () => {
    const sql = read(
      'packages/database/prisma/migrations/20261006110000_brand_publishing_defaults/migration.sql',
    );
    expect(sql).toContain('"aiSuggestionsEnabled" BOOLEAN NOT NULL DEFAULT true');
    expect(sql).toContain('"hashtagsInFirstComment" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain("'^([01][0-9]|2[0-3]):[0-5][0-9]$'");
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b/);
  });
});

describe('the default time', () => {
  it('accepts a clock time and nothing else', () => {
    expect(LOCAL_TIME.test('09:00')).toBe(true);
    expect(LOCAL_TIME.test('23:59')).toBe(true);
    for (const bad of ['9:00', '24:00', '12:60', '12-00', ''])
      expect(LOCAL_TIME.test(bad)).toBe(false);
  });
});

describe('hashtags in the first comment', () => {
  it('moves the tags into the first comment on a channel that takes one', () => {
    expect(
      hashtagsIntoFirstComment(
        { hashtags: ['spring', 'launch'], firstComment: null },
        { allowsFirstComment: true },
      ),
    ).toEqual({ hashtags: [], firstComment: '#spring #launch' });
    expect(
      hashtagsIntoFirstComment(
        { hashtags: ['spring'], firstComment: 'Link in bio' },
        { allowsFirstComment: true },
      ),
    ).toEqual({ hashtags: [], firstComment: 'Link in bio\n\n#spring' });
  });

  it('leaves them where they are on a channel without a first comment', () => {
    expect(
      hashtagsIntoFirstComment(
        { hashtags: ['spring'], firstComment: null },
        { allowsFirstComment: false },
      ),
    ).toEqual({ hashtags: ['spring'], firstComment: null });
  });
});

describe('the template form decoder fails closed', () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  };

  it('refuses a format the composer does not offer', () => {
    expect(() =>
      templateFieldsFrom(
        form([
          ['name', 'A'],
          ['contentType', 'PODCAST'],
        ]),
      ),
    ).toThrow();
  });

  it('reads every field, and blank text as nothing', () => {
    expect(
      templateFieldsFrom(
        form([
          ['name', 'Weekly'],
          ['contentType', 'REEL'],
          ['platformKeys', 'instagram'],
          ['platformKeys', 'x'],
          ['body', '  '],
          ['hashtags', '#a, b  c'],
          ['firstComment', 'hi'],
        ]),
      ),
    ).toEqual({
      name: 'Weekly',
      contentType: 'REEL',
      platformKeys: ['instagram', 'x'],
      body: null,
      hashtags: ['#a', 'b', 'c'],
      firstComment: 'hi',
    });
  });
});

describe('D7 · AI suggestions on/off', () => {
  it('lives in Settings → AI and switches off the Home recommendations card only', () => {
    const ai = read('apps/dashboard/src/app/[locale]/settings/ai/page.tsx');
    expect(ai).toContain('name="aiSuggestionsEnabled"');
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    // D-468: the recommendations are cards inside "BrandSpace noticed".
    expect(home).toMatch(/\{showRecommendations\s*\?\s*recommendations\.map\(/);
    expect(home.match(/aiSuggestionsEnabled/g)?.length).toBeGreaterThan(0);
    // Not the workflow suggestions (D-296), not the Studio's tools.
    expect(home).toContain('decideWorkflowAction');
    expect(read('apps/dashboard/src/app/[locale]/content/compose/page.tsx')).not.toContain(
      'aiSuggestionsEnabled',
    );
  });
});
