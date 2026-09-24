import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  CREATE_MODES,
  FORMAT_POST_KINDS,
  POST_GOALS,
  createModeFrom,
  goalForObjective,
  platformsByFormat,
  repurposeBrief,
} from '../../apps/dashboard/src/server/create-post';
import { CONTENT_TYPES } from '../../apps/dashboard/src/app/[locale]/content/content-types';
import { SETUP_GOALS } from '../../apps/dashboard/src/server/setup-wizard-state';

/**
 * PHASE 6 FINAL · D-277 §17-§19, D-283 — CREATE POST, THE PURE HALF.
 *
 * The entry's four paths, the format filter read from the publishing
 * capability registry, the goal recommendation and the repurpose brief.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('§17 — the four ways to start', () => {
  it('admits exactly the four modes and nothing else', () => {
    expect(CREATE_MODES).toEqual(['ai', 'write', 'idea', 'repurpose']);
    for (const mode of CREATE_MODES) expect(createModeFrom(mode)).toBe(mode);
    for (const bad of ['', 'AI', 'publish', undefined, null, 1]) {
      expect(createModeFrom(bad)).toBeNull();
    }
  });

  it('every mode has a title and a sentence in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      expect(dictionary['create.entry.title']).toBeTruthy();
      for (const mode of CREATE_MODES) {
        expect(dictionary[`create.mode.${mode}`], `${locale} ${mode}`).toBeTruthy();
        expect(dictionary[`create.mode.${mode}.body`], `${locale} ${mode}`).toBeTruthy();
      }
    }
  });
});

describe('§18 — formats come from the capability registry', () => {
  const providers = {
    instagram: { enabled: true, postKinds: ['image', 'carousel', 'reel', 'story'] },
    linkedin: { enabled: true, postKinds: ['text', 'image', 'article'] },
    tiktok: { enabled: true, postKinds: ['video', 'reel'] },
    x: { enabled: false, postKinds: ['text', 'thread'] },
  };
  const keys = ['instagram', 'linkedin', 'tiktok', 'x'];

  it('offers a format only on platforms whose enabled provider declares a kind it needs', () => {
    const result = platformsByFormat(
      ['POST', 'CAROUSEL', 'REEL', 'ARTICLE', 'THREAD'],
      keys,
      providers,
    );
    expect(result['REEL']).toEqual(['instagram', 'tiktok']);
    expect(result['CAROUSEL']).toEqual(['instagram']);
    expect(result['ARTICLE']).toEqual(['linkedin']);
  });

  it('a disabled or unknown provider can still be drafted for — as a plain post only', () => {
    const result = platformsByFormat(['POST', 'THREAD'], [...keys, 'pinterest'], providers);
    expect(result['POST']).toEqual(['instagram', 'linkedin', 'x', 'pinterest']);
    // X declares threads, but X is not enabled: nothing is known about it.
    expect(result['THREAD']).toBeUndefined();
  });

  it('a format nothing can carry is absent, so the composer cannot offer it', () => {
    const result = platformsByFormat(['STORY'], ['linkedin'], providers);
    expect(Object.keys(result)).toEqual([]);
  });

  it('every configured content type maps to registry post kinds', () => {
    for (const type of CONTENT_TYPES) expect(FORMAT_POST_KINDS[type], type).toBeDefined();
  });

  it('the composer disables a channel that cannot carry the format, rather than dropping it later', () => {
    const composer = read('apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx');
    expect(composer).toContain('disabled={!able}');
    expect(composer).toContain("t['create.format.unsupported']");
    expect(composer).toContain('data-testid="content-format"');
  });
});

describe('§19 — the post goal', () => {
  it('every first-goal objective maps to a post goal', () => {
    for (const objective of SETUP_GOALS) {
      expect(goalForObjective(objective), objective).not.toBeNull();
    }
    expect(goalForObjective(null)).toBeNull();
    expect(goalForObjective('SOMETHING_ELSE')).toBeNull();
  });

  it('every goal is labelled in both languages, and the recommendation names its source', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const goal of POST_GOALS) expect(dictionary[`create.goal.${goal}`]).toBeTruthy();
      expect(dictionary['create.goal.recommended']).toContain('{goal}');
      expect(dictionary['create.goal.instruction']).toContain('{goal}');
    }
  });

  it('a post written by hand never carries the goal sentence', () => {
    const composer = read('apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx');
    // The goal joins the GENERATION brief only; the manual form sends `brief`.
    expect(composer).toMatch(/mode === 'ai' && goalLabel !== ''/);
    expect(composer).toContain('<input type="hidden" name="body" value={brief} />');
  });
});

describe('§17 — repurpose', () => {
  const template = 'Rewrite “{title}” as a fresh post.';

  it('puts the source words in the brief, fenced and bounded', () => {
    const brief = repurposeBrief(template, { title: 'Spring', body: 'Hello world' }, 200);
    expect(brief.startsWith('Rewrite “Spring” as a fresh post.')).toBe(true);
    expect(brief).toContain('"""\nHello world\n"""');
  });

  it('never exceeds the configured brief ceiling', () => {
    const long = 'x'.repeat(5_000);
    for (const max of [50, 120, 2_000]) {
      expect(
        repurposeBrief(template, { title: 'Long', body: long }, max).length,
      ).toBeLessThanOrEqual(max);
    }
  });

  it('the repurpose path reads the source under the member’s BrandScope', () => {
    const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(page).toMatch(/getItem\(sourceId, workspace\.brandScope\)/);
  });
});
