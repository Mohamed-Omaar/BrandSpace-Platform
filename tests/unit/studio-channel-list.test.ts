import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listOf } from '../../apps/dashboard/src/app/[locale]/content/compose/format-fit';

/**
 * D-569 (Studio review, owner decision 5) — ARABIC CHANNEL LISTS. Latin
 * channel names are joined with the Arabic «و», each name isolated
 * (U+2068 … U+2069) so it reads «Facebook وInstagram وTikTok» wherever the list
 * lands; English is unchanged. Every list of channel names the dashboard
 * builds goes through this one helper.
 */

const FSI = '⁨';
const PDI = '⁩';
const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('listOf — channel names in the reader’s language', () => {
  it('Arabic: «و» joins, and every Latin name is isolated', () => {
    expect(listOf('ar', ['Facebook', 'Instagram', 'TikTok'])).toBe(
      `${FSI}Facebook${PDI} و${FSI}Instagram${PDI} و${FSI}TikTok${PDI}`,
    );
    expect(listOf('ar', ['TikTok', 'Facebook'])).toBe(`${FSI}TikTok${PDI} و${FSI}Facebook${PDI}`);
    expect(listOf('ar', ['Instagram'])).toBe(`${FSI}Instagram${PDI}`);
  });

  it('read without the marks it is exactly «Facebook وInstagram وTikTok»', () => {
    expect(listOf('ar', ['Facebook', 'Instagram', 'TikTok']).replace(/[⁨⁩]/g, '')).toBe(
      'Facebook وInstagram وTikTok',
    );
  });

  it('English is unchanged: no marks', () => {
    expect(listOf('en', ['TikTok', 'Facebook'])).toBe('TikTok and Facebook');
    expect(listOf('en', ['Facebook', 'Instagram', 'TikTok'])).toBe(
      'Facebook, Instagram, and TikTok',
    );
  });

  it('the Studio, the library and Performance build their channel lists with it', () => {
    for (const file of [
      'apps/dashboard/src/app/[locale]/content/compose/channel-access-line.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx',
      'apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx',
      'apps/dashboard/src/app/[locale]/content/content-library.tsx',
      'apps/dashboard/src/app/[locale]/analytics/page.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toMatch(/listOf\(\s*locale/);
      expect(source, file).not.toMatch(/map\((channelLabel|platformLabel)\)\.join\(/);
    }
  });
});
