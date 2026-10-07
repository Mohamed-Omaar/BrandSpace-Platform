import { describe, expect, it } from 'vitest';
import { parsePublishingPolicy } from '@brandspace/social-connectors';
import { publishingGaps } from '../../apps/admin/src/server/publishing-readiness';
import { platformsByFormat } from '../../apps/dashboard/src/server/create-post';
import {
  fitOf,
  formatForChannels,
  listOf,
} from '../../apps/dashboard/src/app/[locale]/content/compose/format-fit';

/**
 * ROUND 6 (owner decision D-481) — the rules behind "no silent press".
 *
 * Formats follow a channel's configured post kinds alone; a format the chosen
 * channels cannot all carry is `fix` (dimmed, with a one-press fix), one that
 * nothing carries is `none` (dimmed, with its reason); the Control Center
 * warns while the configuration is at its defaults.
 */

const KEYS = ['instagram', 'linkedin', 'x', 'tiktok'];

describe('formats follow post kinds, not whether a channel can be connected', () => {
  it('the schema defaults (every channel disabled, text-only) carry a Post and nothing else', () => {
    const defaults = parsePublishingPolicy({});
    const result = platformsByFormat(
      ['POST', 'CAROUSEL', 'REEL', 'STORY'],
      KEYS,
      defaults.providers as unknown as Record<string, { enabled: boolean; postKinds: string[] }>,
    );
    expect(result['POST']).toEqual(KEYS);
    expect(result['CAROUSEL']).toBeUndefined();
    expect(result['REEL']).toBeUndefined();
    expect(result['STORY']).toBeUndefined();
  });

  it('declared post kinds count whether or not the channel is enabled', () => {
    const result = platformsByFormat(['STORY', 'REEL'], KEYS, {
      instagram: { enabled: false, postKinds: ['image', 'story', 'reel'] },
      linkedin: { enabled: false, postKinds: ['text'] },
      x: { enabled: true, postKinds: ['text'] },
      tiktok: { enabled: false, postKinds: ['video', 'reel'] },
    });
    expect(result['STORY']).toEqual(['instagram']);
    expect(result['REEL']).toEqual(['instagram', 'tiktok']);
  });
});

describe('the fit of a format with the chosen channels', () => {
  it('ok when every chosen channel carries it, or nothing is chosen yet', () => {
    expect(fitOf(['instagram', 'tiktok'], ['instagram']).state).toBe('ok');
    expect(fitOf(['instagram'], []).state).toBe('ok');
  });

  it('fix: names who cannot carry it, and keeps the ones who can', () => {
    const fit = fitOf(['instagram'], ['instagram', 'linkedin', 'x']);
    expect(fit.state).toBe('fix');
    expect(fit.blockers).toEqual(['linkedin', 'x']);
    expect(fit.next).toEqual(['instagram']);
  });

  it('fix with none of the chosen able to carry it: post to the first carrier instead', () => {
    const fit = fitOf(['instagram', 'tiktok'], ['linkedin']);
    expect(fit.state).toBe('fix');
    expect(fit.next).toEqual(['instagram']);
  });

  it('none when nothing carries it: no fix to offer', () => {
    const fit = fitOf([], ['instagram']);
    expect(fit.state).toBe('none');
    expect(fit.blockers).toEqual([]);
  });

  it('a channel the format cannot take is offered the first format that takes it and the rest', () => {
    const carriers: Record<string, string[]> = {
      POST: KEYS,
      STORY: ['instagram'],
      REEL: ['instagram', 'tiktok'],
    };
    const of = (type: string) => carriers[type] ?? [];
    expect(formatForChannels(['POST', 'STORY'], of, ['instagram', 'linkedin'])).toBe('POST');
    expect(formatForChannels(['STORY', 'REEL'], of, ['instagram', 'tiktok'])).toBe('REEL');
    expect(formatForChannels(['STORY'], of, ['linkedin'])).toBeNull();
  });

  it('lists names in the reader’s language', () => {
    expect(listOf('en', ['LinkedIn', 'X'])).toBe('LinkedIn and X');
    expect(listOf('en', ['Instagram'])).toBe('Instagram');
    expect(listOf('ar', ['لينكدإن', 'إكس'])).toContain('لينكدإن');
  });
});

describe('the Control Center warns while publishing is at its defaults', () => {
  it('the defaults: no channel enabled and every one text-only', () => {
    const defaults = parsePublishingPolicy({});
    expect(
      publishingGaps(
        defaults.providers as unknown as Record<string, { enabled: boolean; postKinds: string[] }>,
      ),
    ).toEqual({ noneEnabled: true, textOnly: true });
  });

  it('configured post kinds clear the text-only warning; one enabled channel clears the other', () => {
    expect(
      publishingGaps({
        instagram: { enabled: false, postKinds: ['image', 'carousel'] },
        x: { enabled: false, postKinds: ['text'] },
      }),
    ).toEqual({ noneEnabled: true, textOnly: false });
    expect(
      publishingGaps({
        instagram: { enabled: true, postKinds: ['text', 'image'] },
      }),
    ).toEqual({ noneEnabled: false, textOnly: true });
  });
});
