import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultPayload } from '@brandspace/config';
import {
  assetPolicyFrom,
  avatarObjectKey,
  checkPicture,
  EICAR_TEST_STRING,
  MockVirusScanner,
  pictureContentType,
  SCAN_FAILURE_PROBE,
  workspaceLogoObjectKey,
  type VirusScanner,
} from '@brandspace/assets';

/**
 * PR D (D-609) — AVATARS AND THE WORKSPACE LOGO: the image rules of the asset
 * library and its scanner, and object keys the database's CHECK accepts.
 */

const policy = assetPolicyFrom(defaultPayload('assets'));
const scanner = new MockVirusScanner();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
const withText = (head: Uint8Array, text: string) =>
  new Uint8Array([...head, ...new TextEncoder().encode(text)]);

describe('PR D · a picture', () => {
  it('accepts a PNG and a JPEG whose bytes say what they are', async () => {
    expect(
      await checkPicture({ bytes: PNG, declaredMimeType: 'image/png', policy, scanner }),
    ).toEqual({ ok: true, contentType: 'image/png', extension: 'png' });
    expect(
      await checkPicture({ bytes: JPEG, declaredMimeType: 'image/jpeg', policy, scanner }),
    ).toEqual({ ok: true, contentType: 'image/jpeg', extension: 'jpeg' });
  });

  it('refuses SVG, a type it was not told, and bytes that are not the claimed type', async () => {
    for (const [bytes, type] of [
      [SVG, 'image/svg+xml'],
      [PNG, 'image/gif'],
      [PNG, 'application/pdf'],
      [JPEG, 'image/png'],
      [SVG, 'image/png'],
    ] as const) {
      expect(await checkPicture({ bytes, declaredMimeType: type, policy, scanner })).toEqual({
        ok: false,
        reason: 'picture-type',
      });
    }
  });

  it('refuses an empty file, and one past the configured image ceiling', async () => {
    expect(
      await checkPicture({
        bytes: new Uint8Array(),
        declaredMimeType: 'image/png',
        policy,
        scanner,
      }),
    ).toEqual({ ok: false, reason: 'picture-missing' });
    const tight = {
      ...policy,
      upload: { ...policy.upload, maxFileBytes: { ...policy.upload.maxFileBytes, image: 8 } },
    };
    expect(
      await checkPicture({ bytes: PNG, declaredMimeType: 'image/png', policy: tight, scanner }),
    ).toEqual({ ok: false, reason: 'picture-too-large' });
  });

  it('refuses what the scanner flags, and what it could not judge', async () => {
    expect(
      await checkPicture({
        bytes: withText(PNG, EICAR_TEST_STRING),
        declaredMimeType: 'image/png',
        policy,
        scanner,
      }),
    ).toEqual({ ok: false, reason: 'picture-unsafe' });
    expect(
      await checkPicture({
        bytes: withText(PNG, SCAN_FAILURE_PROBE),
        declaredMimeType: 'image/png',
        policy,
        scanner,
      }),
    ).toEqual({ ok: false, reason: 'picture-scan-failed' });
    const throwing: VirusScanner = {
      key: 'throws',
      scan: async () => {
        throw new Error('unreachable');
      },
    };
    expect(
      await checkPicture({ bytes: PNG, declaredMimeType: 'image/png', policy, scanner: throwing }),
    ).toEqual({ ok: false, reason: 'picture-scan-failed' });
  });

  it('builds keys the migration’s CHECK constraints accept, and reads their type back', () => {
    const sql = readFileSync(
      'packages/database/prisma/migrations/20261114120000_personal_notes_avatars_workspace_logo/migration.sql',
      'utf8',
    );
    const pattern = (name: string) =>
      new RegExp(sql.match(new RegExp(`"${name}" ~ '([^']+)'`))![1]!);
    const id = '6f1c2b3a-0d4e-4f5a-9b8c-7d6e5f4a3b2c';
    for (const ext of ['png', 'jpeg', 'webp']) {
      expect(avatarObjectKey(id, ext)).toMatch(pattern('avatarKey'));
      expect(workspaceLogoObjectKey(id, ext)).toMatch(pattern('logoKey'));
    }
    expect(pictureContentType(avatarObjectKey(id, 'webp'))).toBe('image/webp');
    expect(pictureContentType('avatars/x/y.svg')).toBeNull();
  });
});
