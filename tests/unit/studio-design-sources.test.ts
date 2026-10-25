import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { drawerDescriptionKey } from '../../apps/dashboard/src/server/composer-editor';

/**
 * D-569 (Studio review, owner decisions 3 and 4) — THE DESIGN TAB'S WAYS IN,
 * AND A DRAWER THAT NEVER PROMISES WHAT IT HIDES.
 *
 *   3. On a post with no media yet, the prototype's cards (`Main.dc.html:
 *      2281-2287`) open the "Add media" drawer on their tab: From Media (with
 *      the count), Upload, Generate with AI (with the credit quote; not drawn
 *      where image generation is unavailable). Brand template stays out
 *      (D-473). The media list and "Add media" stay (D-285).
 *   4. The drawer's subtitle never mentions generating when Generate is hidden.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const COMPOSE = 'apps/dashboard/src/app/[locale]/content/compose';
const en = messages.en as Readonly<Record<string, string>>;
const ar = messages.ar as Readonly<Record<string, string>>;

describe('the drawer’s subtitle (decision 4)', () => {
  it('names generating only when Generate is offered, and uploading only when Upload is', () => {
    expect(drawerDescriptionKey({ canUpload: true, canGenerate: true })).toBe(
      'editor.media.drawerBody',
    );
    expect(drawerDescriptionKey({ canUpload: true, canGenerate: false })).toBe(
      'editor.media.drawerBodyNoGenerate',
    );
    expect(drawerDescriptionKey({ canUpload: false, canGenerate: true })).toBe(
      'editor.media.drawerBodyNoUpload',
    );
    expect(drawerDescriptionKey({ canUpload: false, canGenerate: false })).toBe(
      'editor.media.drawerBodyLibrary',
    );
  });

  it('the words without Generate say nothing about generating, en and ar', () => {
    for (const key of ['editor.media.drawerBodyNoGenerate', 'editor.media.drawerBodyLibrary']) {
      expect(en[key], key).not.toMatch(/generat/i);
      expect(ar[key], key).not.toMatch(/تُولَّد|توليد|أنشئ/);
    }
    expect(en['editor.media.drawerBodyNoGenerate']).toBe('From your library or a new upload.');
  });

  it('the drawer reads its subtitle from that rule', () => {
    expect(read(`${COMPOSE}/media-drawer.tsx`)).toMatch(
      /description=\{[\s\S]{0,120}drawerDescriptionKey\(/,
    );
  });
});

describe('the Design tab’s cards (decision 3)', () => {
  const sources = read(`${COMPOSE}/media-sources.tsx`);
  const editor = read(`${COMPOSE}/draft-editor.tsx`);

  it('From Media with the count, Upload, Generate with its quote — and no Brand template', () => {
    expect(en['studio.source.library']).toBe('From Media');
    expect(en['studio.source.librarySub']).toBe('{count} photos and videos');
    expect(en['studio.source.upload']).toBe('Upload');
    expect(en['studio.source.uploadSub']).toBe('From your device');
    expect(en['studio.source.generate']).toBe('Generate with AI');
    expect(en['studio.source.generateQuote']).toBe('About {credits} credits per image');
    expect(sources).toContain("fetch('/api/creative/quote'");
    expect(sources).not.toMatch(/'template'/);
    expect(Object.keys(en).some((key) => key.startsWith('studio.source.template'))).toBe(false);
  });

  it('Generate is drawn only where image generation is available; Upload only with the permission', () => {
    expect(sources).toMatch(/\.\.\.\(canGenerate\s*\?/);
    expect(sources).toMatch(/\.\.\.\(canUpload\s*\?/);
    expect(editor).toMatch(
      /<MediaSources[\s\S]{0,300}canGenerate=\{canGenerateMedia && creativeFormats\.length > 0\}/,
    );
  });

  it('shown only while the post has no media, opening the drawer on the card’s tab', () => {
    expect(editor).toMatch(/value\.assetIds\.length === 0 && can\.edit \? \(\s*<MediaSources/);
    expect(editor).toMatch(
      /setDrawer\(\{ variantId: variant\.id, replace: null, tab: sourceTab \}\)/,
    );
    // The media list and its "Add media" stay (D-285).
    expect(editor).toMatch(/<MediaSources[\s\S]*?<MediaSlides/);
  });

  it('Arabic copy exists and differs from English', () => {
    for (const key of [
      'studio.source.library',
      'studio.source.librarySub',
      'studio.source.uploadSub',
      'studio.source.generate',
      'studio.source.generateQuote',
    ]) {
      expect(ar[key], key).toBeTruthy();
      expect(ar[key], key).not.toBe(en[key]);
    }
  });
});
