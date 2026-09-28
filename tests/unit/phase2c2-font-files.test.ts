import { describe, expect, it } from 'vitest';
import {
  assetPolicyFrom,
  checkAssetSignature,
  checkUploadedFile,
  kindForMimeType,
  maxBytesForKind,
  resolveFontType,
} from '@brandspace/assets';
import { defaultPayload } from '@brandspace/config';
import { detectFormat } from '@brandspace/shared';

/**
 * PHASE 2C-2, ITEM 3 — uploaded fonts are recognised by their BYTES.
 *
 * TTF (00 01 00 00 or "true"), OTF ("OTTO"), WOFF ("wOFF") and WOFF2 ("wOF2")
 * are accepted; a font collection ("ttcf") is refused by name; the extension
 * must name the same format; and a client header can never overrule the bytes.
 */

const withMagic = (magic: readonly number[]) =>
  new Uint8Array([...magic, ...Array.from({ length: 60 }, (_, i) => (i * 7) % 251)]);

const TTF = withMagic([0x00, 0x01, 0x00, 0x00]);
const TTF_TRUE = withMagic([0x74, 0x72, 0x75, 0x65]);
const OTF = withMagic([0x4f, 0x54, 0x54, 0x4f]);
const WOFF = withMagic([0x77, 0x4f, 0x46, 0x46]);
const WOFF2 = withMagic([0x77, 0x4f, 0x46, 0x32]);
const TTC = withMagic([0x74, 0x74, 0x63, 0x66]);
const PNG = withMagic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('the signatures', () => {
  it('detects each font format from its own magic bytes', () => {
    expect(detectFormat(TTF)).toBe('ttf');
    expect(detectFormat(TTF_TRUE)).toBe('ttf');
    expect(detectFormat(OTF)).toBe('otf');
    expect(detectFormat(WOFF)).toBe('woff');
    expect(detectFormat(WOFF2)).toBe('woff2');
    expect(detectFormat(TTC)).toBe('ttc');
  });

  it('each font type accepts only its own bytes, and nothing accepts a collection', () => {
    expect(checkAssetSignature('font/ttf', TTF).ok).toBe(true);
    expect(checkAssetSignature('font/ttf', TTF_TRUE).ok).toBe(true);
    expect(checkAssetSignature('font/otf', OTF).ok).toBe(true);
    expect(checkAssetSignature('font/woff', WOFF).ok).toBe(true);
    expect(checkAssetSignature('font/woff2', WOFF2).ok).toBe(true);
    expect(checkAssetSignature('font/ttf', OTF).ok).toBe(false);
    expect(checkAssetSignature('font/woff', WOFF2).ok).toBe(false);
    for (const type of ['font/ttf', 'font/otf', 'font/woff', 'font/woff2']) {
      expect(checkAssetSignature(type, TTC).ok, type).toBe(false);
    }
  });
});

describe('the type comes from the bytes; the name must agree; the header cannot overrule', () => {
  const resolve = (fileName: string, declaredMimeType: string, bytes: Uint8Array) =>
    resolveFontType({ fileName, declaredMimeType, bytes });

  it('a missing or generic browser type is decided by the signature', () => {
    expect(resolve('Brand.ttf', '', TTF)).toEqual({ font: true, ok: true, mimeType: 'font/ttf' });
    expect(resolve('Brand.otf', 'application/octet-stream', OTF)).toEqual({
      font: true,
      ok: true,
      mimeType: 'font/otf',
    });
    expect(resolve('Brand.woff', 'application/font-woff', WOFF)).toEqual({
      font: true,
      ok: true,
      mimeType: 'font/woff',
    });
    expect(resolve('Brand.WOFF2', 'font/woff2', WOFF2)).toEqual({
      font: true,
      ok: true,
      mimeType: 'font/woff2',
    });
  });

  it('a font collection is refused whatever it is called or declared', () => {
    expect(resolve('Brand.ttc', '', TTC)).toMatchObject({ ok: false, reason: 'font_collection' });
    expect(resolve('Brand.ttf', 'font/ttf', TTC)).toMatchObject({
      ok: false,
      reason: 'font_collection',
    });
  });

  it('an extension that names another format is refused', () => {
    expect(resolve('Brand.woff2', '', TTF)).toMatchObject({
      ok: false,
      reason: 'extension_mismatch',
    });
    expect(resolve('Brand', '', OTF)).toMatchObject({ ok: false, reason: 'extension_mismatch' });
  });

  it('a client header naming a different type never overrides the bytes', () => {
    expect(resolve('Brand.ttf', 'font/woff2', TTF)).toMatchObject({
      ok: false,
      reason: 'content_type_mismatch',
    });
    expect(resolve('Brand.ttf', 'image/png', TTF)).toMatchObject({
      ok: false,
      reason: 'content_type_mismatch',
    });
    // A .ttf that is really a PNG is not a font.
    expect(resolve('Brand.ttf', 'font/ttf', PNG)).toMatchObject({
      ok: false,
      reason: 'content_type_mismatch',
    });
  });

  it('a file that is not a font by bytes, name or header keeps the normal path', () => {
    expect(resolve('photo.png', 'image/png', PNG)).toEqual({ font: false });
  });

  it('`complete` refuses a font whose stored name disagrees with its type', () => {
    expect(
      checkUploadedFile({ declaredMimeType: 'font/ttf', fileName: 'Brand.ttf', bytes: TTF }).ok,
    ).toBe(true);
    expect(
      checkUploadedFile({ declaredMimeType: 'font/ttf', fileName: 'Brand.otf', bytes: TTF }).ok,
    ).toBe(false);
    expect(
      checkUploadedFile({ declaredMimeType: 'font/otf', fileName: 'Brand.otf', bytes: TTF }).ok,
    ).toBe(false);
  });
});

describe('the configuration', () => {
  const policy = assetPolicyFrom(defaultPayload('assets'));

  it('admits TTF, OTF, WOFF and WOFF2 as FONT', () => {
    for (const type of ['font/ttf', 'font/otf', 'font/woff', 'font/woff2']) {
      expect(kindForMimeType(policy.upload, type), type).toBe('FONT');
    }
  });

  it('caps a font at exactly 5 MiB — 5 × 1024 × 1024 bytes, not 5,000,000', () => {
    expect(maxBytesForKind(policy.upload, 'FONT')).toBe(5 * 1024 * 1024);
    expect(maxBytesForKind(policy.upload, 'FONT')).toBe(5_242_880);
  });

  it('leaves every other kind’s ceiling where it was', () => {
    expect(maxBytesForKind(policy.upload, 'IMAGE')).toBe(25 * 1024 * 1024);
    expect(maxBytesForKind(policy.upload, 'VIDEO')).toBe(500 * 1024 * 1024);
    expect(maxBytesForKind(policy.upload, 'AUDIO')).toBe(100 * 1024 * 1024);
    expect(maxBytesForKind(policy.upload, 'DOCUMENT')).toBe(50 * 1024 * 1024);
  });
});
