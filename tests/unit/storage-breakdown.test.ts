import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  storageBreakdownView,
  type StorageBreakdownRow,
} from '@brandspace/entitlements';
import { formatBytes } from '../../apps/dashboard/src/components/format-bytes';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * C7 (Phase 2B-2b) — the storage breakdown and the library count, as rules.
 * The database half is `tests/isolation/storage-breakdown.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const rows: StorageBreakdownRow[] = [
  { category: 'ASSET', kind: 'IMAGE', source: 'UPLOAD', bytes: 1_000n },
  { category: 'ASSET', kind: 'IMAGE', source: 'AI_GENERATED', bytes: 500n },
  { category: 'ASSET', kind: 'FONT', source: 'UPLOAD', bytes: 0n },
  { category: 'BRAND_BRAIN', kind: null, source: null, bytes: 200n },
  { category: 'UPLOADING', kind: null, source: null, bytes: 100n },
];

describe('storageBreakdownView', () => {
  it('breaks the same rows down twice, hiding categories with no bytes', () => {
    const view = storageBreakdownView(rows, 1_800n);
    expect(view.byKind).toEqual([
      { key: 'IMAGE', bytes: 1_500n },
      { key: 'BRAND_BRAIN', bytes: 200n },
      { key: 'UPLOADING', bytes: 100n },
    ]);
    // IMPORTED is never written, so it never appears; neither does FONT at 0.
    expect(view.bySource).toEqual([
      { key: 'UPLOAD', bytes: 1_000n },
      { key: 'AI_GENERATED', bytes: 500n },
      { key: 'BRAND_BRAIN', bytes: 200n },
      { key: 'UPLOADING', bytes: 100n },
    ]);
    const sum = (lines: readonly { bytes: bigint }[]) =>
      lines.reduce((total, line) => total + line.bytes, 0n);
    expect(sum(view.byKind)).toBe(view.measured);
    expect(sum(view.bySource)).toBe(view.measured);
  });

  it('"Other" is the meter minus the breakdown', () => {
    expect(storageBreakdownView(rows, 2_000n)).toMatchObject({ other: 200n, drift: 0n });
  });

  it('when the breakdown exceeds the meter, "Other" is 0 — never negative — and the drift is reported', () => {
    expect(storageBreakdownView(rows, 1_500n)).toMatchObject({ other: 0n, drift: 300n });
  });
});

describe('the meter itself did not move', () => {
  const source = read('packages/entitlements/src/storage-recompute.ts');

  it('BYTES_PER_GB is still 1024³, and recompute is still a dry run unless asked', () => {
    expect(BYTES_PER_GB).toBe(1024 * 1024 * 1024);
    expect(source).toContain('if (!options.apply) return drifted;');
    expect(read('scripts/recompute-storage-usage.ts')).toContain(
      "const apply = process.argv.includes('--apply');",
    );
  });

  it('the meter and the breakdown read ONE definition of "stored"', () => {
    expect(source.match(/FROM \(\$\{STORED_OBJECTS\}\) t/g)).toHaveLength(2);
    // Still: one object counted once, only unpurged assets, PENDING uploads,
    // live Brand Brain documents — and no derivatives.
    expect(source).toContain('SELECT DISTINCT ON (av."assetId", av."storageKey")');
    expect(source).toContain(`WHERE a."storageKey" <> ''`);
    expect(source).toContain(`WHERE s."status" = 'PENDING'`);
    expect(source).toContain(`WHERE d."deletedAt" IS NULL`);
    expect(source).not.toMatch(/FROM "asset_derivative"/);
  });

  it('the breakdown is classified from persisted columns, never a name or a MIME type', () => {
    const definition = source.slice(
      source.indexOf('const STORED_OBJECTS'),
      source.indexOf('async function measureStoredBytes'),
    );
    expect(definition).toContain('a."kind", a."source"');
    expect(definition).not.toMatch(/mimeType|fileName|"name"|storageKey" LIKE/);
  });
});

describe('the screens', () => {
  it('bytes read the same way on both screens, in binary units', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(BYTES_PER_GB * 3, 'en')).toBe('3 GB');
    expect(read('apps/dashboard/src/app/[locale]/assets/asset-library-view.tsx')).toContain(
      "import { formatBytes } from '../../../components/format-bytes';",
    );
  });

  it('"Latest" only for the newest-first first page', () => {
    const page = read('apps/dashboard/src/app/[locale]/assets/page.tsx');
    expect(page).toContain(
      "sort === 'createdAt' && !cursor ? 'assets.latestOf' : 'assets.shownOf'",
    );
    expect(page).toContain('withTotal: true,');
    expect(page).toContain('limit: 48,');
  });

  it('every new line exists in both languages', () => {
    for (const key of [
      'assets.latestOf',
      'assets.shownOf',
      'plan.storageBreakdownTitle',
      'plan.storageByKind',
      'plan.storageBySource',
      'plan.storageBrandBrain',
      'plan.storageUploading',
      'plan.storageOther',
    ]) {
      for (const locale of ['en', 'ar'] as const) {
        expect((messages[locale] as Record<string, string>)[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
