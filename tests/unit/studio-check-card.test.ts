import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  checkView,
  type CheckInput,
} from '../../apps/dashboard/src/app/[locale]/content/compose/check-rows';

/**
 * D-569 (Studio review, owner decision 2) — "WILL IT LAND RIGHT?" AS THE
 * PROTOTYPE DRAWS IT (`Main.dc.html:514-524`, `:2365-2372`, `:2396-2399`): the
 * Size row; Hashtags as "n (3–5)" with "!" outside the configured range; Media
 * in words with the ✕ states; Expired with its short line and "Reconnect";
 * Not connected with "Connect", only where a channel can be connected.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const en = messages.en as Readonly<Record<string, string>>;
const ar = messages.ar as Readonly<Record<string, string>>;

const base: CheckInput = {
  contentType: 'POST',
  geometry: '1080 × 1350 · 4:5',
  caption: { characters: 121, limit: 2_200, ok: true },
  hashtags: { count: 4, max: 30, recommended: { min: 3, max: 5 }, ok: true },
  media: { kinds: ['IMAGE'], needs: null, ok: true },
  connection: 'connected',
  connectHref: '/en/integrations',
  t: en,
};
const values = (input: CheckInput) =>
  checkView(input).rows.map((row) => [row.key, row.state, row.value]);

describe('a ready post', () => {
  it('reads Size, Caption, Hashtags "n (3–5)" and Media "Image", all ✓, "Ready", no link', () => {
    const view = checkView(base);
    expect(values(base)).toEqual([
      ['size', 'ok', '1080 × 1350 · 4:5'],
      ['caption', 'ok', '121 / 2200'],
      ['tags', 'ok', '4 (3–5)'],
      ['media', 'ok', 'Image'],
    ]);
    expect(view.status).toEqual({ label: 'Ready', className: '' });
    expect(view.cta).toBeNull();
  });

  it('"!" outside the recommended range, below or above, and the status stays Ready', () => {
    for (const count of [1, 7]) {
      const input = { ...base, hashtags: { ...base.hashtags, count } };
      expect(values(input)[2]).toEqual(['tags', 'warn', `${count} (3–5)`]);
      expect(checkView(input).status).toEqual({ label: 'Ready', className: 'bsp-info' });
    }
  });

  it('media in words: "Video", "n slides"; without a configured range, "n / max"', () => {
    expect(values({ ...base, media: { ...base.media, kinds: ['VIDEO'] } })[3]![2]).toBe('Video');
    expect(
      values({
        ...base,
        contentType: 'CAROUSEL',
        media: { ...base.media, kinds: ['IMAGE', 'IMAGE', 'IMAGE'] },
      })[3]![2],
    ).toBe('3 slides');
    expect(values({ ...base, hashtags: { count: 2, max: 30, ok: true } })[2]).toEqual([
      'tags',
      'ok',
      '2 / 30',
    ]);
  });
});

describe('a post missing media', () => {
  it('"No picture yet" ✕ and "Needs a fix"', () => {
    const input = { ...base, media: { kinds: [], needs: 'picture' as const, ok: false } };
    expect(values(input)[3]).toEqual(['media', 'bad', 'No picture yet']);
    expect(checkView(input).status).toEqual({ label: 'Needs a fix', className: 'bsp-warn' });
  });

  it('"Needs a video" ✕, in Arabic too', () => {
    const input = {
      ...base,
      t: ar,
      media: { kinds: ['IMAGE'], needs: 'video' as const, ok: false },
    };
    expect(values(input)[3]).toEqual(['media', 'bad', 'يحتاج إلى فيديو']);
    expect(checkView(input).status.label).toBe('يحتاج إلى تعديل');
  });
});

describe('expired and not connected', () => {
  it('expired: "Expired" and "Reconnect {channel} →"', () => {
    const view = checkView({ ...base, connection: 'expired', expiredLabel: 'Expired' });
    expect(view.status).toEqual({ label: 'Expired', className: 'bsp-warn' });
    expect(view.cta).toBe('Reconnect {channel} →');
    expect(en['studio.expiredLine']).toBe('Connection expired · reconnect before it goes out');
  });

  it('not connected: "Not connected" and "Connect {channel} →"; no link without the page', () => {
    const view = checkView({ ...base, connection: 'notConnected' });
    expect(view.status).toEqual({ label: 'Not connected', className: 'bsp-bad' });
    expect(view.cta).toBe('Connect {channel} →');
    expect(checkView({ ...base, connection: 'notConnected', connectHref: null }).cta).toBeNull();
  });

  it('"Not connected" only where the channel can be connected — never in the beta', () => {
    for (const file of [
      'apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx',
    ]) {
      expect(read(file), file).toMatch(
        /connectable\.includes\([^)]*\)\s*&&\s*!connected\.includes/,
      );
    }
  });
});

describe('the subtitle stays the product’s own', () => {
  it('no post-publish live comparison runs, so the prototype’s claim is not made', () => {
    expect(en['studio.checksSub']).toContain('checked as you write');
    expect(en['studio.checksSub']).not.toMatch(/opens the live post/);
  });
});
