import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { missingMediaFor, parseConfigPayload } from '@brandspace/config';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { fill, variantIssues } from '../../apps/dashboard/src/server/composer-editor';

/**
 * D-569 (Studio review, owner decision 1) — A CHANNEL THAT NEEDS MEDIA NEVER
 * READS "READY" WITHOUT IT. The rule reads each channel's configured post kinds
 * and media rules: the beta's own `docs/production-config/publishing.json`
 * (Instagram takes no text post; TikTok takes only video) is the fixture.
 */

const root = path.resolve(__dirname, '../..');
const production = parseConfigPayload(
  'publishing',
  JSON.parse(readFileSync(path.join(root, 'docs/production-config/publishing.json'), 'utf8')),
);
const capability = (key: string) =>
  (
    production.providers as Record<
      string,
      (typeof production.providers)[keyof typeof production.providers]
    >
  )[key]!;

const limits = (key: string, label: string) => ({
  label,
  maxBodyChars: 2_200,
  maxHashtags: 30,
  maxMediaItems: 10,
  media: capability(key),
});

describe('missingMediaFor — from the configured post kinds and media rules', () => {
  it('Instagram: a plain post with nothing attached needs a picture; with one it needs nothing', () => {
    expect(missingMediaFor('POST', [], capability('instagram'))).toBe('picture');
    expect(missingMediaFor('POST', ['IMAGE'], capability('instagram'))).toBeNull();
    expect(missingMediaFor('POST', ['VIDEO'], capability('instagram'))).toBeNull();
  });

  it('TikTok: no video is "needs a video", whatever else is attached or whatever the format', () => {
    expect(missingMediaFor('POST', [], capability('tiktok'))).toBe('video');
    expect(missingMediaFor('POST', ['IMAGE'], capability('tiktok'))).toBe('video');
    expect(missingMediaFor('VIDEO', [], capability('tiktok'))).toBe('video');
    expect(missingMediaFor('VIDEO', ['VIDEO'], capability('tiktok'))).toBeNull();
  });

  it('Facebook takes a text post; a channel the registry does not describe is not judged', () => {
    expect(missingMediaFor('POST', [], capability('facebook'))).toBeNull();
    expect(missingMediaFor('POST', [], undefined)).toBeNull();
  });

  it('a configured minimum for the post kind is honoured, and nothing else is assumed', () => {
    const story = { postKinds: ['text', 'story'], mediaRules: { story: { minItems: 1 } } };
    expect(missingMediaFor('STORY', [], story)).toBe('picture');
    expect(missingMediaFor('STORY', ['IMAGE'], story)).toBeNull();
    expect(missingMediaFor('STORY', [], { postKinds: ['text', 'story'] })).toBeNull();
  });
});

describe('the Studio card: an error with the media fix, never "Ready"', () => {
  it('Instagram with no picture reads "No picture yet" as an error the media fix answers', () => {
    const issues = variantIssues(limits('instagram', 'Instagram'), 'POST', {
      body: 'Two lattes for the price of one.',
      hashtags: [],
      mediaKinds: [],
    });
    expect(issues).toEqual([
      {
        key: 'editor.issue.needsPicture',
        values: { platform: 'Instagram' },
        severity: 'error',
        fix: 'media',
      },
    ]);
    expect(fill(messages.en['editor.issue.needsPicture'], issues[0]!.values)).toBe(
      'No picture yet. Instagram needs a picture or a video for this post.',
    );
  });

  it('TikTok without a video reads "needs a video" — once, not beside the old Reel warning', () => {
    const issues = variantIssues(limits('tiktok', 'TikTok'), 'VIDEO', {
      body: 'Watch this.',
      hashtags: [],
      mediaKinds: ['IMAGE'],
    });
    expect(issues.map((issue) => [issue.key, issue.severity, issue.fix])).toEqual([
      ['editor.issue.needsVideo', 'error', 'media'],
    ]);
    expect(fill(messages.ar['editor.issue.needsVideo'], issues[0]!.values)).toBe(
      'يحتاج TikTok إلى فيديو لهذا المنشور.',
    );
  });

  it('Facebook, a text post, stays clear', () => {
    expect(
      variantIssues(limits('facebook', 'Facebook'), 'POST', {
        body: 'Two lattes for the price of one.',
        hashtags: [],
        mediaKinds: [],
      }),
    ).toEqual([]);
  });
});
