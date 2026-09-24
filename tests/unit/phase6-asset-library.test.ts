import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  ASSET_VIEWS,
  RIGHTS_WARNING_DAYS,
  rightsState,
  viewKinds,
} from '../../apps/dashboard/src/server/asset-views';

/**
 * PHASE 6 FINAL · D-277 §30, D-286, D-287 — THE ASSET LIBRARY.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const day = 86_400_000;
const now = new Date('2030-01-01T00:00:00.000Z');

describe('D-286 — rights states', () => {
  it('no date, far off, close, and over', () => {
    expect(rightsState(null, now)).toBe('none');
    expect(rightsState(new Date(now.getTime() + 90 * day), now)).toBe('ok');
    expect(rightsState(new Date(now.getTime() + (RIGHTS_WARNING_DAYS - 1) * day), now)).toBe(
      'expiring',
    );
    expect(rightsState(now, now)).toBe('expired');
  });

  it('the publishability predicate — not the screen — is what refuses a lapsed file', () => {
    const predicate = read('packages/assets/src/publishable.ts');
    expect(predicate).toMatch(/rightsExpiryAt: null \}, \{ rightsExpiryAt: \{ gt: input\.now \}/);
  });
});

describe('D-287 — views are filters, and are called views', () => {
  it('each view names real kinds or columns', () => {
    expect(viewKinds('images')).toEqual({ kinds: ['IMAGE'] });
    expect(viewKinds('videos')).toEqual({ kinds: ['VIDEO'] });
    expect(viewKinds('recent')).toEqual({});
  });

  it('every view reads in both languages, and nothing is called a collection', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      expect(dictionary['assets.views.label']).toBeTruthy();
      for (const view of ASSET_VIEWS) {
        expect(dictionary[`assets.view.${view}`], `${locale} ${view}`).toBeTruthy();
      }
    }
    expect(messages.en['assets.views.label']).not.toMatch(/collection/i);
  });

  it('"Used in" comes from real references, through the service', () => {
    const library = read('packages/assets/src/library.ts');
    expect(library).toMatch(/assetIds: \{ has: asset\.id \}/);
    expect(library).toMatch(/coverAssetId: asset\.id/);
    expect(library).toMatch(/v\."workspaceId" = \$\{this\.#workspaceId\}::uuid/);
  });

  it('bulk actions reuse the single-file service calls', () => {
    const actions = read('apps/dashboard/src/app/[locale]/assets/actions.ts');
    expect(actions).toMatch(/service\.archive\(assetId, actor\)/);
    expect(actions).toMatch(/service\.updateMetadata\(\{ assetId, actor, folderId/);
  });
});
