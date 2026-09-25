import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BYTES_PER_GB, gigabytesFor } from '@brandspace/entitlements';

/**
 * B-1 — the gigabytes a storage counter shows are the TOTAL's, rounded up
 * once. Per-file rounding made a 1 MB photo cost a whole gigabyte.
 */
describe('gigabytesFor (B-1)', () => {
  it('keeps the plan gigabyte the repository already sold', () => {
    expect(BYTES_PER_GB).toBe(1024 * 1024 * 1024);
  });

  it('is zero for nothing and one for a started gigabyte', () => {
    expect(gigabytesFor(0)).toBe(0);
    expect(gigabytesFor(1)).toBe(1);
    expect(gigabytesFor(BYTES_PER_GB)).toBe(1);
    expect(gigabytesFor(BYTES_PER_GB + 1)).toBe(2);
  });

  it('rounds the total once, not each file', () => {
    const fivePhotos = 5 * 1024 * 1024;
    expect(gigabytesFor(fivePhotos)).toBe(1);
    // Beyond what a 32-bit counter could hold, which is why it is BIGINT.
    expect(gigabytesFor(300n * BigInt(BYTES_PER_GB) - 1n)).toBe(300);
  });
});

describe('the storage migration backfills (B-1, B-8)', () => {
  it.each(['20260925120000_storage_bytes_meter', '20260925130000_storage_bytes_brand_sources'])(
    '%s divides by the same gigabyte the application uses',
    (migration) => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const sql = readFileSync(
        path.resolve(here, `../../packages/database/prisma/migrations/${migration}/migration.sql`),
        'utf8',
      );
      const divisors = [...sql.matchAll(/::numeric \/ (\d+)/g)].map((m) => Number(m[1]));
      expect(divisors.length).toBeGreaterThan(0);
      expect(new Set(divisors)).toEqual(new Set([BYTES_PER_GB]));
    },
  );
});

describe('asset version storage (B-1, versions)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

  it('gives every version attempt an object key no other attempt can share', async () => {
    const { assetObjectKey, assetVersionAttemptKey } =
      await import('../../packages/assets/src/storage-keys');
    const base = { workspaceId: 'w', brandId: null, assetId: 'a', versionNumber: 2 };
    const one = assetVersionAttemptKey({
      ...base,
      attemptId: '11111111-1111-4111-8111-111111111111',
    });
    const two = assetVersionAttemptKey({
      ...base,
      attemptId: '22222222-2222-4222-8222-222222222222',
    });
    expect(one).not.toBe(two);
    // Never the plain version key an earlier object may already live at.
    expect(one).not.toBe(assetObjectKey(base));
    expect(one.startsWith(`${assetObjectKey(base)}-`)).toBe(true);
    expect(() => assetVersionAttemptKey({ ...base, attemptId: '../escape' })).toThrow();
  });

  it('the dashboard charges versions to the same meter and records failed clean-ups', () => {
    const context = read('apps/dashboard/src/server/assets-context.ts');
    const versions = context.slice(context.indexOf('versions: async () =>'));
    const block = versions.slice(0, versions.indexOf('}),'));
    expect(block).toContain('usage: scoped.usage');
    expect(block).toContain('storageLimitGb: await storageLimitGb()');
    expect(block).toContain('onCompensationFailure: recordVersionCompensationFailure');
    // Recorded on its OWN transaction, so the rollback of the failed request
    // cannot take the record with it.
    const recorder = context.slice(
      context.indexOf('async function recordVersionCompensationFailure'),
    );
    expect(recorder).toContain('await inWorkspace(failure.workspaceId');
    expect(recorder).toContain("action: 'assets.version_compensation_failed'");
  });

  it('tells the loser of a version race to retry, in both languages', async () => {
    const { statusMessage } = await import('../../apps/dashboard/src/i18n/messages');
    expect(statusMessage('ASSET_VERSION_CONFLICT', 'en')).toBe(
      'This asset changed while your version was being uploaded. Please try again.',
    );
    expect(statusMessage('ASSET_VERSION_CONFLICT', 'ar')).toBe(
      'تم تحديث هذا الملف أثناء رفع النسخة. حاول مرة أخرى.',
    );
    const actions = read('apps/dashboard/src/app/[locale]/assets/actions.ts');
    expect(actions).toContain("error.publicDetails['reason'] === ASSET_CHANGED_REASON");
    expect(actions).toContain("return 'ASSET_VERSION_CONFLICT'");
  });
});
