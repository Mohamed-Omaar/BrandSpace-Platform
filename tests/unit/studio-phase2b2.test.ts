import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseSlides, readSlides } from '@brandspace/content';
import { variantFingerprint } from '@brandspace/shared';

/**
 * B9 (Phase 2B-2) — THE STUDIO: slide headlines, templates, inline date and
 * time, and the reviewer select. The rules as rules; the database half is
 * `tests/isolation/content-slides.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

describe('B9 · slide headlines', () => {
  it('follow the images: order, removed images and blanks', () => {
    expect(
      normaliseSlides(
        [
          { assetId: C, headline: 'three' },
          { assetId: A, headline: '  one   more ' },
          { assetId: B, headline: '  ' },
          { assetId: '00000000-0000-4000-8000-0000000000ff', headline: 'gone' },
        ],
        [A, B, C],
      ),
    ).toEqual([
      { assetId: A, headline: 'one more' },
      { assetId: C, headline: 'three' },
    ]);
    expect(normaliseSlides([{ assetId: A, headline: '' }], [A])).toBeNull();
  });

  it('a malformed stored value reads as no slides', () => {
    expect(readSlides({ assetId: A })).toEqual([]);
    expect(readSlides(null)).toEqual([]);
  });

  it('the migration is one nullable column with a shape CHECK', () => {
    const sql = read(
      'packages/database/prisma/migrations/20261006120000_content_variant_slides/migration.sql',
    );
    expect(sql).toContain('ADD COLUMN     "slides" JSONB;');
    expect(sql).toContain('jsonb_typeof("slides") = \'array\'');
    expect(sql).not.toMatch(/\bUPDATE\b/);
  });
});

describe('B9 · the approval fingerprint covers the headlines, and nothing approved earlier changes', () => {
  const base = {
    id: 'v1',
    platformKey: 'instagram',
    locale: 'EN',
    body: 'Swipe',
    hashtags: ['spring'],
    firstComment: null,
    linkUrl: null,
    assetIds: [A, B],
  };
  const legacy = createHash('sha256')
    .update(
      JSON.stringify([
        base.platformKey,
        base.locale,
        base.body,
        [...base.hashtags],
        '',
        '',
        [...base.assetIds],
      ]),
      'utf8',
    )
    .digest('hex');

  it('a variant without headlines hashes exactly as before slides existed', () => {
    expect(variantFingerprint(base)).toBe(legacy);
    expect(variantFingerprint({ ...base, slides: null })).toBe(legacy);
    expect(variantFingerprint({ ...base, slides: [] })).toBe(legacy);
  });

  it('a headline is part of what was approved', () => {
    const one = variantFingerprint({ ...base, slides: [{ assetId: A, headline: 'One' }] });
    const other = variantFingerprint({ ...base, slides: [{ assetId: A, headline: 'Two' }] });
    expect(one).not.toBe(legacy);
    expect(one).not.toBe(other);
  });

  it('the reviewer’s verdict and the publisher both read the headlines', () => {
    expect(read('packages/content/src/approvals.ts')).toContain('slides: true,');
    expect(read('packages/social-connectors/src/publishing.ts')).toContain('slides: true,');
  });
});

describe('B9 / F2 · inline date and time', () => {
  it('posts to schedule() under content.schedule and lands back on the post', () => {
    const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');
    const start = actions.indexOf('export async function scheduleFromStudioAction');
    const body = actions.slice(start, actions.indexOf('\n}\n', start));
    expect(body).toContain("requireWorkspaceAction(locale, 'content.schedule')");
    expect(body).toContain('(await calendar()).schedule({');
    expect(body).toContain("ok: 'CONTENT_SCHEDULED'");
    expect(body).toContain("'SCHEDULE_IN_PAST'");
  });

  it('proposes tomorrow at the default time, offers no past day, and nothing on today', () => {
    const view = read('apps/dashboard/src/app/[locale]/content/compose/inline-schedule.tsx');
    expect(view).toContain('min={today}');
    // Round 4 (3.3): a post already on the calendar starts from its own time;
    // a new one is proposed exactly as before.
    expect(view).toMatch(
      /const firstDate = initial\s*\?\s*initial\.date\s*:\s*plannedDate && plannedDate >= today\s*\?\s*plannedDate\s*:\s*tomorrow;/,
    );
    expect(view).toMatch(
      /useState\(\s*initial \? initial\.time : firstDate === today \? '' : defaultTime,?\s*\)/,
    );
    const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(page).toContain('defaultTime: brand?.defaultPostTime ?? DEFAULT_POST_TIME,');
  });
});

describe('E4 · templates in the Studio', () => {
  it('"Save as template" needs templates.manage, in the screen and the action', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toContain('{can.manageTemplates && actions.saveAsTemplate ? (');
    const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');
    const start = actions.indexOf('export async function saveDraftAsTemplateAction');
    expect(actions.slice(start, start + 800)).toContain(
      'requireWorkspaceAction(locale, TEMPLATES_MANAGE_PERMISSION)',
    );
  });
});

describe('B9 · the reviewer select', () => {
  it('is fed by eligibleReviewers and posts assignedToUserId (already built in Phase 2A)', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toContain('name="assignedToUserId"');
    const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(page).toContain('eligibleReviewers(');
  });
});
