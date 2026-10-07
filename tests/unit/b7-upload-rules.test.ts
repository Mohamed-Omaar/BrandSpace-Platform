import { describe, expect, it } from 'vitest';
import {
  acceptOf,
  bytesText,
  formatListOf,
  refusalOf,
  ruleGroupsOf,
  rulesText,
  type UploadRules,
} from '../../apps/dashboard/src/components/upload-rules';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * BATCH 7 (A3/A4) — AN UPLOAD IS NEVER SILENT. The rules a file control shows
 * and checks before a file is sent: the formats and the size the server
 * admits, read from configuration by the page.
 */
const MB = 1024 * 1024;
const images: UploadRules = {
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxBytes: 10 * MB,
};
const media: UploadRules = {
  mimeTypes: ['image/png', 'video/mp4'],
  maxBytes: 10 * MB,
  maxBytesByType: { 'video/mp4': 200 * MB },
};
const documents: UploadRules = {
  mimeTypes: ['application/pdf', 'text/markdown', 'text/plain'],
  maxBytes: 20 * MB,
};

const file = (name: string, type: string, size: number) => ({ name, type, size });

describe('refusalOf — judged the moment a file is chosen', () => {
  it('admits an allowed type within its size', () => {
    expect(refusalOf(file('logo.png', 'image/png', 2 * MB), images)).toBeNull();
  });

  it('refuses a type the server does not admit (an SVG logo, an HTML page)', () => {
    expect(refusalOf(file('logo.svg', 'image/svg+xml', 1000), images)).toBe('type');
    expect(refusalOf(file('site.html', 'text/html', 1000), documents)).toBe('type');
  });

  it('takes the extension when the browser types a file vaguely', () => {
    expect(refusalOf(file('notes.md', '', 1000), documents)).toBeNull();
    expect(refusalOf(file('notes.md', 'application/octet-stream', 1000), documents)).toBeNull();
    expect(refusalOf(file('page.html', '', 1000), documents)).toBe('type');
  });

  it('refuses a file over the ceiling of ITS type', () => {
    expect(refusalOf(file('big.png', 'image/png', 11 * MB), images)).toBe('size');
    expect(refusalOf(file('clip.mp4', 'video/mp4', 150 * MB), media)).toBeNull();
    expect(refusalOf(file('still.png', 'image/png', 150 * MB), media)).toBe('size');
  });

  it('refuses an empty file', () => {
    expect(refusalOf(file('logo.png', 'image/png', 0), images)).toBe('empty');
  });
});

describe('what the control writes beside itself', () => {
  it('limits the picker to the admitted types and their extensions', () => {
    expect(acceptOf(images)).toBe('image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp');
  });

  it('names the formats in the reader’s language', () => {
    expect(formatListOf(images, 'en')).toBe('PNG, JPG, or WEBP');
    expect(formatListOf(images, 'ar')).toContain('PNG');
    expect(formatListOf(images, 'ar')).toContain('أو');
  });

  it('writes sizes as a reader says them', () => {
    expect(bytesText(10 * MB, 'en')).toBe('10 MB');
    expect(bytesText(512 * 1024, 'en')).toBe('512 kB');
    expect(bytesText(1.5 * MB, 'en')).toBe('1.5 MB');
  });

  it('groups types that share a ceiling, one sentence per group', () => {
    expect(ruleGroupsOf(media)).toEqual([
      { types: ['image/png'], maxBytes: 10 * MB },
      { types: ['video/mp4'], maxBytes: 200 * MB },
    ]);
    const texts = { rules: messages.en['upload.rules'] };
    expect(rulesText(images, 'en', texts)).toBe(
      messages.en['upload.rules']
        .replace('{formats}', 'PNG, JPG, or WEBP')
        .replace('{size}', '10 MB'),
    );
    expect(rulesText(media, 'en', texts).split('; ')).toHaveLength(2);
  });

  it('every upload word exists in both languages with the same placeholders', () => {
    const keys = [
      'upload.rules',
      'upload.refusedType',
      'upload.refusedSize',
      'upload.refusedEmpty',
      'upload.uploading',
      'upload.connection',
    ] as const;
    for (const key of keys) {
      const en = messages.en[key];
      const ar = messages.ar[key];
      expect(en, key).toBeTruthy();
      expect(ar, key).toBeTruthy();
      expect((ar.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((en.match(/\{\w+\}/g) ?? []).sort());
    }
  });
});
