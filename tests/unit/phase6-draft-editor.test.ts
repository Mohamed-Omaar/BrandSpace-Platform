import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { CONTENT_TOOLS } from '../../packages/content/src/studio';
import {
  INLINE_ACTIONS,
  LIFECYCLE_PATH,
  aspectLabel,
  countCharacters,
  durationLabel,
  fill,
  fingerprint,
  inlineActionsFor,
  lifecycleIndex,
  moveItem,
  parseHashtags,
  previewFormatFor,
  variantIssues,
} from '../../apps/dashboard/src/server/composer-editor';

/**
 * PHASE 6 FINAL · D-277 §20-§22 and §27, D-284 — THE DRAFT EDITOR.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const instagram = { label: 'Instagram', maxBodyChars: 20, maxHashtags: 2, maxMediaItems: 3 };

describe('§21 — friendly validation, with the fix beside it', () => {
  it('says how far over the limit, in the platform’s name, and offers Shorten', () => {
    const issues = variantIssues(instagram, 'POST', {
      body: 'x'.repeat(25),
      hashtags: [],
      mediaKinds: [],
    });
    expect(issues).toEqual([
      {
        key: 'editor.issue.tooLong',
        values: { platform: 'Instagram', over: 5 },
        severity: 'error',
        fix: 'shorten',
      },
    ]);
    expect(fill(messages.en['editor.issue.tooLong'], issues[0]!.values)).toBe(
      'Your Instagram caption is 5 characters over the limit.',
    );
  });

  it('counts characters as a person does — an emoji is one', () => {
    expect(countCharacters('👍🏽')).toBe(1);
    const issues = variantIssues(instagram, 'POST', {
      body: '👍🏽'.repeat(20),
      hashtags: [],
      mediaKinds: [],
    });
    expect(issues).toEqual([]);
  });

  it('a Reel without a video asks for one; a carousel wants two slides', () => {
    const reel = variantIssues(instagram, 'REEL', {
      body: 'ok',
      hashtags: [],
      mediaKinds: ['IMAGE'],
    });
    expect(reel.map((issue) => [issue.key, issue.fix])).toEqual([
      ['editor.issue.reelNeedsVideo', 'media'],
    ]);
    const carousel = variantIssues(instagram, 'CAROUSEL', {
      body: 'ok',
      hashtags: [],
      mediaKinds: ['IMAGE'],
    });
    expect(carousel.map((issue) => issue.key)).toEqual(['editor.issue.carouselNeedsSlides']);
  });

  it('too many hashtags and too much media are named with the configured limit', () => {
    const issues = variantIssues(instagram, 'POST', {
      body: 'ok',
      hashtags: ['a', 'b', 'c'],
      mediaKinds: ['IMAGE', 'IMAGE', 'IMAGE', 'IMAGE'],
    });
    expect(issues.map((issue) => issue.values)).toEqual([
      { platform: 'Instagram', limit: 2, count: 3 },
      { platform: 'Instagram', limit: 3 },
    ]);
  });

  it('an empty caption is a warning, never an error', () => {
    const [issue] = variantIssues(instagram, 'POST', { body: '  ', hashtags: [], mediaKinds: [] });
    expect(issue?.severity).toBe('warning');
  });

  it('every issue key reads in both languages', () => {
    const keys = [
      'editor.issue.empty',
      'editor.issue.tooLong',
      'editor.issue.tooManyHashtags',
      'editor.issue.tooMuchMedia',
      'editor.issue.reelNeedsVideo',
      'editor.issue.videoNeedsVideo',
      'editor.issue.carouselNeedsSlides',
      'editor.issue.storyNeedsMedia',
    ];
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of keys) expect(dictionary[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});

describe('§20 — inline AI actions are the service’s own tools', () => {
  it('every inline action names a configured tool, and has words in both languages', () => {
    for (const action of INLINE_ACTIONS) {
      expect(CONTENT_TOOLS as readonly string[]).toContain(action.tool);
      for (const locale of ['en', 'ar'] as const) {
        expect(
          (messages[locale] as Record<string, string>)[`editor.ai.${action.key}`],
        ).toBeTruthy();
      }
    }
  });

  it('a tool the service does not offer is not shown', () => {
    expect(inlineActionsFor(['shorten']).map((action) => action.key)).toEqual(['shorten']);
  });

  it('the hashtag tool may not change the caption', () => {
    const studio = read('packages/content/src/studio.ts');
    expect(studio).toMatch(/hashtagsOnly \? \(variant\.body \?\? ''\) : produced\.body/);
  });
});

describe('§22 and §27 — preview format and lifecycle', () => {
  it('a Reel is drawn as a reel, a Story as a story, everything else as a feed post', () => {
    expect(previewFormatFor('REEL')).toBe('reel');
    expect(previewFormatFor('STORY')).toBe('story');
    expect(previewFormatFor('VIDEO')).toBe('video');
    expect(previewFormatFor('CAROUSEL')).toBe('feed');
    expect(previewFormatFor('POST')).toBe('feed');
  });

  it('changes requested sits back at the start of the path', () => {
    expect(LIFECYCLE_PATH[lifecycleIndex('CHANGES_REQUESTED')]).toBe('DRAFT');
    expect(LIFECYCLE_PATH[lifecycleIndex('APPROVED')]).toBe('APPROVED');
    expect(LIFECYCLE_PATH[lifecycleIndex('PUBLISHING')]).toBe('SCHEDULED');
  });

  it('parses the hashtag field exactly as the save action does', () => {
    expect(parseHashtags('#launch, autumn  #Sale')).toEqual(['launch', 'autumn', 'Sale']);
  });

  it('the approved-edit warning is on screen before Save, in both languages', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toContain("draft.status === 'APPROVED' && can.edit");
    for (const locale of ['en', 'ar'] as const) {
      expect((messages[locale] as Record<string, string>)['editor.approvedWarning']).toBeTruthy();
    }
  });

  it('there is no background autosave: nothing writes without Save', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).not.toMatch(/setInterval|setTimeout\([^)]*save/);
    expect(editor).toContain("addEventListener('beforeunload'");
  });
});

describe('D-284 — saving a caption never erases a first comment', () => {
  it('absent means leave it', () => {
    const library = read('packages/content/src/library.ts');
    expect(library).toMatch(
      /input\.firstComment === undefined \? variant\.firstComment : input\.firstComment \|\| null/,
    );
  });
});

describe('D-285 — slides, covers and the media drawer', () => {
  it('reorders slides without losing or duplicating one', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('names aspect ratios and durations the way a person would', () => {
    expect(aspectLabel(1080, 1920)).toBe('9:16');
    expect(aspectLabel(1080, 1350)).toBe('4:5');
    expect(aspectLabel(1080, 1080)).toBe('1:1');
    expect(aspectLabel(1920, 1080)).toBe('16:9');
    expect(aspectLabel(null, 1080)).toBeNull();
    expect(durationLabel(15_400)).toBe('0:15');
    expect(durationLabel(75_000)).toBe('1:15');
    expect(durationLabel(null)).toBeNull();
  });

  it('a generation key changes with the words and not otherwise', () => {
    expect(fingerprint('spring sale')).toBe(fingerprint('spring sale'));
    expect(fingerprint('spring sale')).not.toBe(fingerprint('autumn sale'));
  });

  it('the cover is a durable column with a brand-scope trigger, not browser state', () => {
    const migration = read(
      'packages/database/prisma/migrations/20260924140000_phase_6_variant_cover/migration.sql',
    );
    expect(migration).toMatch(/ADD COLUMN "coverAssetId" UUID/);
    expect(migration).toMatch(/FOREIGN KEY \("workspaceId", "coverAssetId"\)/);
    expect(migration).toMatch(/ON DELETE SET NULL \("coverAssetId"\)/);
    expect(migration).toMatch(/CREATE TRIGGER content_variant_cover_scope/);
    expect(migration).not.toMatch(/plpgsql\s+SECURITY DEFINER/);
    expect(migration).toMatch(/relforcerowsecurity/);
  });

  it('the media drawer reuses the one upload action and the Creative routes', () => {
    const drawer = read('apps/dashboard/src/app/[locale]/content/compose/media-drawer.tsx');
    expect(drawer).toContain('action={uploadAction}');
    expect(drawer).toContain('`/api/creative/${path}`');
    expect(drawer).toContain('SideSheet');
  });

  it('every media and slide label reads in both languages', () => {
    const keys = [
      'editor.media.slide',
      'editor.media.add',
      'editor.media.useAsCover',
      'editor.media.tab.library',
      'editor.media.tab.upload',
      'editor.media.tab.generate',
      'editor.preview.slide',
      'editor.preview.previousSlide',
      'editor.preview.nextSlide',
    ];
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of keys) expect(dictionary[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});
